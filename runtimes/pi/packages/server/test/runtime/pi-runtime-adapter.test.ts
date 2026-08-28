/**
 * TASK-017: PiRuntimeAdapter 单元测试（spec 10.1 / TASK-017 完成条件）。
 *
 * 用 fake 会话工厂验证：两个 Conversation 创建独立 Runtime；模型来自各自
 * RuntimeSpec；chat-only 白名单拒绝非 chat-only profile / 工具 / 知识库；
 * close 幂等；prompt 转发。不依赖数据库与 pi-coding-agent。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type {
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import { createPiRuntimeAdapter, type RuntimeSessionOptions } from "../../src/runtime/pi-runtime-adapter.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

class FakeSession implements PiSessionRuntime {
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly sessionIdValue: string;
	readonly model: ModelRef;
	prompted: string[] = [];
	disposed = 0;
	aborted = 0;
	constructor(id: string, model: ModelRef) {
		this.sessionIdValue = id;
		this.model = model;
	}

	snapshot(): SessionSnapshot {
		return {
			id: this.sessionIdValue,
			cwd: "/tmp",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			phase: "idle",
			model: this.model,
			thinkingLevel: "off",
			attached: true,
			locked: true,
			lastSequence: 0,
			revision: 0,
			transcript: [],
			queuedSteer: [],
			queuedSteerCount: 0,
		};
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(input: PromptInput): Promise<void> {
		this.prompted.push(input.text);
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {
		this.aborted += 1;
	}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async dispose(): Promise<void> {
		this.disposed += 1;
	}
}

function chatOnlySpec(overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
	return {
		schemaVersion: 1,
		publishedAppVersionId: "pav-test",
		agent: {
			systemPrompt: "You are a helpful assistant.",
			model: { provider: "skdy", modelId: "pi-chat", params: { thinkingLevel: "medium" } },
		},
		capabilities: {
			tools: [],
			knowledgeBases: [],
			skills: [],
			mcpServers: [],
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: false },
			avatar: { enabled: false },
			conversations: { allowNew: true },
		},
		contextPolicy: { maxTurns: 100, maxContextTokens: 100000, toolResultMaxBytes: 65536, logLevel: "standard" },
		runtimePolicy: {
			profile: "chat-only",
			turnTimeoutMs: 120000,
			idleTtlMs: 1200000,
			maxConcurrentTurnsPerConversation: 1,
		},
		theme: {},
		securityPolicyVersion: "sp_001",
		...overrides,
	};
}

function scope(conversationId: string): ScopeContext {
	return {
		tenantId: "ten-test" as TenantId,
		publishedAppId: "app-test" as PublishedAppId,
		publishedAppVersionId: "pav-test" as PublishedAppVersionId,
		principalId: "prn-test" as PrincipalId,
		conversationId: conversationId as ConversationId,
		limits: {
			maxTurns: 100,
			maxContextTokens: 100000,
			toolResultMaxBytes: 65536,
			turnTimeoutMs: 120000,
			maxConcurrentTurnsPerConversation: 1,
		},
	};
}

describe("pi runtime adapter", () => {
	test("passes the frozen prompt and materialized Skills when opening a session", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const materializeCalls: { spec: RuntimeSpec; tenantId: string }[] = [];
		const skill = {
			name: "analyze",
			description: "Analyze data.",
			filePath: "/runtime-skills/pav/analyze/SKILL.md",
			baseDir: "/runtime-skills/pav/analyze",
			disableModelInvocation: false,
		};
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
			skillMaterializer: {
				materializeSkills: async () => [],
				materialize: async (spec, materializeScope) => {
					materializeCalls.push({ spec, tenantId: materializeScope!.tenantId });
					return [skill];
				},
			},
		});
		const spec = chatOnlySpec();

		const result = await adapter.open(spec, scope("conv-skills"));

		expect(result.ok).toBe(true);
		expect(materializeCalls).toEqual([{ spec, tenantId: "ten-test" }]);
		expect(calls[0]).toMatchObject({ systemPrompt: "You are a helpful assistant.", skills: [skill] });
	});

	test("opens a runtime and maps model from the RuntimeSpec", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const spec = chatOnlySpec();
		const result = await adapter.open(spec, scope("conv-0001"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("conv-0001");
		expect(calls[0]!.model).toEqual({ provider: "skdy", id: "pi-chat" });
		expect(calls[0]!.thinkingLevel).toBe("medium");
		expect(calls[0]!.streamOptions).toEqual({});
		expect(result.runtime.scope.conversationId).toBe("conv-0001");
		expect(result.runtime.spec).toBe(spec);
		await result.runtime.close();
	});

	test("passes frozen model parameters to every runtime session", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const spec = chatOnlySpec({
			agent: {
				systemPrompt: "published",
				model: {
					provider: "qwen",
					modelId: "Qwen3.8-Agent",
					params: {
						reasoning: { enabled: true, effort: "high" },
					},
				},
			},
		});
		const result = await adapter.open(spec, scope("conv-params"));
		expect(result.ok).toBe(true);
		// Runtime keeps the product tier; the selected model maps high to its provider value later.
		expect(calls[0]?.thinkingLevel).toBe("high");
		expect(calls[0]?.streamOptions?.temperature).toBe(1);
		expect(calls[0]?.streamOptions?.samplingParams).toMatchObject({
			top_p: 0.95,
			top_k: 20,
		});
	});

	test("wire-intent precedence: default fallback yields no override, revision config forces it", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		// ① 无参数 → 不注入覆盖（thinkingLevel 未定义，交给 provider 默认）。
		const a = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "default",
					model: { provider: "generic", modelId: "generic-reasoner", params: {} },
				},
			}),
			scope("conv-default"),
		);
		// ② Revision 显式 reasoning.effort:high → 会话 seam 收到 thinkingLevel high。
		const b = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "revision",
					model: {
						provider: "generic",
						modelId: "generic-reasoner",
						params: { reasoning: { effort: "high" } },
					},
				},
			}),
			scope("conv-revision"),
		);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(calls).toHaveLength(2);
		expect(calls[0]!.thinkingLevel).toBeUndefined();
		expect(calls[1]!.thinkingLevel).toBe("high");
		// 会话语义：模型默认值仅在无 Revision 参数时生效；显式 Revision 覆盖之。
		await a.runtime.close();
		await b.runtime.close();
	});

	test("session effort override beats Revision config at the session seam", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		// ① conversationEffort null → 无覆盖，Revision 配置 high 原样生效。
		const noOverride = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "revision high",
					model: {
						provider: "generic",
						modelId: "generic-reasoner",
						params: { reasoning: { effort: "high" } },
					},
				},
			}),
			{ ...scope("conv-no-override"), conversationEffort: null },
		);
		// ② conversationEffort low → 压过 Revision 的 high。会话覆盖 > Revision 配置。
		const withOverride = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "revision high",
					model: {
						provider: "generic",
						modelId: "generic-reasoner",
						params: { reasoning: { effort: "high" } },
					},
				},
			}),
			{ ...scope("conv-override"), conversationEffort: "low" },
		);
		expect(noOverride.ok).toBe(true);
		expect(withOverride.ok).toBe(true);
		if (!noOverride.ok || !withOverride.ok) return;
		expect(calls[0]!.thinkingLevel).toBe("high");
		expect(calls[1]!.thinkingLevel).toBe("low");
		await noOverride.runtime.close();
		await withOverride.runtime.close();
	});

	test("session effort applies over the default when Revision carries no effort", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const a = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "default",
					model: { provider: "generic", modelId: "generic-reasoner", params: {} },
				},
			}),
			{ ...scope("conv-session-default"), conversationEffort: "medium" },
		);
		expect(a.ok).toBe(true);
		if (!a.ok) return;
		expect(calls[0]!.thinkingLevel).toBe("medium");
		await a.runtime.close();
	});

	test("uses the frozen capability default for a reasoning model that cannot disable thinking", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const result = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "published Qwen",
					model: {
						provider: "oneapi",
						modelId: "Qwen",
						params: {},
						parameterCapabilities: {
							reasoning: {
								supported: true,
								toggle: false,
								efforts: ["low", "medium", "high"],
							},
						},
					},
				},
			}),
			scope("conv-published-qwen"),
		);
		expect(result.ok).toBe(true);
		expect(calls[0]?.thinkingLevel).toBe("low");
		if (result.ok) await result.runtime.close();
	});

	test("prefers a frozen capability defaultEffort over the first supported effort", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const result = await adapter.open(
			chatOnlySpec({
				agent: {
					systemPrompt: "published default",
					model: {
						provider: "oneapi",
						modelId: "Qwen",
						params: {},
						parameterCapabilities: {
							reasoning: {
								supported: true,
								toggle: false,
								efforts: ["low", "medium", "high"],
								defaultEffort: "high",
							},
						},
					},
				},
			}),
			scope("conv-published-default"),
		);
		expect(result.ok).toBe(true);
		expect(calls[0]?.thinkingLevel).toBe("high");
		if (result.ok) await result.runtime.close();
	});

	test("two conversations get independent runtimes with their own models", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const specA = chatOnlySpec({ agent: { systemPrompt: "a", model: { provider: "skdy", modelId: "pi-chat" } } });
		const specB = chatOnlySpec({ agent: { systemPrompt: "b", model: { provider: "other", modelId: "pi-mini" } } });
		const a = await adapter.open(specA, scope("conv-a"));
		const b = await adapter.open(specB, scope("conv-b"));
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(calls).toHaveLength(2);
		expect(calls[0]!.id).toBe("conv-a");
		expect(calls[1]!.id).toBe("conv-b");
		expect(calls[0]!.id).not.toBe(calls[1]!.id);
		expect(calls[0]!.model).toEqual({ provider: "skdy", id: "pi-chat" });
		expect(calls[1]!.model).toEqual({ provider: "other", id: "pi-mini" });
		// prompt 只到达各自的 runtime。
		await a.runtime.prompt("hello a");
		await b.runtime.prompt("hello b");
		const sessionA = a.runtime.sessionId;
		const sessionB = b.runtime.sessionId;
		expect(sessionA).not.toBe(sessionB);
		await a.runtime.close();
		await b.runtime.close();
	});

	test("builds frozen MCP tools for the conversation and passes them to the session", async () => {
		const calls: RuntimeSessionOptions[] = [];
		const scopes: ScopeContext[] = [];
		const adapter = createPiRuntimeAdapter({
			createMcpTools: async (_spec, runtimeScope) => {
				scopes.push(runtimeScope);
				return [
					{
						name: "crm_lookup",
						label: "CRM lookup",
						description: "Lookup a customer",
						parameters: Type.Object({ customerId: Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				];
			},
			createSession: async (options) => {
				calls.push(options);
				return new FakeSession(options.id, options.model);
			},
		});
		const runtimeScope = scope("conv-mcp");
		const result = await adapter.open(chatOnlySpec(), runtimeScope);
		expect(result.ok).toBe(true);
		expect(scopes).toEqual([runtimeScope]);
		expect(calls[0]?.customTools?.map((tool) => tool.name)).toEqual(["crm_lookup"]);
		if (result.ok) await result.runtime.close();
	});

	test("rejects non-chat-only profiles", async () => {
		const adapter = createPiRuntimeAdapter({
			createSession: async () => new FakeSession("x", { provider: "p", id: "m" }),
		});
		const result = await adapter.open(
			chatOnlySpec({
				runtimePolicy: {
					profile: "chat-with-files",
					turnTimeoutMs: 120000,
					idleTtlMs: 1200000,
					maxConcurrentTurnsPerConversation: 1,
				},
			}),
			scope("conv-1"),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("chat-only");
	});

	test("rejects specs that enable tools or knowledge bases", async () => {
		const adapter = createPiRuntimeAdapter({
			createSession: async () => new FakeSession("x", { provider: "p", id: "m" }),
		});
		const withTools = await adapter.open(
			chatOnlySpec({
				capabilities: {
					tools: [{ id: "web.search" }],
					knowledgeBases: [],
					skills: [],
					mcpServers: [],
					uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
					speech: { enabled: false },
					avatar: { enabled: false },
					conversations: { allowNew: true },
				},
			}),
			scope("conv-1"),
		);
		expect(withTools.ok).toBe(false);
		const withKb = await adapter.open(
			chatOnlySpec({
				capabilities: {
					tools: [],
					knowledgeBases: [{ id: "kb-legal" }],
					skills: [],
					mcpServers: [],
					uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
					speech: { enabled: false },
					avatar: { enabled: false },
					conversations: { allowNew: true },
				},
			}),
			scope("conv-2"),
		);
		expect(withKb.ok).toBe(false);
	});

	test("close is idempotent and disposes the underlying session once", async () => {
		const sessions: FakeSession[] = [];
		const adapter = createPiRuntimeAdapter({
			createSession: async (options) => {
				const session = new FakeSession(options.id, options.model);
				sessions.push(session);
				return session;
			},
		});
		const result = await adapter.open(chatOnlySpec(), scope("conv-1"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const first = result.runtime.close();
		const second = result.runtime.close();
		expect(first).toBe(second);
		await first;
		expect(sessions[0]!.disposed).toBe(1);
		// 关闭后 prompt 被拒绝。
		await expect(result.runtime.prompt("nope")).rejects.toThrow(/closed/);
	});
});

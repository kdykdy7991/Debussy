/**
 * TASK-017: PiRuntimeAdapter 单元测试（spec 10.1 / TASK-017 完成条件）。
 *
 * 用 fake 会话工厂验证：两个 Conversation 创建独立 Runtime；模型来自各自
 * RuntimeSpec；chat-only 白名单拒绝非 chat-only profile / 工具 / 知识库；
 * close 幂等；prompt 转发。不依赖数据库与 pi-coding-agent。
 */

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
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: false },
			avatar: { enabled: false },
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
		expect(calls[0]?.thinkingLevel).toBe("xhigh");
		expect(calls[0]?.streamOptions?.temperature).toBe(1);
		expect(calls[0]?.streamOptions?.samplingParams).toMatchObject({
			top_p: 0.95,
			top_k: 20,
		});
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
					uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
					speech: { enabled: false },
					avatar: { enabled: false },
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
					uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
					speech: { enabled: false },
					avatar: { enabled: false },
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

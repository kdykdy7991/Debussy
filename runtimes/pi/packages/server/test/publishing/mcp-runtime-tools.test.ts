import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseIdOrThrow, toPublicId } from "../../src/publishing/domain/ids.ts";
import { mcpResourceToolName } from "../../src/publishing/mcp/resource-content.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
import type {
	ConversationEventRecord,
	McpCallAuditRecord,
	McpServerRecord,
	McpServerRevisionRecord,
	PublishingRepositories,
} from "../../src/publishing/repositories.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import { restoreContext } from "../../src/runtime/context-restore.ts";
import { createPiRuntimeAdapter } from "../../src/runtime/pi-runtime-adapter.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";
import type { PiSessionRuntime } from "../../src/types.ts";

const tenantId = parseIdOrThrow("TenantId", "00000000-0000-7000-8000-000000000001", "tenant");
const mcpServerId = parseIdOrThrow("McpServerId", "00000000-0000-7000-8000-000000000002", "MCP Server");
const now = new Date("2026-08-26T00:00:00.000Z");
const requestId = parseIdOrThrow("RequestId", "00000000-0000-7000-8000-000000000007", "request");

function frozenSpec(): RuntimeSpec {
	return {
		schemaVersion: 1,
		publishedAppVersionId: "pav-test",
		agent: { systemPrompt: "Use the CRM tool.", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			skills: [],
			mcpServers: [
				{
					mcpServerId: toPublicId("McpServerId", mcpServerId),
					revision: 2,
					transport: "streamable_http",
					endpoint: "https://mcp.example.com/v1",
					authentication: "none",
					tools: [
						{
							name: "crm_lookup",
							description: "Lookup one customer",
							inputSchema: { type: "object", properties: { customerId: { type: "string" } } },
							inputSchemaHash: "a".repeat(64),
						},
					],
				},
			],
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26_214_400 },
			speech: { enabled: false },
			realtimeVoice: { enabled: false },
			avatar: { enabled: false },
			conversations: { allowNew: true },
		},
		contextPolicy: { maxTurns: 100, maxContextTokens: 100_000, toolResultMaxBytes: 65_536, logLevel: "standard" },
		runtimePolicy: {
			profile: "chat-only",
			turnTimeoutMs: 120_000,
			idleTtlMs: 1_200_000,
			maxConcurrentTurnsPerConversation: 1,
		},
		theme: {},
		securityPolicyVersion: "sp_001",
	};
}

function runtimeScope(): ScopeContext {
	return {
		tenantId,
		publishedAppId: parseIdOrThrow("PublishedAppId", "00000000-0000-7000-8000-000000000003", "app"),
		publishedAppVersionId: parseIdOrThrow(
			"PublishedAppVersionId",
			"00000000-0000-7000-8000-000000000004",
			"app version",
		),
		principalId: parseIdOrThrow("PrincipalId", "00000000-0000-7000-8000-000000000005", "principal"),
		conversationId: parseIdOrThrow("ConversationId", "00000000-0000-7000-8000-000000000006", "conversation"),
		requestId,
		limits: {
			maxTurns: 100,
			maxContextTokens: 100_000,
			toolResultMaxBytes: 65_536,
			turnTimeoutMs: 120_000,
			maxConcurrentTurnsPerConversation: 1,
		},
	};
}

describe("MCP runtime Tool boundary", () => {
	it.each(["removed", "changed", "unchanged"] as const)(
		"checks a %s tool against the latest discovered revision",
		async (state) => {
			let calls = 0;
			const repositories = {
				mcpServers: {
					get: async () => ({ name: "MCP", status: "enabled", currentRevision: 3 }),
					getRevision: async () => ({ revision: 2 }),
					listTools: async () =>
						state === "removed"
							? []
							: [{ name: "crm_lookup", inputSchemaHash: (state === "changed" ? "b" : "a").repeat(64) }],
					recordCallAudit: async () => {},
				},
			} as unknown as PublishingRepositories;
			const tools = await createMcpRuntimeToolFactory({
				repositories,
				connect: async () => ({
					listTools: async () => [],
					callTool: async () => {
						calls += 1;
						return { content: [] };
					},
					close: async () => {},
				}),
			})(frozenSpec(), runtimeScope());
			const action = tools[0]!.execute("call", {}, undefined, undefined, undefined as never);
			if (state === "unchanged") await expect(action).resolves.toBeDefined();
			else await expect(action).rejects.toThrow("已被移除或参数已变更");
			expect(calls).toBe(state === "unchanged" ? 1 : 0);
		},
	);
	it.each(["bearer", "api_key"] as const)(
		"decrypts %s credentials for runtime calls without putting secrets in the frozen spec or audits",
		async (authentication) => {
			const base = frozenSpec();
			const parsed = parseRuntimeSpec({
				...base,
				capabilities: {
					...base.capabilities,
					mcpServers: base.capabilities.mcpServers.map((server) => ({ ...server, authentication })),
				},
			});
			if (!parsed.ok) throw new Error(parsed.errors.join("; "));
			const secretBox = new McpSecretBox(Buffer.alloc(32, 7));
			let credential = "runtime-test-secret";
			let secret = secretBox.seal(tenantId, mcpServerId, credential);
			const audits: McpCallAuditRecord[] = [];
			let connections = 0;
			const tools = await createMcpRuntimeToolFactory({
				secretBox,
				repositories: {
					mcpServers: {
						get: async () => ({ name: "Dify", status: "enabled" }),
						getRevision: async () => ({ revision: 2 }),
						recordCallAudit: async (audit: McpCallAuditRecord) => {
							audits.push(audit);
						},
					},
					mcpSecrets: { get: async () => secret },
				} as unknown as PublishingRepositories,
				connect: async (options) => {
					connections += 1;
					expect(options.bearerToken).toBe(authentication === "bearer" ? credential : undefined);
					expect(options.apiKey).toBe(authentication === "api_key" ? credential : undefined);
					return { listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => {} };
				},
			})(parsed.spec, runtimeScope());
			await tools[0]!.execute("authenticated", {}, undefined, undefined, undefined as never);
			expect(connections).toBe(1);
			expect(JSON.stringify(parsed.spec)).not.toContain(credential);
			expect(JSON.stringify(audits)).not.toContain(credential);
			credential = "rotated-secret";
			secret = secretBox.seal(tenantId, mcpServerId, credential);
			// Re-read credentials on every call: a rotated key must reach the connector.
			await tools[0]!.execute("rotated", {}, undefined, undefined, undefined as never);
			expect(connections).toBe(2);
		},
	);
	it("reads a previously discovered image on the first prompt after rebuilding a runtime", async () => {
		let connected = 0;
		let searched = 0;
		let enabled = true;
		const uri = "rag://documents/doc-1/assets/flow";
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=";
		const factory = createMcpRuntimeToolFactory({
			repositories: {
				mcpServers: {
					get: async () => ({ name: "知识库", status: enabled ? "enabled" : "disabled" }),
					getRevision: async () => ({ revision: 2 }),
					recordCallAudit: async () => {},
				},
			} as unknown as PublishingRepositories,
			connect: async () => {
				connected += 1;
				return {
					listTools: async () => [],
					close: async () => {},
					callTool: async () => {
						searched += 1;
						return {
							content: [],
							structuredContent: { document_id: "doc-1", source_name: "管理办法.docx", asset_ids: ["flow"] },
						};
					},
					readResource: async (target) => {
						expect(target).toBe(uri);
						return { contents: [{ uri, mimeType: "image/png", blob: png }] };
					},
				};
			},
		});
		const oldTools = await factory(frozenSpec(), runtimeScope());
		const search = await oldTools[0]!.execute("original-search", {}, undefined, undefined, undefined as never);
		const events = [
			{ eventType: "user/message", payload: { text: "查看流程" } },
			{ eventType: "tool/call", payload: { toolCallId: "original-search", toolName: "crm_lookup", input: {} } },
			{
				eventType: "tool/result",
				payload: { toolCallId: "original-search", toolName: "crm_lookup", content: search.content },
			},
			{ eventType: "assistant/message", payload: { text: "流程如下" } },
		].map((event) => ({
			...event,
			eventSchemaVersion: 1,
			turnId: "old-turn",
		})) as unknown as ConversationEventRecord[];
		const history = restoreContext(events, { maxContextTokens: 10_000 });
		const adapter = createPiRuntimeAdapter({
			createMcpTools: factory,
			createSession: async (options) =>
				({
					prompt: async () => {
						const reader = options.customTools!.find((tool) => tool.name.startsWith("mcp_read_resource_"))!;
						const result = await reader.execute(
							"restored-read",
							{ uri },
							undefined,
							undefined,
							undefined as never,
						);
						expect(result.content[1]).toMatchObject({ provenance: { documentTitle: "管理办法.docx" } });
					},
					dispose: async () => {},
				}) as unknown as PiSessionRuntime,
		});
		const opened = await adapter.open(frozenSpec(), runtimeScope());
		if (!opened.ok) throw new Error(opened.reason);
		await opened.runtime.prompt("再看看流程图", { history });
		await opened.runtime.prompt("再读一次", { history });
		expect(searched).toBe(1);
		expect(connected).toBe(3);
		enabled = false;
		await expect(opened.runtime.prompt("禁用后读取", { history })).rejects.toThrow("unavailable");
		expect(connected).toBe(3);
		await opened.runtime.close();
		const fresh = await factory(frozenSpec(), runtimeScope());
		enabled = true;
		await expect(
			fresh[1]!.execute("other-conversation", { uri }, undefined, undefined, undefined as never),
		).rejects.toThrow("not discovered");
	});
	it("accepts nullable RAG search fields and preserves their type constraints through argument validation", async () => {
		const spec = frozenSpec();
		const searchSchema = {
			type: "object",
			properties: {
				query: { type: "string" },
				threshold: { type: ["number", "null"] },
				filters: {
					type: "object",
					properties: { score: { type: ["integer", "null"] } },
					additionalProperties: false,
				},
			},
			required: ["query"],
			additionalProperties: false,
		};
		const ragSpec: RuntimeSpec = {
			...spec,
			capabilities: {
				...spec.capabilities,
				mcpServers: spec.capabilities.mcpServers.map((server) => ({
					...server,
					tools: [{ ...server.tools[0]!, name: "search_chunks", inputSchema: searchSchema }],
				})),
			},
		};
		const tools = await createMcpRuntimeToolFactory({
			repositories: { mcpServers: { get: async () => ({ name: "知识库" }) } } as unknown as PublishingRepositories,
		})(ragSpec, runtimeScope());
		const tool = tools.find((tool) => tool.name === "search_chunks")!;
		expect(tool.parameters).toMatchObject({ properties: searchSchema.properties });
		for (const threshold of [null, 0.65]) {
			const args = { query: "客户问题处理流程", threshold, filters: { score: null } };
			expect(
				validateToolArguments(tool, { type: "toolCall", id: "search-1", name: tool.name, arguments: args }),
			).toEqual(args);
		}
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "search-2",
				name: tool.name,
				arguments: { query: "流程", threshold: {} },
			}),
		).toThrow("Validation failed");
	});

	it.each([{ type: [] }, { type: ["number", 42] }, { type: ["number", "unknown"] }, { type: ["number", "number"] }])(
		"continues rejecting invalid type arrays: $type",
		async ({ type }) => {
			const spec = frozenSpec();
			const invalidSpec: RuntimeSpec = {
				...spec,
				capabilities: {
					...spec.capabilities,
					mcpServers: spec.capabilities.mcpServers.map((server) => ({
						...server,
						tools: [
							{ ...server.tools[0]!, inputSchema: { type: "object", properties: { threshold: { type } } } },
						],
					})),
				},
			};
			await expect(
				createMcpRuntimeToolFactory({ repositories: {} as PublishingRepositories })(invalidSpec, runtimeScope()),
			).rejects.toThrow("invalid input schema");
		},
	);

	it("reads only discovered resources, keeps images native, audits reads, and rechecks disabled servers", async () => {
		const audits: McpCallAuditRecord[] = [];
		let enabled = true;
		let reads = 0;
		let closed = 0;
		const repositories = {
			mcpServers: {
				get: async () => ({ name: "时空道宇知识库", status: enabled ? "enabled" : "disabled" }),
				getRevision: async () => ({ revision: 2 }),
				recordCallAudit: async (audit: McpCallAuditRecord) => audits.push(audit),
			},
		} as unknown as PublishingRepositories;
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=";
		const uri = "rag://documents/doc-1/assets/logo";
		const tools = await createMcpRuntimeToolFactory({
			repositories,
			connect: async () => ({
				listTools: async () => [],
				callTool: async () => ({
					content: [{ type: "text", text: "logo" }],
					structuredContent: {
						evidence: [{ document_id: "doc-1", source_name: "管理办法.docx", asset_ids: ["logo"] }],
					},
				}),
				readResource: async (target) => {
					reads += 1;
					expect(target).toBe(uri);
					return { contents: [{ uri, mimeType: "image/png", blob: png }] };
				},
				close: async () => {
					closed += 1;
				},
			}),
		})(frozenSpec(), runtimeScope());
		await expect(
			tools[1]!.execute("read-unknown", { uri }, undefined, undefined, undefined as never),
		).rejects.toThrow("not discovered");
		expect(reads).toBe(0);
		const search = await tools[0]!.execute("search", {}, undefined, undefined, undefined as never);
		expect(JSON.stringify(search.content)).toContain(uri);
		const searchText = search.content[0];
		expect(searchText?.type === "text" && JSON.parse(searchText.text)).toMatchObject({
			source: { service_name: "时空道宇知识库" },
			resources: { read_tool: tools[1]!.name, items: [{ uri, asset_id: "logo", document_id: "doc-1" }] },
		});
		expect(tools[1]?.description).toContain("时空道宇知识库");
		const image = await tools[1]!.execute("read", { uri }, undefined, undefined, undefined as never);
		expect(image.content[1]).toEqual({
			type: "image",
			mimeType: "image/png",
			data: png,
			provenance: { documentTitle: "管理办法.docx" },
		});
		expect(audits.at(-1)).toMatchObject({ toolName: tools[1]!.name, outcome: "success", resultTruncated: false });
		await expect(
			tools[1]!.execute("forged", { uri: "file:///etc/passwd" }, undefined, undefined, undefined as never),
		).rejects.toThrow("not discovered");
		enabled = false;
		await expect(tools[1]!.execute("disabled", { uri }, undefined, undefined, undefined as never)).rejects.toThrow(
			"unavailable",
		);
		expect(reads).toBe(1);
		expect(closed).toBe(2);
	});

	it("rejects an invalid frozen Tool schema before exposing runtime Tools", async () => {
		const spec = frozenSpec();
		const invalidSpec = {
			...spec,
			capabilities: {
				...spec.capabilities,
				mcpServers: spec.capabilities.mcpServers.map((server) => ({
					...server,
					tools: server.tools.map((tool) => ({ ...tool, inputSchema: { type: 42 } })),
				})),
			},
		} as unknown as RuntimeSpec;
		const repositories = {} as PublishingRepositories;
		await expect(createMcpRuntimeToolFactory({ repositories })(invalidSpec, runtimeScope())).rejects.toThrow(
			"invalid input schema",
		);
	});

	it("exposes only the frozen Tool and fails closed with a redacted audit when its Server is disabled", async () => {
		const audits: McpCallAuditRecord[] = [];
		const server: McpServerRecord = {
			mcpServerId,
			tenantId,
			name: "crm-mcp",
			status: "disabled",
			currentRevision: 3,
			lastTestOk: null,
			lastTestLatencyMs: null,
			lastTestAt: null,
			createdAt: now,
			updatedAt: now,
		};
		const revision: McpServerRevisionRecord = {
			mcpServerId,
			tenantId,
			revision: 2,
			transport: "streamable_http",
			endpoint: "https://mcp.example.com/v1",
			authentication: "none",
			createdAt: now,
		};
		const repositories = {
			mcpServers: {
				get: async () => server,
				getRevision: async () => revision,
				recordCallAudit: async (audit: McpCallAuditRecord) => audits.push(audit),
			},
		} as unknown as PublishingRepositories;
		const tools = await createMcpRuntimeToolFactory({ repositories })(frozenSpec(), runtimeScope());
		expect(tools.map((tool) => tool.name)).toEqual([
			"crm_lookup",
			mcpResourceToolName(toPublicId("McpServerId", mcpServerId)),
		]);
		await expect(
			tools[0]?.execute("call-1", { customerId: "sensitive-123" }, undefined, undefined, undefined as never),
		).rejects.toThrow("MCP Server is unavailable");
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			tenantId,
			mcpServerId,
			mcpRevision: 2,
			toolName: "crm_lookup",
			outcome: "error",
			errorCode: "MCP_CALL_FAILED",
			resultBytes: 0,
			resultTruncated: false,
		});
		expect(JSON.stringify(audits[0])).not.toContain("sensitive-123");
	});

	it("calls through the secure connector, bounds the result, closes the session, and records success", async () => {
		const audits: McpCallAuditRecord[] = [];
		let closed = 0;
		let received: { readonly name: string; readonly argumentsValue: Readonly<Record<string, unknown>> } | undefined;
		const repositories = {
			mcpServers: {
				get: async () => ({
					mcpServerId,
					tenantId,
					name: "crm-mcp",
					status: "enabled" as const,
					currentRevision: 2,
					lastTestOk: true,
					lastTestLatencyMs: 10,
					lastTestAt: now,
					createdAt: now,
					updatedAt: now,
				}),
				getRevision: async () => ({
					mcpServerId,
					tenantId,
					revision: 2,
					transport: "streamable_http" as const,
					endpoint: "https://mcp.example.com/v1",
					authentication: "none" as const,
					createdAt: now,
				}),
				recordCallAudit: async (audit: McpCallAuditRecord) => audits.push(audit),
			},
		} as unknown as PublishingRepositories;
		const factory = createMcpRuntimeToolFactory({
			repositories,
			connect: async () => ({
				listTools: async () => [],
				callTool: async (name, argumentsValue, signal) => {
					received = { name, argumentsValue };
					if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
					return { content: [{ type: "text", text: "x".repeat(256) }] };
				},
				close: async () => {
					closed += 1;
				},
			}),
		});
		const smallScope: ScopeContext = {
			...runtimeScope(),
			limits: { ...runtimeScope().limits, toolResultMaxBytes: 64 },
		};
		const tools = await factory(frozenSpec(), smallScope);
		const result = await tools[0]?.execute(
			"call-2",
			{ customerId: "customer-42" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(received).toEqual({ name: "crm_lookup", argumentsValue: { customerId: "customer-42" } });
		expect(closed).toBe(1);
		expect(result?.details).toEqual({ mcpServerId: toPublicId("McpServerId", mcpServerId), resultTruncated: true });
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ outcome: "success", resultTruncated: true, errorCode: null });
		expect(audits[0]?.resultBytes).toBeGreaterThan(64);
		expect(audits[0]?.requestId).toBe(requestId);

		const controller = new AbortController();
		controller.abort();
		await expect(
			tools[0]?.execute("call-3", { customerId: "cancelled" }, controller.signal, undefined, undefined as never),
		).rejects.toThrow("Aborted");
		expect(closed).toBe(2);
		expect(audits[1]).toMatchObject({
			outcome: "cancelled",
			errorCode: "MCP_CALL_CANCELLED",
			resultBytes: 0,
			resultTruncated: false,
		});
	});
});

import { describe, expect, it } from "vitest";
import { parseIdOrThrow, toPublicId } from "../../src/publishing/domain/ids.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import type {
	McpCallAuditRecord,
	McpServerRecord,
	McpServerRevisionRecord,
	PublishingRepositories,
} from "../../src/publishing/repositories.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";

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
			avatar: { enabled: false },
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
		expect(tools.map((tool) => tool.name)).toEqual(["crm_lookup"]);
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
					currentRevision: 3,
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

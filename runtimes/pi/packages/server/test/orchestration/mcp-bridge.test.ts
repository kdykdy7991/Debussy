import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { protectTool } from "../../src/orchestration/protected-tool.ts";
import { createBoundaryExecutionSource } from "../../src/orchestration/execution-source.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";

test("the MCP factory applies the credential adapter before exposing tools to the runtime", async () => {
	const serverId = "mcp_00000000-0000-4000-8000-000000000001";
	const schema = {
		type: "object",
		properties: { alarm: { type: "string" }, apiKey: { type: "string" } },
		required: ["alarm", "apiKey"],
		additionalProperties: false,
	};
	const parsed = parseRuntimeSpec({
		schemaVersion: 1,
		publishedAppVersionId: "v",
		agent: { systemPrompt: "test", model: { provider: "fake", modelId: "test" } },
		capabilities: {
			mcpServers: [
				{
					mcpServerId: serverId,
					revision: 1,
					transport: "streamable_http",
					endpoint: "https://mcp.example.test",
					authentication: "none",
					tools: [
						{ name: "query_alarm", description: "Query", inputSchema: schema, inputSchemaHash: "a".repeat(64) },
					],
				},
			],
		},
	});
	if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
	const received: unknown[] = [];
	const repositories = {
		mcpServers: {
			get: async () => ({ name: "MCP", status: "enabled", currentRevision: 1 }),
			getRevision: async () => ({ revision: 1 }),
			recordCallAudit: async () => {},
		},
	} as unknown as PublishingRepositories;
	const factory = createMcpRuntimeToolFactory({
		repositories,
		connect: async () => ({
			listTools: async () => [],
			callTool: async (_name, args) => {
				received.push(args);
				return { content: [{ type: "text", text: JSON.stringify(args) }] };
			},
			close: async () => {},
		}),
		protectTool,
		// The shared source adapter supplies the bindings and the credential; the
		// server-only protector hides the parameter from the model and injects it.
		executionSource: async () =>
			createBoundaryExecutionSource({
				boundary: undefined,
				owner: { kind: "conversation", conversationId: "work-context" },
				toolBindings: async (id, toolName) => {
					expect(id).toBe(serverId);
					return [{ mcpServerId: id, toolName, parameter: "apiKey", credential: "ticketKey" }];
				},
				toolCredentials: async () => ({ ticketKey: "private-task-key" }),
			}),
	});
	const tools = await factory(parsed.spec, {
		conversationId: "work-context",
		tenantId: "tenant",
		publishedAppVersionId: "00000000-0000-4000-8000-000000000002",
		limits: { toolResultMaxBytes: 65536 },
	} as ScopeContext);
	const tool = tools.find((t) => t.name === "query_alarm")!;
	expect(tool.parameters).toEqual(
		Type.Unsafe({ ...schema, properties: { alarm: { type: "string" } }, required: ["alarm"] }),
	);
	const result = await tool.execute(
		"call",
		{ alarm: "alarm-1" },
		undefined,
		undefined,
		{} as Parameters<ToolDefinition["execute"]>[4],
	);
	expect(received).toEqual([{ alarm: "alarm-1", apiKey: "private-task-key" }]);
	expect(JSON.stringify(result)).not.toContain("private-task-key");
});

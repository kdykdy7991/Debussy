import type { McpToolRef } from "@earendil-works/pi-protocol";
import { expect, test, vi } from "vitest";
import { McpApi } from "../../src/admin/api/mcp-api.ts";
import { sensitiveParameterTools } from "../../src/admin/pages/mcp-sensitive-rules.tsx";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

function tool(name: string, properties: Record<string, unknown>): McpToolRef {
	return { id: name, name, description: null, inputSchemaHash: "fixture", inputSchema: { properties } };
}

test("matches one parameter across 32 tools using only eligible top-level string fields", () => {
	const matching = Array.from({ length: 32 }, (_, index) => `ticketTool${index}`);
	const parameters = sensitiveParameterTools([
		...matching.map((name) => tool(name, { authToken: { type: "string" } })),
		tool("otherTool", {
			data: { type: "object", properties: { authToken: { type: "string" } } },
			authToken: { type: "number" },
			userKey: { type: "string" },
			"invalid-name": { type: "string" },
		}),
	]);
	expect([...parameters]).toEqual([
		["authToken", matching],
		["userKey", ["otherTool"]],
	]);
});

test("publishes exact tool names in batches and keeps existing credential IDs and the expected revision", async () => {
	const auth = new AdminAuthController();
	auth.connect("fixture");
	const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { revision: 9 } }));
	const api = new McpApi({ auth, fetchImpl });
	const mcpServerId = "mcp_fixture";
	const names = Array.from({ length: 130 }, (_, index) => `tool_${index}`);
	await expect(
		api.publishSensitiveRules(mcpServerId, 8, [
			{ mcpServerId, parameter: "authToken", toolName: "retained", credentialId: "existing_credential" },
			...names.map((toolName) => ({
				mcpServerId,
				parameter: "authToken",
				toolName,
				credentialId: "tool_credential",
			})),
		]),
	).resolves.toEqual({ revision: 9 });
	const [url, init] = fetchImpl.mock.calls[0] ?? [];
	expect(url).toBe(`/api/control/v1/mcp-servers/${mcpServerId}/sensitive-rules`);
	expect(init?.method).toBe("POST");
	expect(JSON.parse(String(init?.body))).toEqual({
		expected_revision: 8,
		reuse_equivalent: false,
		rules: [
			{ mcpServerId, parameter: "authToken", credentialId: "existing_credential", toolNames: ["retained"] },
			{ mcpServerId, parameter: "authToken", credentialId: "tool_credential", toolNames: names.slice(0, 128) },
			{ mcpServerId, parameter: "authToken", credentialId: "tool_credential", toolNames: names.slice(128) },
		],
	});
	await api.publishSensitiveRules(mcpServerId, 9, []);
	expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).rules).toEqual([]);
});

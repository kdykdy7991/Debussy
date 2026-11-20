import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { eventSchema } from "../../src/orchestration/contracts.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { modelToolSchema, protectTool, publicToolDescription, publicToolSchema } from "../../src/orchestration/protected-tool.ts";

const schema = {
	type: "object",
	properties: { alarmId: { type: "string" }, api_key: { type: "string" } },
	required: ["alarmId", "api_key"],
	additionalProperties: false,
};
const bindings = [{ mcpServerId: "mcp_test", toolName: "query_alarm", parameter: "api_key", credential: "ticketKey" }];
const context = {} as Parameters<ToolDefinition["execute"]>[4];

test("tool credentials are encrypted and bound to the exact work scope", () => {
	const box = new WorkCredentialBox(Buffer.alloc(32, 5));
	const sealed = box.seal("tenant:integration:work:credential", { ticketKey: "a-user-secret" });
	expect(JSON.stringify(sealed)).not.toContain("a-user-secret");
	expect(box.open("tenant:integration:work:credential", sealed)).toEqual({ ticketKey: "a-user-secret" });
	expect(() => box.open("other:integration:work:credential", sealed)).toThrow();
});

test("the model schema hides injected fields and rejects ambiguous schemas", () => {
	const visible = modelToolSchema(schema, bindings);
	expect(visible.properties).toEqual({ alarmId: { type: "string" } });
	expect(visible.required).toEqual(["alarmId"]);
	expect(schema.properties.api_key).toEqual({ type: "string" });
	expect(() => modelToolSchema({ ...schema, allOf: [] }, bindings)).toThrow();
	expect(() => modelToolSchema(schema, [...bindings, ...bindings])).toThrow();
});

test("public schemas and tool descriptions do not instruct the model to supply injected parameters", () => {
	const input = { type: "object", description: "Required: authToken.", properties: { id: { type: "string", description: "An identifier" }, authToken: { type: "string" } }, required: ["id", "authToken"] };
	const visible = publicToolSchema(input, ["authToken"]);
	expect(JSON.stringify(visible)).not.toContain("authToken");
	expect(visible.required).toEqual(["id"]);
	expect(publicToolDescription("Find tickets. Required: id, authToken. Optional: page.", ["authToken"])).toBe("Find tickets. Optional: page.");
	expect(publicToolDescription("查询工单。\n必填参数：authToken 身份认证令牌", ["authToken"])).toBe("查询工单。");
});

test("parallel tasks inject their own keys, overwrite supplied secrets, and redact tool echoes", async () => {
	const received: unknown[] = [];
	const tool: ToolDefinition = {
		name: "query_alarm",
		label: "Query",
		description: "Query an alarm",
		parameters: Type.Unsafe(schema),
		execute: async (_id, args) => {
			received.push(args);
			return { content: [{ type: "text", text: JSON.stringify(args) }], details: {} };
		},
	};
	const a = protectTool(tool, schema, bindings, async () => ({ ticketKey: "user-a-secret" }));
	const b = protectTool(tool, schema, bindings, async () => ({ ticketKey: "user-b-secret" }));
	const results = await Promise.all([
		a.execute("a", { alarmId: "1", api_key: "forged" }, undefined, undefined, context),
		b.execute("b", { alarmId: "2" }, undefined, undefined, context),
	]);
	expect(received).toEqual([
		{ alarmId: "1", api_key: "user-a-secret" },
		{ alarmId: "2", api_key: "user-b-secret" },
	]);
	expect(JSON.stringify(results)).not.toContain("user-a-secret");
	expect(JSON.stringify(results)).not.toContain("user-b-secret");
});

test("validation and transport errors cannot expose injected credentials", async () => {
	const tool: ToolDefinition = {
		name: "query_alarm",
		label: "Query",
		description: "Query",
		parameters: Type.Unsafe(schema),
		execute: async () => {
			throw new Error("transport echoed user-secret");
		},
	};
	const protectedTool = protectTool(tool, schema, bindings, async () => ({ ticketKey: "user-secret" }));
	await expect(protectedTool.execute("a", { wrong: "input" }, undefined, undefined, context)).rejects.not.toThrow(
		"user-secret",
	);
	await expect(protectedTool.execute("b", { alarmId: "1" }, undefined, undefined, context)).rejects.not.toThrow(
		"user-secret",
	);
});

test("event contract requires event identity but no user profile", () => {
	expect(
		eventSchema.parse({
			eventId: "event-1",
			alarmId: "alarm-1",
			input: "alarm data",
			credentials: {},
			credentialExpiresAt: new Date(Date.now() + 60000).toISOString(),
		}),
	).not.toHaveProperty("userId");
});

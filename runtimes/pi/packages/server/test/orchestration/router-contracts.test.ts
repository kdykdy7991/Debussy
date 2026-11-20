/**
 * Phase 1 Router contract gate: Zod schemas, OpenAPI document and error-code
 * catalogue must agree. This is a static check only; it does NOT prove the six
 * Router paths are callable or that execution works.
 */
import { describe, expect, test } from "vitest";
import { routerOpenApi } from "../../src/orchestration/router-api-documentation.ts";
import {
	appendInputRequestSchema,
	appendInputResponseSchema,
	cancelTaskRequestSchema,
	cancelTaskResponseSchema,
	createTaskRequestSchema,
	createTaskResponseSchema,
	eventsQuerySchema,
	ROUTER_CAPABILITY_HEADER,
	ROUTER_ERROR_CODES,
	ROUTER_PAGE_LIMIT,
	ROUTER_PATHS,
	ROUTER_PREDECESSOR_CANCEL_REASON,
	ROUTER_PROGRESS_FIELDS,
	ROUTER_PUBLIC_EVENT_TYPES,
	ROUTER_TIME_BUDGETS,
	routerCredentialsSchema,
	routerMcpServerDetailSchema,
	routerMcpServerSummarySchema,
	routerProgressFieldsSchema,
	routerProgressSchema,
	taskEventsResponseSchema,
	taskQuerySchema,
	taskViewSchema,
} from "../../src/orchestration/router-contracts.ts";

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
	return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error("expected array");
	return value;
}
function operation(path: string, method: string): Record<string, unknown> {
	return object(object(routerOpenApi.paths)[path])[method] as Record<string, unknown>;
}
function response(path: string, method: string, status: string): Record<string, unknown> {
	return object(object(operation(path, method).responses)[status]);
}
function envelopeData(path: string, method: string, status: string): Record<string, unknown> {
	const content = object(response(path, method, status).content);
	return object(object(object(content["application/json"]).schema).properties).data as Record<string, unknown>;
}
function component(name: string): Record<string, unknown> {
	return object(object(object(routerOpenApi.components).schemas)[name]);
}
const taskId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const serverId = "mcp_33333333-3333-4333-8333-333333333333";
const now = "2026-11-18T00:00:00.000Z";

describe("Router V1 contract consistency", () => {
	test("published examples satisfy request schemas and have status-appropriate errors", () => {
		for (const [path, schema] of [
			[ROUTER_PATHS[0], createTaskRequestSchema],
			[ROUTER_PATHS[1], appendInputRequestSchema],
		] as const) {
			const body = object(object(object(operation(path, "post").requestBody).content)["application/json"]);
			const examples = object(body.examples);
			expect(Object.keys(examples)).toEqual(["model", "mcpWithoutCredential", "mcp"]);
			for (const example of Object.values(examples))
				expect(schema.safeParse(object(example).value).success).toBe(true);
		}
		for (const path of ROUTER_PATHS.slice(0, 2)) {
			const responses = object(operation(path, "post").responses);
			const success = object(
				object(object(responses[path === ROUTER_PATHS[0] ? "201" : "202"]).content)["application/json"],
			);
			const data = object(object(success.example).data);
			expect(data.duplicate).toBe(false);
			expect(data.ordinal).toBe(path === ROUTER_PATHS[0] ? 1 : 2);
			for (const [status, value] of Object.entries(responses)) {
				if (Number(status) < 400) continue;
				const media = object(object(object(value).content)["application/json"]);
				for (const [code, example] of Object.entries(object(media.examples))) {
					const error = object(object(object(example).value).error);
					expect(error.code).toBe(code);
					expect(error.retryable).toBe(Number(status) >= 500);
				}
			}
		}
	});
	test("describes the six core operations and the retained MCP discovery paths", () => {
		expect(Object.keys(routerOpenApi.paths)).toEqual([
			...ROUTER_PATHS,
			"/api/aaas/v1/mcp-servers",
			"/api/aaas/v1/mcp-servers/{server_id}",
		]);
		expect(routerOpenApi.info.version).toBe("1.0.0");
		for (const path of ROUTER_PATHS) expect(Object.keys(object(routerOpenApi.paths[path]))).toHaveLength(1);
		const parameters = array(operation(ROUTER_PATHS[0], "post").parameters).map((item) => object(item).name);
		expect(parameters).toContain("Idempotency-Key");
		expect(parameters).toContain(ROUTER_CAPABILITY_HEADER);
	});

	test("Zod request schemas and OpenAPI declare the same fields, optional credentials and expiry", () => {
		const create = component("RouterCreateTaskRequest");
		const append = component("RouterAppendInputRequest");
		expect(Object.keys(createTaskRequestSchema.shape).sort()).toEqual(Object.keys(object(create.properties)).sort());
		expect(Object.keys(appendInputRequestSchema.shape).sort()).toEqual(Object.keys(object(append.properties)).sort());
		expect(array(create.required)).toEqual(["prompt"]);
		expect(array(append.required)).toEqual(["input"]);
		expect(createTaskRequestSchema.safeParse({ prompt: "任务" }).success).toBe(true);
		expect(createTaskRequestSchema.parse({ prompt: "任务" }).credentials).toEqual({ servers: {} });
		expect(createTaskRequestSchema.safeParse({ prompt: "任务", credentials_expires_at: now }).success).toBe(false);
		expect(
			appendInputRequestSchema.safeParse({ input: "后续输入", credentials_expires_at: "not-a-date" }).success,
		).toBe(false);
		expect(
			appendInputRequestSchema.safeParse({ input: "后续输入", capability_selection: { scope: "router" } }).success,
		).toBe(false);
		expect(routerCredentialsSchema.safeParse({ servers: {} }).success).toBe(true);
		expect(routerCredentialsSchema.safeParse({ servers: { [serverId]: {} } }).success).toBe(false);
		expect(cancelTaskRequestSchema.safeParse({ reason: "stop", extra: 1 }).success).toBe(false);
		expect(ROUTER_PAGE_LIMIT).toMatchObject({ default: 50, max: 200 });
		expect(taskQuerySchema.parse({}).limit).toBe(ROUTER_PAGE_LIMIT.default);
		expect(eventsQuerySchema.parse({}).limit).toBe(ROUTER_PAGE_LIMIT.default);
		expect(eventsQuerySchema.safeParse({ limit: ROUTER_PAGE_LIMIT.max + 1 }).success).toBe(false);
		expect(ROUTER_TIME_BUDGETS).toEqual({ queueMs: 3_600_000, credentialMaxMs: 1_800_000 });
	});

	test("progress schema and OpenAPI share one safe field whitelist", () => {
		expect(Object.keys(routerProgressFieldsSchema.shape).sort()).toEqual([...ROUTER_PROGRESS_FIELDS].sort());
		expect(array(component("RouterProgress")["x-field-whitelist"])).toEqual([...ROUTER_PROGRESS_FIELDS]);
		expect(Object.keys(object(component("RouterProgress").properties)).sort()).toEqual(
			[...ROUTER_PROGRESS_FIELDS].sort(),
		);
		expect(routerProgressSchema.safeParse({ stage: "tools", updated_at: now }).success).toBe(true);
		expect(
			routerProgressSchema.safeParse({
				stage: "tools",
				updated_at: now,
				thinking: "internal",
				raw_tool_arguments: {},
			}).success,
		).toBe(false);
		expect(
			routerProgressSchema.safeParse({ stage: "tools", updated_at: now, tools_completed: 4, tools_total: 2 })
				.success,
		).toBe(false);
	});

	test("public Events bind strict payloads by event type", () => {
		const publicEvent = (payload: Record<string, unknown>) => ({
			sequence: "7",
			operation_id: operationId,
			type: "operation.progress",
			schema_version: 1,
			payload,
			created_at: now,
		});
		expect(
			taskEventsResponseSchema.safeParse({
				events: [publicEvent({ stage: "tools", tools_completed: 1, tools_total: 2, updated_at: now })],
				next_cursor: null,
				has_more: false,
			}).success,
		).toBe(true);
		const rejected = taskEventsResponseSchema.safeParse({
			events: [publicEvent({ stage: "tools", thinking: "secret", raw_tool_arguments: {} })],
			next_cursor: null,
			has_more: false,
		});
		expect(rejected.success).toBe(false);
		const eventsSchema = object(component("RouterTaskEventsResponse").properties);
		expect(array(object(eventsSchema.events).items && object(object(eventsSchema.events).items).oneOf)).toHaveLength(
			ROUTER_PUBLIC_EVENT_TYPES.length,
		);
		expect(array(object(eventsSchema.events)["x-public-event-types"])).toEqual([...ROUTER_PUBLIC_EVENT_TYPES]);
		expect(
			taskEventsResponseSchema.safeParse({
				events: [{ ...publicEvent({}), type: "tool.result" }],
				next_cursor: null,
				has_more: false,
			}).success,
		).toBe(false);
	});

	test("response schemas match the frozen flat samples, cleanup fields and cancellation time", () => {
		const flat = {
			operation_id: operationId,
			operation_status: "queued",
			ordinal: 1,
			duplicate: false,
		};
		const created = createTaskResponseSchema.parse({ task_id: taskId, status: "active", ...flat });
		expect(created).toMatchObject({ task_id: taskId, operation_status: "queued", ordinal: 1 });
		const appended = appendInputResponseSchema.parse({ task_id: taskId, ...flat, ordinal: 2 });
		expect(appended.ordinal).toBe(2);
		expect(createTaskResponseSchema.safeParse({ task_id: taskId, status: "active", operation: flat }).success).toBe(
			false,
		);
		expect(array(envelopeData(ROUTER_PATHS[0], "post", "201").required)).toEqual([
			"task_id",
			"status",
			"operation_id",
			"operation_status",
			"ordinal",
			"duplicate",
		]);
		const canceled = cancelTaskResponseSchema.parse({
			task_id: taskId,
			status: "canceled",
			canceled_at: now,
			cleanup_pending: true,
		});
		expect(canceled.canceled_at).toBe(now);
		const taskView = taskViewSchema.parse({
			id: taskId,
			status: "active",
			cleanup_status: "pending",
			cleanup_reason: "cleanup pending after failure",
			latest_result: null,
			latest_operation: { id: operationId, status: "failed", error: { code: "EXECUTION_FAILED" } },
			operations: [{ id: operationId, sequence: 1, status: "failed", duplicate: false }],
			usage: { complete: false, known_totals: { total_tokens: 3 }, unknown_operations: 1 },
			next_cursor: null,
			has_more: false,
		});
		expect(taskView.cleanup_status).toBe("pending");
		expect(taskViewSchema.safeParse({ ...taskView, status: "idle" }).success).toBe(false);
		expect(taskViewSchema.safeParse({ ...taskView, status: "canceled" }).success).toBe(true);
		expect(taskViewSchema.safeParse({ ...taskView, status: "idle", cleanup_status: "completed" }).success).toBe(true);
		expect(object(component("RouterTaskView").not).properties).toMatchObject({
			status: { enum: ["idle"] },
			cleanup_status: { enum: ["pending"] },
		});
		expect(ROUTER_PREDECESSOR_CANCEL_REASON).toBe("PREDECESSOR_FAILED");
		expect(
			taskEventsResponseSchema.safeParse({
				events: [
					{
						sequence: "9",
						operation_id: null,
						type: "task.cleanup_completed",
						schema_version: 1,
						payload: {},
						created_at: now,
					},
				],
				next_cursor: null,
				has_more: false,
			}).success,
		).toBe(true);
		expect(array(component("RouterTaskEventsResponse").required)).toEqual(["events", "next_cursor", "has_more"]);
	});

	test("error codes are unique per HTTP status and every documented pairing is legal", () => {
		const errorProperties = object(object(component("RouterError").properties).error);
		const documented = new Set(array(object(object(errorProperties.properties).code).enum));
		const expectedStatus = new Map<string, number>(ROUTER_ERROR_CODES.map((item) => [item.code, item.status]));
		expectedStatus.set("NOT_FOUND", 404);
		expectedStatus.set("CONFLICT", 409);
		for (const path of Object.keys(routerOpenApi.paths)) {
			for (const method of Object.keys(object(object(routerOpenApi.paths)[path]))) {
				const responses = object(operation(path, method).responses);
				for (const status of Object.keys(responses)) {
					for (const code of array(object(responses[status])["x-error-codes"] ?? [])) {
						expect(expectedStatus.get(String(code))).toBe(Number(status));
						expect(documented.has(code)).toBe(true);
					}
				}
			}
		}
		const known = new Set<string>(ROUTER_ERROR_CODES.map((item) => item.code));
		for (const code of [
			"CAPABILITY_SCOPE_REQUIRED",
			"CREDENTIAL_WINDOW_EXPIRED",
			"MCP_SERVER_NOT_FOUND",
			"QUEUE_FULL",
		]) {
			expect(known.has(code)).toBe(true);
		}
		expect(expectedStatus.get("QUEUE_FULL")).toBe(429);
		expect(known.has("QUEUE_LIMIT_REACHED")).toBe(false);
		expect(known.has(ROUTER_PREDECESSOR_CANCEL_REASON)).toBe(false);
		const mcpList = object(object(routerOpenApi.paths)["/api/aaas/v1/mcp-servers"]);
		const mcpResponses = object(object(mcpList.get).responses);
		expect(array(object(mcpResponses["401"])["x-error-codes"])).toEqual(["UNAUTHORIZED"]);
		expect(array(object(mcpResponses["500"])["x-error-codes"])).toEqual(["INTERNAL"]);
	});

	test("MCP discovery schemas match the retained summary/detail contract", () => {
		const summary = {
			server_id: serverId,
			name: "alpha",
			description: null,
			revision: 1,
			tool_count: 2,
			authentication: "bearer",
			credential_requirements: { tool_credential: false },
		};
		expect(routerMcpServerSummarySchema.parse(summary).tool_count).toBe(2);
		const detail = routerMcpServerDetailSchema.parse({
			...summary,
			tools: [{ name: "lookup", description: null, input_schema: { type: "object" } }],
			required_credentials: [],
		});
		expect(detail.tools).toHaveLength(1);
		expect(array(component("RouterMcpServerDetail").required)).toContain("required_credentials");
		expect(array(object(object(component("RouterMcpServerSummary").properties).authentication).enum)).toContain(
			"api_key",
		);
	});

	test("capability scope header and public pagination defaults are declared", () => {
		const headers = array(operation(ROUTER_PATHS[0], "post").parameters).map((item) => object(item).name);
		expect(headers).toContain(ROUTER_CAPABILITY_HEADER);
		for (const path of [ROUTER_PATHS[2], ROUTER_PATHS[4]]) {
			const parameters = array(operation(path, "get").parameters);
			const limit = parameters.find((item) => object(item).name === "limit");
			expect(object(object(limit).schema)).toMatchObject({
				default: ROUTER_PAGE_LIMIT.default,
				maximum: ROUTER_PAGE_LIMIT.max,
			});
		}
	});
});

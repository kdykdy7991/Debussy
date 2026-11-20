import { z } from "zod";

/**
 * Router V1 target contracts. Phase 1 publishes schemas, the OpenAPI document and
 * error codes only; no HTTP route claims these paths yet. The legacy AaaS V1
 * contracts in `api-key-contracts.ts` and `api-documentation.ts` stay unchanged.
 */

export const ROUTER_BASE = "/api/aaas/v1";
export const ROUTER_CAPABILITY_HEADER = "x-router-capability-scope";
export const ROUTER_CAPABILITY_SCOPE = "router";

export const ROUTER_PATHS = [
	"/api/aaas/v1/tasks",
	"/api/aaas/v1/tasks/{id}/inputs",
	"/api/aaas/v1/tasks/{id}",
	"/api/aaas/v1/operations/{id}",
	"/api/aaas/v1/tasks/{id}/events",
	"/api/aaas/v1/tasks/{id}/cancel",
] as const;

/** Safe progress fields. Anything else (thinking, raw tool args/results) is forbidden. */
export const ROUTER_PROGRESS_FIELDS = ["stage", "stage_at", "tools_completed", "tools_total", "updated_at"] as const;

export const ROUTER_TASK_STATUSES = ["active", "idle", "canceled"] as const;
export const ROUTER_OPERATION_STATUSES = ["queued", "running", "completed", "failed", "canceled"] as const;
/** One History sequence; raw message/tool facts are stored but not publicly projected. */
export const ROUTER_EVENT_TYPES = [
	"task.created",
	"operation.accepted",
	"operation.queued",
	"operation.started",
	"operation.progress",
	"operation.completed",
	"operation.failed",
	"operation.canceled",
	"task.canceled",
	"task.cleanup_completed",
	"context.committed",
	"user.message",
	"assistant.message",
	"tool.call",
	"tool.result",
] as const;
export const ROUTER_PUBLIC_EVENT_TYPES = [
	"task.created",
	"operation.accepted",
	"operation.queued",
	"operation.started",
	"operation.progress",
	"operation.completed",
	"operation.failed",
	"operation.canceled",
	"task.canceled",
	"task.cleanup_completed",
	"context.committed",
] as const;
/** Pagination is part of the frozen contract, not a server implementation detail. */
export const ROUTER_PAGE_LIMIT = { default: 50, max: 200 } as const;
/** Queue wait defaults to one hour; platform credential ceiling is 30 minutes. */
export const ROUTER_TIME_BUDGETS = { queueMs: 3_600_000, credentialMaxMs: 1_800_000 } as const;
/** Queued Operations are canceled with this reason; new inputs remain allowed after failure. */
export const ROUTER_PREDECESSOR_CANCEL_REASON = "PREDECESSOR_FAILED";

export const ROUTER_ERROR_CODES = [
	{ status: 400, code: "INVALID_REQUEST", description: "请求结构或字段无效" },
	{ status: 400, code: "MISSING_CREDENTIAL", description: "缺少冻结能力要求的凭据维度" },
	{ status: 400, code: "INVALID_CREDENTIAL", description: "多余、重复或不合法的凭据" },
	{ status: 401, code: "UNAUTHORIZED", description: "API Key 缺失、无效、禁用或撤销" },
	{ status: 403, code: "CAPABILITY_SCOPE_REQUIRED", description: "双入口 Key 未显式选择 Router 能力范围" },
	{ status: 403, code: "CAPABILITY_UNAVAILABLE", description: "直接能力未登记、引用失效或不完整" },
	{ status: 404, code: "TASK_NOT_ACCESSIBLE", description: "Task 不存在或不属于当前 Key" },
	{ status: 404, code: "OPERATION_NOT_ACCESSIBLE", description: "Operation 不存在或不属于当前 Key" },
	{ status: 404, code: "MCP_SERVER_NOT_FOUND", description: "Server 不在当前有效能力范围内" },
	{ status: 409, code: "IDEMPOTENCY_CONFLICT", description: "同幂等键对应不同请求内容" },
	{ status: 409, code: "TASK_CANCELED", description: "Task 已永久取消" },
	{ status: 413, code: "PAYLOAD_TOO_LARGE", description: "请求体超过 96 KiB" },
	{ status: 429, code: "QUEUE_FULL", description: "Task 等待预算已满，稍后可重新提交" },
	{ status: 422, code: "CREDENTIAL_WINDOW_EXPIRED", description: "凭据窗口保守检查失败" },
	{ status: 500, code: "INTERNAL", description: "操作失败，请检查服务状态或配置冲突" },
] as const;

export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number]["code"];

const id = z.string().uuid();
const cursor = z.string().min(1).max(2048);
const serverId = z.string().regex(/^mcp_[0-9a-f-]{36}$/);
const secret = z.string().min(4).max(4096);
const finiteInteger = z.number().int().min(0);

/** Layered request credentials; values are sealed before persistence. */
export const routerCredentialsSchema = z
	.object({
		servers: z
			.record(
				serverId,
				z
					.object({
						tool_credential: secret,
					})
					.strict(),
			)
			.default({}),
	})
	.strict();

const inputText = (field: "prompt" | "input") =>
	z
		.string()
		.min(1)
		.max(48_000)
		.refine((text) => text.trim().length > 0, `${field} 不能为空白`);

export const createTaskRequestSchema = z
	.object({
		prompt: inputText("prompt"),
		mcp_servers: z.array(serverId).max(8).optional(),
		credentials: routerCredentialsSchema.optional().default({ servers: {} }),
	})
	.strict();

export const appendInputRequestSchema = z
	.object({
		input: inputText("input"),
		mcp_servers: z.array(serverId).max(8).optional(),
		credentials: routerCredentialsSchema.optional().default({ servers: {} }),
	})
	.strict();

export const cancelTaskRequestSchema = z.object({ reason: z.string().min(1).max(2000).optional() }).strict();

const pageLimit = z.number().int().min(1).max(ROUTER_PAGE_LIMIT.max).default(ROUTER_PAGE_LIMIT.default);

export const taskQuerySchema = z.object({ after: cursor.optional(), limit: pageLimit }).strict();

export const eventsQuerySchema = z.object({ after: cursor.optional(), limit: pageLimit }).strict();

export const routerProgressFieldsSchema = z
	.object({
		stage: z.string().min(1).max(64),
		stage_at: z.string().datetime().optional(),
		tools_completed: finiteInteger.optional(),
		tools_total: finiteInteger.optional(),
		updated_at: z.string().datetime(),
	})
	.strict();

export const routerProgressSchema = routerProgressFieldsSchema.refine(
	(value) =>
		value.tools_completed === undefined ||
		value.tools_total === undefined ||
		value.tools_completed <= value.tools_total,
	"tools_completed 不能大于 tools_total",
);

const taskStatus = z.enum(ROUTER_TASK_STATUSES);
const operationStatus = z.enum(ROUTER_OPERATION_STATUSES);
const usageView = z
	.object({
		complete: z.boolean(),
		total_tokens: z.number().int().min(0).nullable(),
		input_tokens: z.number().int().min(0).nullable(),
		output_tokens: z.number().int().min(0).nullable(),
	})
	.strict();
const operationSummary = z
	.object({
		id: id,
		sequence: z.number().int().min(1),
		status: operationStatus,
		duplicate: z.boolean().default(false),
	})
	.strict();

const flatOperationFields = {
	operation_id: id,
	operation_status: operationStatus,
	ordinal: z.number().int().min(1),
	duplicate: z.boolean(),
};

export const createTaskResponseSchema = z.object({ task_id: id, status: taskStatus, ...flatOperationFields }).strict();

export const appendInputResponseSchema = z.object({ task_id: id, ...flatOperationFields }).strict();

export const taskViewSchema = z
	.object({
		id,
		status: taskStatus,
		cleanup_status: z.enum(["none", "pending", "completed"]),
		cleanup_reason: z.string().nullable(),
		latest_result: z.object({ operation_id: id, result: z.string() }).strict().nullable(),
		latest_operation: z
			.object({ id, status: operationStatus, error: z.object({ code: z.string() }).strict().nullable() })
			.strict()
			.nullable(),
		operations: z.array(operationSummary),
		usage: z
			.object({
				complete: z.boolean(),
				known_totals: z.record(z.string(), z.number().int().min(0)),
				unknown_operations: z.number().int().min(0),
			})
			.strict(),
		next_cursor: cursor.nullable(),
		has_more: z.boolean(),
	})
	.strict()
	.refine((task) => task.status !== "idle" || task.cleanup_status !== "pending", {
		path: ["cleanup_status"],
		message: "待清理的 Task 状态必须是 active 或 canceled",
	});

export const operationViewSchema = z
	.object({
		id,
		task_id: id,
		sequence: z.number().int().min(1),
		status: operationStatus,
		input: z.string(),
		result: z.string().nullable(),
		error: z.object({ code: z.string() }).strict().nullable(),
		cancel_reason: z.string().nullable(),
		progress: routerProgressSchema.nullable(),
		usage: usageView,
		queued_at: z.string().datetime(),
		started_at: z.string().datetime().nullable(),
		ended_at: z.string().datetime().nullable(),
	})
	.strict();

export const routerEventCursorSchema = z.string().regex(/^\d+$/);
const publicEventBase = {
	sequence: routerEventCursorSchema,
	operation_id: id.nullable(),
	schema_version: z.number().int().min(1),
	created_at: z.string().datetime(),
};
const publicEvent = <T extends z.ZodTypeAny>(type: (typeof ROUTER_PUBLIC_EVENT_TYPES)[number], payload: T) =>
	z.object({ ...publicEventBase, type: z.literal(type), payload }).strict();

/** Public events are tagged; each type binds a strict payload. Raw History events never reach here. */
export const taskPublicEventSchema = z.discriminatedUnion("type", [
	publicEvent("task.created", z.object({}).strict()),
	publicEvent("operation.accepted", z.object({}).strict()),
	publicEvent("operation.queued", z.object({}).strict()),
	publicEvent("operation.started", z.object({}).strict()),
	publicEvent("operation.progress", routerProgressFieldsSchema),
	publicEvent("operation.completed", z.object({ result: z.string().optional() }).strict()),
	publicEvent("operation.failed", z.object({ error: z.object({ code: z.string() }).strict() }).strict()),
	publicEvent("operation.canceled", z.object({ reason: z.string().optional() }).strict()),
	publicEvent("task.canceled", z.object({ reason: z.string().optional() }).strict()),
	publicEvent("task.cleanup_completed", z.object({}).strict()),
	publicEvent("context.committed", z.object({ sequence: routerEventCursorSchema }).strict()),
]);

export const taskEventsResponseSchema = z
	.object({
		events: z.array(taskPublicEventSchema),
		next_cursor: cursor.nullable(),
		has_more: z.boolean(),
	})
	.strict();

export const cancelTaskResponseSchema = z
	.object({
		task_id: id,
		status: z.literal("canceled"),
		canceled_at: z.string().datetime(),
		cleanup_pending: z.boolean(),
	})
	.strict();

/** MCP discovery keeps the published AaaS V1 shape while Router reuse is still pending. */
export const routerMcpServerSummarySchema = z
	.object({
		server_id: serverId,
		name: z.string().min(1),
		description: z.string().nullable(),
		revision: z.number().int().min(1),
		tool_count: z.number().int().min(0),
		authentication: z.enum(["none", "bearer", "api_key"]),
		credential_requirements: z.object({ tool_credential: z.boolean() }).strict(),
	})
	.strict();

export const routerMcpServerDetailSchema = routerMcpServerSummarySchema.extend({
	tools: z.array(
		z
			.object({
				name: z.string().min(1).max(200),
				description: z.string().nullable(),
				input_schema: z.record(z.string(), z.unknown()),
			})
			.strict(),
	),
	required_credentials: z.array(
		z
			.object({
				credential_id: z.string().min(1).max(100),
				scope: z.enum(["connection", "tool"]),
				tool_name: z.string().min(1).max(200).optional(),
				parameter: z.string().min(1).max(200).optional(),
				required: z.boolean(),
			})
			.strict(),
	),
});

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type AppendInputRequest = z.infer<typeof appendInputRequestSchema>;
export type RouterProgress = z.infer<typeof routerProgressSchema>;

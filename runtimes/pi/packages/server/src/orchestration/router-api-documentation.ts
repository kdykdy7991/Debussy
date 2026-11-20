import {
	ROUTER_CAPABILITY_HEADER,
	ROUTER_ERROR_CODES,
	ROUTER_OPERATION_STATUSES,
	ROUTER_PAGE_LIMIT,
	ROUTER_PATHS,
	ROUTER_PROGRESS_FIELDS,
	ROUTER_PUBLIC_EVENT_TYPES,
	ROUTER_TASK_STATUSES,
} from "./router-contracts.ts";

const taskId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const requestId = "req_example_router";
const queuedAt = "2026-11-19T02:00:00.000Z";
const endedAt = "2026-11-19T02:00:02.000Z";
const result = "已记住测试代号 BLUE-47。";
const usage = { total_tokens: 125, input_tokens: 108, output_tokens: 17 };
const knowledgeServer = {
	server_id: "mcp_11111111-1111-4111-8111-111111111111",
	name: "知识库（示例）",
	description: null,
	revision: 3,
	tool_count: 1,
	authentication: "none",
	credential_requirements: { tool_credential: false },
};
const ticketServer = {
	server_id: "mcp_22222222-2222-4222-8222-222222222222",
	name: "智慧工单（示例）",
	description: null,
	revision: 5,
	tool_count: 1,
	authentication: "bearer",
	credential_requirements: { tool_credential: true },
};
const ok = <T>(data: T) => ({ data, requestId });

const uuid = { type: "string", format: "uuid" };
const cursor = { type: "string", minLength: 1, maxLength: 19, pattern: "^[0-9]+$" };
const dateTime = { type: "string", format: "date-time" };
const serverId = { type: "string", pattern: "^mcp_[0-9a-f-]{36}$" };
const envelope = <T extends object>(data: T) => ({
	type: "object",
	required: ["data", "requestId"],
	properties: { data, requestId: { type: "string", description: "请求追踪 ID，提交工单时请附上此值。" } },
});
const errorHelp = {
	INVALID_REQUEST: "检查 JSON、字段类型与长度、UUID、游标及必填请求头。修正后提交。",
	MISSING_CREDENTIAL: "查询 Server 详情，为已选择且要求业务凭据的 Server 提供 tool_credential。",
	INVALID_CREDENTIAL: "移除未选择或无需凭据的 Server 条目，检查凭据长度，勿把凭据放入输入或幂等键。",
	UNAUTHORIZED: "检查 Authorization 的 Bearer 格式及 Key 是否启用，必要时向管理员获取新 Key。",
	CAPABILITY_SCOPE_REQUIRED: "写入时将范围头设为 router。发现接口查询 Router 能力时也使用该值。",
	CAPABILITY_UNAVAILABLE: "用同一 Key 重新发现 MCP，检查选择范围，请管理员核对 Key 的直接能力及授权版本。",
	TASK_NOT_ACCESSIBLE: "检查 Task ID 和签发该 Task 的 Key。",
	OPERATION_NOT_ACCESSIBLE: "从受理响应取 Operation ID，并用原 Key 查询。",
	NOT_FOUND: "用同一 Key 和能力范围重新获取 Server 列表，核对 server_id。",
	IDEMPOTENCY_CONFLICT: "同一业务请求重试时保留原正文。新请求使用新幂等键。",
	TASK_CANCELED: "永久取消的 Task 无法追加输入，需要新建 Task。",
	PAYLOAD_TOO_LARGE: "把 JSON 请求体缩减到 96 KiB 以内。",
	CREDENTIAL_WINDOW_EXPIRED: "等待前序执行结束后重试。如仍失败，请管理员核对运行策略。",
	QUEUE_FULL: "等待前序 Operation 完成后带原幂等键重试。",
	INTERNAL: "退避重试。写入重试沿用原幂等键，持续失败时提供 requestId 给管理员。",
	CONFLICT: "等待并发操作结束后重试发现查询。",
} satisfies Record<string, string>;

const errorMessages: Partial<Record<keyof typeof errorHelp, string>> = {
	INVALID_REQUEST: "请求不符合 Router 契约",
	MISSING_CREDENTIAL: "缺少工具凭据",
	INVALID_CREDENTIAL: "该 Server 不接受工具凭据",
	UNAUTHORIZED: "API Key 无效",
	CAPABILITY_SCOPE_REQUIRED: "双入口 Key 必须显式选择 Router 能力范围",
	CAPABILITY_UNAVAILABLE: "Router 直接能力未登记、引用失效或规则缺失",
	TASK_NOT_ACCESSIBLE: "Task 不存在或不可访问",
	OPERATION_NOT_ACCESSIBLE: "Operation 不存在或不可访问",
	NOT_FOUND: "MCP Server 不存在或不可访问",
	IDEMPOTENCY_CONFLICT: "幂等键冲突",
	TASK_CANCELED: "Task 已永久取消",
	PAYLOAD_TOO_LARGE: "请求体无效或过大",
	CREDENTIAL_WINDOW_EXPIRED: "凭据有效期不足以覆盖排队预算",
	QUEUE_FULL: "等待队列已满",
	INTERNAL: "操作失败",
	CONFLICT: "请求发生并发冲突",
};
const errorResponse = (description: string, codes: readonly (keyof typeof errorHelp)[]) => ({
	description,
	"x-error-codes": [...codes],
	content: {
		"application/json": {
			schema: { $ref: "#/components/schemas/RouterError" },
			examples: Object.fromEntries(
				codes.map((code) => [
					code,
					{
						summary: code,
						description: errorHelp[code],
						value: {
							error: {
								code,
								message: errorMessages[code] ?? description,
								requestId,
								retryable: code === "INTERNAL",
							},
						},
					},
				]),
			),
		},
	},
});

const commonCodes = ["UNAUTHORIZED", "INVALID_REQUEST", "PAYLOAD_TOO_LARGE", "INTERNAL"] as const;
const writeCodes = [...commonCodes, "MISSING_CREDENTIAL", "INVALID_CREDENTIAL", "IDEMPOTENCY_CONFLICT"] as const;
const flatOperationProperties = {
	operation_id: { ...uuid, description: "Operation ID，用于查询本轮状态和结果。" },
	operation_status: {
		type: "string",
		enum: ["queued"],
		description: "受理响应固定为 queued，包括幂等重放。实时状态以 Operation 查询为准。",
	},
	ordinal: { type: "integer", minimum: 1, description: "本次 Operation 在 Task 内的序号，从 1 开始。" },
	duplicate: { type: "boolean", description: "写入请求重放时为 true。查询 Task 的列表项固定为 false。" },
};
const flatOperationRequired = ["operation_id", "operation_status", "ordinal", "duplicate"];
const idParameter = {
	name: "id",
	in: "path",
	required: true,
	schema: uuid,
	description: "使用受理响应返回的 task_id。",
};
const idempotencyParameter = {
	name: "Idempotency-Key",
	in: "header",
	required: true,
	schema: { type: "string", minLength: 1, maxLength: 200, example: "create-79c88490-2640-4744-a6f7-604823222aec" },
	description:
		"去除首尾空白后须为 1–200 个字符。同一次写入重试时复用此键。创建按租户和 Key 隔离，追加按租户、Key 和 Task 隔离。",
};
const capabilityHeader = {
	name: ROUTER_CAPABILITY_HEADER,
	in: "header",
	required: false,
	schema: { type: "string", enum: ["router"], "x-conditionally-required": true },
	description: "双入口 Key 创建或追加时必填 router。Router-only Key 可省略，默认使用 Router 直接能力。",
};

const discoveryScope = {
	...capabilityHeader,
	description:
		"查 Router 授权时，双入口 Key 传 router，省略会返回旧配置范围。Router-only Key 可省略，默认使用直接能力。此处描述 Router 查询方式。",
};
const requestIdHeader = {
	name: "X-Request-Id",
	in: "header",
	required: false,
	schema: { type: "string" },
	description: "自定义追踪 ID。去除首尾空白后回显；空白或省略则由平台生成。",
};
const sharedHeaders = [requestIdHeader];
const pageParameters = [
	{
		name: "after",
		in: "query",
		required: false,
		schema: cursor,
		description:
			"从上一页 next_cursor 继续，只返回序号大于该游标的记录。省略从头读取。游标是十进制字符串，最大 9223372036854775807，请原样传回。",
	},
	{
		name: "limit",
		in: "query",
		required: false,
		schema: { type: "integer", minimum: 1, maximum: ROUTER_PAGE_LIMIT.max, default: ROUTER_PAGE_LIMIT.default },
		description: "每页最多返回的条数。使用十进制整数。",
	},
];

const publicEvent = (type: string, payload: object) => ({
	type: "object",
	additionalProperties: false,
	required: ["sequence", "operation_id", "type", "schema_version", "payload", "created_at"],
	properties: {
		sequence: {
			type: "string",
			pattern: "^[0-9]+$",
			description: "Task 内递增的事件序号。用字符串保存，避免大整数精度丢失。",
		},
		operation_id: { ...uuid, nullable: true, description: "关联轮次的 ID；Task 级事件为 null。" },
		type: { type: "string", enum: [type] },
		schema_version: { type: "integer", minimum: 1, description: "事件载荷版本，当前为 1。" },
		payload,
		created_at: { ...dateTime, description: "事件记录时间。" },
	},
});
const emptyPayload = {
	type: "object",
	additionalProperties: false,
	properties: {},
	description: "此事件的 payload 固定为空对象 {}。",
};
const publicEventVariants = ROUTER_PUBLIC_EVENT_TYPES.map((type) => {
	if (type === "operation.progress") return publicEvent(type, { $ref: "#/components/schemas/RouterProgress" });
	if (type === "operation.failed")
		return publicEvent(type, {
			type: "object",
			additionalProperties: false,
			required: ["error"],
			properties: { error: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
		});
	if (type === "operation.completed")
		return publicEvent(type, {
			type: "object",
			additionalProperties: false,
			properties: { result: { type: "string" } },
		});
	if (type === "operation.canceled" || type === "task.canceled")
		return publicEvent(type, {
			type: "object",
			additionalProperties: false,
			properties: { reason: { type: "string" } },
		});
	if (type === "context.committed")
		return publicEvent(type, {
			type: "object",
			additionalProperties: false,
			required: ["sequence"],
			properties: { sequence: { type: "string", pattern: "^[0-9]+$" } },
		});
	return publicEvent(type, emptyPayload);
});

const requestSchemas = {
	RouterCreateTaskRequest: {
		type: "object",
		additionalProperties: false,
		required: ["prompt"],
		properties: {
			prompt: {
				type: "string",
				minLength: 1,
				maxLength: 48000,
				pattern: "\\S",
				description: "第一条普通用户输入。原样保留，至少含一个非空白字符，长度按 JavaScript UTF-16 代码单元计。",
			},
			mcp_servers: {
				type: "array",
				items: serverId,
				maxItems: 8,
				description:
					"可选。省略使用当前 Key 授权的全部可用 MCP；[] 禁用 MCP；非空数组仅启用所列的已授权 Server，最多填写 8 项。每次执行独立选择。",
			},
			credentials: {
				allOf: [{ $ref: "#/components/schemas/RouterCredentials" }],
				"x-conditionally-required": true,
				description:
					"条件必填。只要选中的 Server 有业务凭据要求，即使模型最终没有调用该工具，也须在受理时提供。省略视为无凭据。",
			},
		},
	},
	RouterAppendInputRequest: {
		type: "object",
		additionalProperties: false,
		required: ["input"],
		properties: {
			input: {
				type: "string",
				minLength: 1,
				maxLength: 48000,
				pattern: "\\S",
				description:
					"后续普通用户输入，可修正目标。原样保留，至少含一个非空白字符，长度按 JavaScript UTF-16 代码单元计。",
			},
			mcp_servers: {
				type: "array",
				items: serverId,
				maxItems: 8,
				description:
					"可选。省略使用当前 Key 授权的全部可用 MCP；[] 禁用 MCP；非空数组仅启用所列的已授权 Server，最多填写 8 项。每次执行独立选择。",
			},
			credentials: {
				allOf: [{ $ref: "#/components/schemas/RouterCredentials" }],
				"x-conditionally-required": true,
				description:
					"条件必填。只要选中的 Server 有业务凭据要求，即使模型最终没有调用该工具，也须在受理时提供。省略视为无凭据。",
			},
		},
	},
	RouterCancelTaskRequest: {
		type: "object",
		additionalProperties: false,
		properties: {
			reason: {
				type: "string",
				minLength: 1,
				maxLength: 2000,
				default: "USER_CANCELED",
				description: "记录到 Task 的取消说明。公开取消事件使用 USER_CANCELED。",
			},
		},
	},
};

const componentSchemas = {
	...requestSchemas,
	RouterCredentials: {
		type: "object",
		additionalProperties: false,
		default: { servers: {} },
		description: "MCP 连接凭据由平台配置。",
		properties: {
			servers: {
				type: "object",
				description:
					"以 MCP 发现返回的 server_id 为键，格式为 mcp_ 加 36 位小写十六进制字符或连字符。只为已选择且要求业务凭据的 Server 提供条目。省略时为空对象。",
				default: {},
				"x-map-key-pattern": serverId.pattern,
				additionalProperties: {
					type: "object",
					additionalProperties: false,
					required: ["tool_credential"],
					properties: {
						tool_credential: {
							type: "string",
							minLength: 4,
							maxLength: 4096,
							writeOnly: true,
							description:
								"每个 Server 条目内必填。纯凭据值，按该业务系统的要求获取。平台按规则注入敏感工具参数，每次 Operation 单独提供。",
						},
					},
				},
			},
		},
	},
	RouterProgress: {
		type: "object",
		additionalProperties: false,
		required: ["stage", "updated_at"],
		"x-field-whitelist": [...ROUTER_PROGRESS_FIELDS],
		properties: {
			stage: {
				type: "string",
				minLength: 1,
				maxLength: 64,
				description: "平台提供的进度阶段，例如 tools；应容忍新增阶段。",
			},
			stage_at: { ...dateTime, description: "阶段的时间戳，可省略。" },
			tools_completed: { type: "integer", minimum: 0, description: "已完成工具数，未提供时表示该阶段无此统计。" },
			tools_total: { type: "integer", minimum: 0, description: "已知工具总数，若同时有完成数，完成数不大于总数。" },
			updated_at: { ...dateTime, description: "最近进度更新时间。" },
		},
	},
	RouterOperationSummary: {
		type: "object",
		additionalProperties: false,
		required: ["id", "sequence", "status", "duplicate"],
		properties: {
			id: uuid,
			sequence: { type: "integer", minimum: 1 },
			status: { type: "string", enum: [...ROUTER_OPERATION_STATUSES] },
			duplicate: { type: "boolean", description: "写入请求重放时为 true。查询 Task 的列表项固定为 false。" },
		},
	},
	RouterUsage: {
		type: "object",
		additionalProperties: false,
		required: ["complete", "total_tokens", "input_tokens", "output_tokens"],
		properties: {
			complete: { type: "boolean", description: "是否已完整采集用量。" },
			total_tokens: { type: "integer", minimum: 0, nullable: true, description: "总 token 数，未知时为 null。" },
			input_tokens: { type: "integer", minimum: 0, nullable: true, description: "输入 token 数，未知时为 null。" },
			output_tokens: { type: "integer", minimum: 0, nullable: true, description: "输出 token 数，未知时为 null。" },
		},
	},
	RouterTaskView: {
		type: "object",
		additionalProperties: false,
		description:
			"active 表示有排队、运行或执行占用；idle 表示无等待且无占用；canceled 表示永久取消，资源清理可能仍在进行。",
		not: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["idle"] },
				cleanup_status: { type: "string", enum: ["pending"] },
			},
		},
		required: [
			"id",
			"status",
			"cleanup_status",
			"cleanup_reason",
			"latest_result",
			"latest_operation",
			"operations",
			"usage",
			"next_cursor",
			"has_more",
		],
		properties: {
			id: uuid,
			status: { type: "string", enum: [...ROUTER_TASK_STATUSES] },
			cleanup_status: {
				type: "string",
				enum: ["none", "pending", "completed"],
				description: "未取消为 none，取消后等待执行释放为 pending，释放完毕为 completed。",
			},
			cleanup_reason: {
				type: "string",
				nullable: true,
				description: "取消后等待执行实例结束时提供说明，其余为 null。",
			},
			latest_result: {
				description: "最近一次成功的结果，无成功轮次时为 null。后续失败时保留该值。",
				type: "object",
				nullable: true,
				required: ["operation_id", "result"],
				properties: {
					operation_id: { ...uuid, description: "Operation ID，用于查询本轮状态和结果。" },
					result: { type: "string" },
				},
			},
			latest_operation: {
				description: "最后受理的 Operation 摘要，独立于分页。",
				type: "object",
				nullable: true,
				required: ["id", "status", "error"],
				properties: {
					id: uuid,
					status: { type: "string", enum: [...ROUTER_OPERATION_STATUSES] },
					error: {
						type: "object",
						nullable: true,
						additionalProperties: false,
						required: ["code"],
						properties: { code: { type: "string", description: "异步执行错误码。" } },
						description: "失败时提供，其他状态为 null。",
					},
				},
			},
			operations: { type: "array", items: { $ref: "#/components/schemas/RouterOperationSummary" } },
			usage: {
				type: "object",
				required: ["complete", "known_totals", "unknown_operations"],
				properties: {
					complete: { type: "boolean", description: "是否已完整采集用量。" },
					known_totals: {
						type: "object",
						properties: {
							total_tokens: { type: "integer", minimum: 0, description: "已知总 token 数。" },
							input_tokens: { type: "integer", minimum: 0, description: "已知输入 token 数。" },
							output_tokens: { type: "integer", minimum: 0, description: "已知输出 token 数。" },
						},
						additionalProperties: false,
						description: "仅返回已有统计的维度。部分 Operation 缺少完整用量时，已知值依然累加。",
					},
					unknown_operations: { type: "integer", minimum: 0, description: "用量尚未完整采集的 Operation 数量。" },
				},
			},
			next_cursor: { ...cursor, nullable: true, description: "存在下一页时为该页最后一条的游标，否则为 null。" },
			has_more: { type: "boolean", description: "是否还有下一页。" },
		},
	},
	RouterOperationView: {
		type: "object",
		additionalProperties: false,
		required: [
			"id",
			"task_id",
			"sequence",
			"status",
			"input",
			"result",
			"error",
			"cancel_reason",
			"progress",
			"usage",
			"queued_at",
			"started_at",
			"ended_at",
		],
		properties: {
			id: uuid,
			task_id: { ...uuid, description: "Task ID，用于查询、追加输入和取消。" },
			sequence: { type: "integer", minimum: 1 },
			status: { type: "string", enum: [...ROUTER_OPERATION_STATUSES] },
			input: { type: "string", description: "本轮提交的 prompt 或 input 原文。" },
			result: {
				type: "string",
				nullable: true,
				description: "成功时为模型最终文本，可为空字符串；其他状态为 null。",
			},
			error: {
				type: "object",
				nullable: true,
				additionalProperties: false,
				required: ["code"],
				properties: { code: { type: "string", description: "异步执行错误码。" } },
				description: "失败时提供，其他状态为 null。",
			},
			cancel_reason: {
				type: "string",
				nullable: true,
				description: "取消时为 USER_CANCELED 或 PREDECESSOR_FAILED；未取消为 null。",
			},
			progress: {
				oneOf: [{ $ref: "#/components/schemas/RouterProgress" }, { type: "object", nullable: true, enum: [null] }],
				description: "公开进度快照，无可用进度时为 null。",
			},
			usage: { $ref: "#/components/schemas/RouterUsage" },
			queued_at: { ...dateTime, description: "受理并排队的时间。" },
			started_at: { ...dateTime, nullable: true, description: "实际开始时间，尚未启动时为 null。" },
			ended_at: { ...dateTime, nullable: true, description: "进入终态的时间，尚未结束时为 null。" },
		},
	},
	RouterTaskEventsResponse: {
		type: "object",
		additionalProperties: false,
		required: ["events", "next_cursor", "has_more"],
		properties: {
			events: {
				type: "array",
				items: { oneOf: publicEventVariants },
				"x-public-event-types": [...ROUTER_PUBLIC_EVENT_TYPES],
			},
			next_cursor: { ...cursor, nullable: true, description: "存在下一页时为该页最后一条的游标，否则为 null。" },
			has_more: { type: "boolean", description: "是否还有下一页。" },
		},
	},
	RouterCancelTaskResponse: {
		type: "object",
		additionalProperties: false,
		required: ["task_id", "status", "canceled_at", "cleanup_pending"],
		properties: {
			task_id: { ...uuid, description: "Task ID，用于查询、追加输入和取消。" },
			status: { type: "string", enum: ["canceled"] },
			canceled_at: { ...dateTime, description: "首次取消生效时间。" },
			cleanup_pending: { type: "boolean", description: "为 true 表示仍等执行实例释放资源，可继续查询 Task。" },
		},
	},
	RouterMcpServerSummary: {
		type: "object",
		additionalProperties: false,
		required: [
			"server_id",
			"name",
			"description",
			"revision",
			"tool_count",
			"authentication",
			"credential_requirements",
		],
		properties: {
			server_id: { ...serverId, description: "公开 Server ID，用于查详情及选择本轮 MCP。" },
			name: { type: "string", minLength: 1, description: "Server 展示名。" },
			description: { type: "string", nullable: true, description: "可公开的描述，无可用描述时为 null。" },
			revision: { type: "integer", minimum: 1, description: "当前 Key 授权的 Server 修订版本。" },
			tool_count: { type: "integer", minimum: 0, description: "当前 Key 授权的工具数量。" },
			authentication: {
				type: "string",
				enum: ["none", "bearer", "api_key"],
				description: "平台与 Server 的连接认证方式，凭据由管理中心提供。",
			},
			credential_requirements: {
				type: "object",
				required: ["tool_credential"],
				properties: { tool_credential: { type: "boolean" } },
			},
		},
	},
	RouterMcpServerDetail: {
		type: "object",
		additionalProperties: false,
		required: [
			"server_id",
			"name",
			"description",
			"revision",
			"tool_count",
			"authentication",
			"credential_requirements",
			"tools",
			"required_credentials",
		],
		properties: {
			server_id: { ...serverId, description: "公开 Server ID，用于查详情及选择本轮 MCP。" },
			name: { type: "string", minLength: 1, description: "Server 展示名。" },
			description: { type: "string", nullable: true, description: "可公开的描述，无可用描述时为 null。" },
			revision: { type: "integer", minimum: 1, description: "当前 Key 授权的 Server 修订版本。" },
			tool_count: { type: "integer", minimum: 0, description: "当前 Key 授权的工具数量。" },
			authentication: {
				type: "string",
				enum: ["none", "bearer", "api_key"],
				description: "平台与 Server 的连接认证方式，凭据由管理中心提供。",
			},
			credential_requirements: {
				type: "object",
				required: ["tool_credential"],
				properties: { tool_credential: { type: "boolean" } },
			},
			tools: {
				type: "array",
				items: {
					type: "object",
					required: ["name", "description", "input_schema"],
					properties: {
						name: { type: "string", minLength: 1, maxLength: 200, description: "此 Server 中授权的工具名称。" },
						description: { type: "string", nullable: true, description: "可公开的描述，无可用描述时为 null。" },
						input_schema: {
							type: "object",
							additionalProperties: true,
							description: "工具公开的 JSON Schema，结构由工具决定。平台注入的敏感字段已移除。",
						},
					},
				},
			},
			required_credentials: {
				type: "array",
				items: {
					type: "object",
					required: ["credential_id", "scope", "required"],
					properties: {
						credential_id: {
							type: "string",
							minLength: 1,
							maxLength: 100,
							description: "平台的凭据映射标识，用于阅读详情。请求按 Server ID 提交业务凭据。",
						},
						scope: {
							type: "string",
							enum: ["tool"],
							description: "Router 范围仅列出工具业务凭据，固定为 tool。",
						},
						tool_name: {
							type: "string",
							minLength: 1,
							maxLength: 200,
							description: "此 Server 中授权的工具名称。",
						},
						parameter: {
							type: "string",
							minLength: 1,
							maxLength: 200,
							description: "由平台注入的敏感工具参数。Router 范围的工具规则会返回此值。",
						},
						required: { type: "boolean", description: "此规则要求提供凭据。Router 范围的工具规则为 true。" },
					},
				},
			},
		},
	},
	RouterError: {
		type: "object",
		required: ["error"],
		properties: {
			error: {
				type: "object",
				required: ["code", "message", "requestId", "retryable"],
				properties: {
					code: {
						type: "string",
						enum: Object.keys(errorHelp),
						description: "机器可读错误码，用于重试或修正请求。",
					},
					message: { type: "string", description: "当前错误的说明。请通过 code 分支处理。" },
					requestId: { type: "string", description: "请求追踪 ID，提交工单时请附上此值。" },
					retryable: { type: "boolean", description: "HTTP 状态为 5xx 时返回 true。429 应等候队列腾出后再试。" },
				},
			},
		},
	},
};

const writeParameters = [...sharedHeaders, idempotencyParameter, capabilityHeader];
const routerTag = "Router V1";

export const routerOpenApi = {
	openapi: "3.0.3",
	info: {
		title: "Router V1 API",
		version: "1.0.0",
	},
	security: [{ ApiKey: [] }],
	tags: [{ name: routerTag }, { name: "MCP 发现" }],
	paths: {
		[ROUTER_PATHS[0]]: {
			post: {
				tags: [routerTag],
				summary: "创建 Task 并受理首个 Operation",
				operationId: "routerCreateTask",
				description:
					"prompt 是第一条普通 User 输入。返回 201 代表已受理，使用返回的 operation_id 查询执行状态和结果。mcp_servers 传空数组可进行纯模型测试。",
				parameters: writeParameters,
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/RouterCreateTaskRequest" },
							examples: {
								model: {
									summary: "纯模型任务",
									value: { prompt: "记录本轮测试代号 BLUE-47。", mcp_servers: [] },
								},
								mcpWithoutCredential: {
									summary: "MCP 工具无需业务凭据",
									value: {
										prompt: "使用知识库工具查询差旅报销时限，并注明来源。",
										mcp_servers: [knowledgeServer.server_id],
									},
								},
								mcp: {
									summary: "使用工具业务凭据",
									value: {
										prompt: "使用智慧工单工具查询示例工单 TK-2048 的处理状态。",
										mcp_servers: [ticketServer.server_id],
										credentials: {
											servers: {
												[ticketServer.server_id]: { tool_credential: "<替换为智慧工单业务 Token>" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"201": {
						description: "Task 与首个 Operation 已受理",
						content: {
							"application/json": {
								example: {
									data: {
										task_id: taskId,
										status: "active",
										operation_id: operationId,
										operation_status: "queued",
										ordinal: 1,
										duplicate: false,
									},
									requestId,
								},
								schema: envelope({
									type: "object",
									required: ["task_id", "status", ...flatOperationRequired],
									properties: {
										task_id: { ...uuid, description: "Task ID，用于查询、追加输入和取消。" },
										status: {
											type: "string",
											enum: ["active"],
											description: "受理响应固定为 active。实时状态以 Task 查询为准。",
										},
										...flatOperationProperties,
									},
								}),
							},
						},
					},
					"400": errorResponse("请求或凭据无效", ["INVALID_REQUEST", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL"]),
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"403": errorResponse("能力范围或能力不可用", ["CAPABILITY_SCOPE_REQUIRED", "CAPABILITY_UNAVAILABLE"]),
					"409": errorResponse("幂等冲突", ["IDEMPOTENCY_CONFLICT"]),
					"413": errorResponse("请求体过大", ["PAYLOAD_TOO_LARGE"]),
					"422": errorResponse("凭据窗口不足", ["CREDENTIAL_WINDOW_EXPIRED"]),
					"429": errorResponse("等待队列已满", ["QUEUE_FULL"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		[ROUTER_PATHS[1]]: {
			post: {
				tags: [routerTag],
				summary: "向 Task 追加普通 User 输入",
				operationId: "routerAppendInput",
				description:
					"后续输入与初始 prompt 同级，可改变目标。返回 202 表示已受理。用本次返回的 operation_id 查询结果，不要继续轮询上一轮 ID。",
				parameters: [idParameter, ...writeParameters],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/RouterAppendInputRequest" },
							examples: {
								model: {
									summary: "纯模型输入",
									value: { input: "请只回复上一轮的测试代号。", mcp_servers: [] },
								},
								mcpWithoutCredential: {
									summary: "MCP 工具无需业务凭据",
									value: {
										input: "继续查询知识库",
										mcp_servers: [knowledgeServer.server_id],
									},
								},
								mcp: {
									summary: "使用工具业务凭据",
									value: {
										input: "重新查询示例工单 TK-2048，概括最新进展。",
										mcp_servers: [ticketServer.server_id],
										credentials: {
											servers: {
												[ticketServer.server_id]: { tool_credential: "<替换为智慧工单业务 Token>" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"202": {
						description: "Operation 已排队",
						content: {
							"application/json": {
								example: {
									data: {
										task_id: taskId,
										operation_id: "44444444-4444-4444-8444-444444444444",
										operation_status: "queued",
										ordinal: 2,
										duplicate: false,
									},
									requestId,
								},
								schema: envelope({
									type: "object",
									required: ["task_id", ...flatOperationRequired],
									properties: {
										task_id: { ...uuid, description: "Task ID，用于查询、追加输入和取消。" },
										...flatOperationProperties,
									},
								}),
							},
						},
					},
					"400": errorResponse("请求或凭据无效", ["INVALID_REQUEST", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL"]),
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"403": errorResponse("能力范围或能力不可用", ["CAPABILITY_SCOPE_REQUIRED", "CAPABILITY_UNAVAILABLE"]),
					"404": errorResponse("Task 不可访问", ["TASK_NOT_ACCESSIBLE"]),
					"409": errorResponse("幂等或任务状态冲突", ["IDEMPOTENCY_CONFLICT", "TASK_CANCELED"]),
					"413": errorResponse("请求体过大", ["PAYLOAD_TOO_LARGE"]),
					"422": errorResponse("凭据窗口不足", ["CREDENTIAL_WINDOW_EXPIRED"]),
					"429": errorResponse("等待队列已满", ["QUEUE_FULL"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		[ROUTER_PATHS[2]]: {
			get: {
				tags: [routerTag],
				summary: "查询 Task",
				operationId: "routerGetTask",
				description: "返回推导状态、最近成功结果、最近 Operation、分页 Operation 摘要与累计 Usage。",
				parameters: [idParameter, ...sharedHeaders, ...pageParameters],
				responses: {
					"200": {
						description: "Task 视图",
						content: {
							"application/json": {
								schema: envelope({ $ref: "#/components/schemas/RouterTaskView" }),
								example: ok({
									id: taskId,
									status: "idle",
									cleanup_status: "none",
									cleanup_reason: null,
									latest_result: { operation_id: operationId, result },
									latest_operation: { id: operationId, status: "completed", error: null },
									operations: [{ id: operationId, sequence: 1, status: "completed", duplicate: false }],
									usage: { complete: true, known_totals: usage, unknown_operations: 0 },
									next_cursor: null,
									has_more: false,
								}),
							},
						},
					},
					"400": errorResponse("ID 或分页参数无效", ["INVALID_REQUEST"]),
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"404": errorResponse("Task 不可访问", ["TASK_NOT_ACCESSIBLE"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		[ROUTER_PATHS[3]]: {
			get: {
				tags: [routerTag],
				summary: "查询 Operation",
				operationId: "routerGetOperation",
				description:
					"轮询当前 Operation。queued 等待，running 执行中，completed 成功，failed 失败，canceled 已取消。后三者为终态。HTTP 200 仅表示查询成功，执行结果以 status、result、error、cancel_reason 为准。",
				parameters: [{ ...idParameter, description: "使用受理响应返回的 operation_id。" }, ...sharedHeaders],
				responses: {
					"200": {
						description: "Operation 视图",
						content: {
							"application/json": {
								schema: envelope({ $ref: "#/components/schemas/RouterOperationView" }),
								example: ok({
									id: operationId,
									task_id: taskId,
									sequence: 1,
									status: "completed",
									input: "记录本轮测试代号 BLUE-47。",
									result,
									error: null,
									cancel_reason: null,
									progress: null,
									usage: { complete: true, ...usage },
									queued_at: queuedAt,
									started_at: queuedAt,
									ended_at: endedAt,
								}),
							},
						},
					},
					"400": errorResponse("Operation ID 无效", ["INVALID_REQUEST"]),
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"404": errorResponse("Operation 不可访问", ["OPERATION_NOT_ACCESSIBLE"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		[ROUTER_PATHS[4]]: {
			get: {
				tags: [routerTag],
				summary: "按游标读取 Task 事件",
				operationId: "routerListTaskEvents",
				description:
					"按 Task 内序号递增返回公开事件，内部事件会造成序号跳跃。使用 next_cursor 翻页。追踪某轮结果请直接查询 Operation。",
				parameters: [idParameter, ...sharedHeaders, ...pageParameters],
				responses: {
					"200": {
						description: "事件页",
						content: {
							"application/json": {
								schema: envelope({ $ref: "#/components/schemas/RouterTaskEventsResponse" }),
								example: ok({
									events: [
										{
											sequence: "1",
											operation_id: null,
											type: "task.created",
											schema_version: 1,
											payload: {},
											created_at: queuedAt,
										},
										{
											sequence: "3",
											operation_id: operationId,
											type: "operation.accepted",
											schema_version: 1,
											payload: {},
											created_at: queuedAt,
										},
									],
									next_cursor: "3",
									has_more: true,
								}),
							},
						},
					},
					"400": errorResponse("ID 或分页参数无效", ["INVALID_REQUEST"]),
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"404": errorResponse("Task 不可访问", ["TASK_NOT_ACCESSIBLE"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		[ROUTER_PATHS[5]]: {
			post: {
				tags: [routerTag],
				summary: "永久取消 Task",
				operationId: "routerCancelTask",
				description:
					"永久关闭 Task，取消排队和运行中的 Operation。重复取消返回原取消时间，cleanup_pending 反映当前清理状态。可继续查询 Task、Operation 和事件。",
				parameters: [idParameter, ...sharedHeaders],
				requestBody: {
					required: false,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/RouterCancelTaskRequest" },
							example: { reason: "调用方已结束测试" },
						},
					},
				},
				responses: {
					"200": {
						description: "已提交取消",
						content: {
							"application/json": {
								schema: envelope({ $ref: "#/components/schemas/RouterCancelTaskResponse" }),
								example: ok({
									task_id: taskId,
									status: "canceled",
									canceled_at: endedAt,
									cleanup_pending: false,
								}),
							},
						},
					},
					"404": errorResponse("Task 不可访问", ["TASK_NOT_ACCESSIBLE"]),
					"400": errorResponse("ID 或请求体无效", ["INVALID_REQUEST"]),
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"413": errorResponse("请求体过大", ["PAYLOAD_TOO_LARGE"]),
					"409": errorResponse("数据库写入冲突", ["IDEMPOTENCY_CONFLICT"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		"/api/aaas/v1/mcp-servers": {
			get: {
				tags: ["MCP 发现"],
				summary: "查询可用 MCP Server 概要",
				operationId: "listApiKeyMcpServers",
				description:
					"使用同一个 API Key 查询已授权 Server 的 server_id、版本、工具数及 tool_credential 是否需要。双入口 Key 需传 X-Router-Capability-Scope: router。用返回的 server_id 查询详情；认证方式是平台连接配置，不需要调用方提供连接密钥。",
				parameters: [...sharedHeaders, discoveryScope],
				responses: {
					"200": {
						description: "Server 概要列表",
						content: {
							"application/json": {
								schema: envelope({
									type: "array",
									items: { $ref: "#/components/schemas/RouterMcpServerSummary" },
								}),
								example: ok([knowledgeServer, ticketServer]),
							},
						},
					},
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"403": errorResponse("能力范围或能力不可用", ["CAPABILITY_SCOPE_REQUIRED", "CAPABILITY_UNAVAILABLE"]),
					"409": errorResponse("并发冲突", ["CONFLICT"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
		"/api/aaas/v1/mcp-servers/{server_id}": {
			get: {
				tags: ["MCP 发现"],
				summary: "查询单个 MCP Server 详情",
				operationId: "getApiKeyMcpServer",
				description:
					"使用列表返回的 server_id 查询已授权工具、公开 input_schema 和 required_credentials。若 credential_requirements.tool_credential 为 true，在创建或追加请求的 credentials.servers[server_id].tool_credential 填入业务凭据。详情中的 parameter 表示平台注入的敏感参数，调用方无需将其写入 input。范围外返回 404。",
				parameters: [
					{
						name: "server_id",
						in: "path",
						required: true,
						schema: serverId,
						description: "用同一 Key 和能力范围从概要列表取得的 server_id。",
					},
					...sharedHeaders,
					discoveryScope,
				],
				responses: {
					"200": {
						description: "Server 详情",
						content: {
							"application/json": {
								schema: envelope({ $ref: "#/components/schemas/RouterMcpServerDetail" }),
								example: ok({
									...ticketServer,
									tools: [
										{
											name: "get_ticket",
											description: "按工单编号查询处理状态。",
											input_schema: {
												type: "object",
												properties: { ticket_id: { type: "string", description: "工单编号" } },
												required: ["ticket_id"],
											},
										},
									],
									required_credentials: [
										{
											credential_id: "ticket_token",
											scope: "tool",
											tool_name: "get_ticket",
											parameter: "access_token",
											required: true,
										},
									],
								}),
							},
						},
					},
					"401": errorResponse("身份无效", ["UNAUTHORIZED"]),
					"403": errorResponse("能力范围或能力不可用", ["CAPABILITY_SCOPE_REQUIRED", "CAPABILITY_UNAVAILABLE"]),
					"404": errorResponse("Server 不在有效范围内", ["NOT_FOUND"]),
					"409": errorResponse("并发冲突", ["CONFLICT"]),
					"500": errorResponse("服务失败", ["INTERNAL"]),
				},
			},
		},
	},
	components: {
		securitySchemes: {
			ApiKey: {
				type: "apiKey",
				in: "header",
				name: "Authorization",
				description: "使用 Bearer <API Key>，Key 必须启用且可访问当前资源。",
			},
		},
		schemas: componentSchemas,
	},
};

/** Error codes are declared once in `router-contracts.ts`; expose the mapping for review tooling. */
export const routerErrorCatalog = ROUTER_ERROR_CODES.map((item) => ({ ...item }));
export const routerDeclaredErrorCodes = new Set(ROUTER_ERROR_CODES.map((item) => item.code));
export const routerWriteErrorCodes = writeCodes;

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { HttpRequestHandler } from "../types.ts";
import { jsonBody } from "../web/http-shared.ts";
import { routerOpenApi } from "./router-api-documentation.ts";
import { routerDeveloperPage, routerDeveloperScript, routerDeveloperStyles } from "./router-developer-page.ts";

const base = "/api/aaas-docs";
const uuid = { type: "string", format: "uuid" };
const ref = {
	type: "object",
	required: ["id"],
	additionalProperties: false,
	properties: {
		type: { type: "string", minLength: 1, maxLength: 100 },
		id: { type: "string", minLength: 1, maxLength: 200 },
	},
};
const run = {
	type: "object",
	required: [
		"run_id",
		"integration_id",
		"external_ref",
		"metadata",
		"agent_version",
		"configuration_revision",
		"status",
		"result",
		"error",
		"created_at",
		"started_at",
		"completed_at",
	],
	properties: {
		run_id: uuid,
		integration_id: uuid,
		external_ref: { ...ref, nullable: true },
		metadata: { type: "object", nullable: true, additionalProperties: true },
		agent_version: { type: "string" },
		configuration_revision: { type: "integer" },
		status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled"] },
		result: { type: "string", nullable: true },
		error: { type: "object", nullable: true, properties: { code: { type: "string" } } },
		created_at: { type: "string", format: "date-time" },
		started_at: { type: "string", format: "date-time", nullable: true },
		completed_at: { type: "string", format: "date-time", nullable: true },
	},
};
const envelope = <T extends object>(data: T) => ({
	type: "object",
	required: ["data", "requestId"],
	properties: { data, requestId: { type: "string" } },
});
const runResponse = { description: "当前任务状态与结果", content: { "application/json": { schema: envelope(run) } } };
const errorResponse = (description: string) => ({
	description,
	content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});
const errors = {
	"400": errorResponse("请求参数或请求体无效"),
	"401": errorResponse("接入凭据无效或缺失"),
	"404": errorResponse("接入或任务不存在，或不属于当前接入"),
	"413": errorResponse("请求体超过 96 KiB"),
	default: {
		description: "请求失败；error.code 用于定位问题",
		content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
	},
};
const runId = { name: "run_id", in: "path", required: true, schema: uuid, description: "任务 ID" };
const mcpServerId = {
	name: "server_id",
	in: "path",
	required: true,
	schema: { type: "string", pattern: "^mcp_[0-9a-f-]{36}$" },
	description: "MCP Server ID",
};

/** Explicit public contract: never derive this list from the server's internal routes. */
export const aaasOpenApi = {
	openapi: "3.0.3",
	info: {
		title: "Agent 任务 API",
		version: "1.0.0",
		description:
			"业务系统通过接入凭据下发任务、查询结果和请求取消。接口调用需要 Bearer Token。不要在示例中填写真实密钥。",
	},
	security: [{ IntegrationToken: [] }],
	paths: {
		"/api/aaas/v1/integrations/{integration_id}/runs": {
			post: {
				summary: "下发任务",
				description:
					"异步接受任务，返回 run_id。prompt 和 input 二选一；使用相同幂等键重试时请求内容必须完全相同。请求体不超过 96 KiB。",
				operationId: "createRun",
				parameters: [
					{ name: "integration_id", in: "path", required: true, schema: uuid, description: "平台提供的接入 ID" },
					{
						name: "Idempotency-Key",
						in: "header",
						required: true,
						schema: { type: "string", minLength: 1, maxLength: 200 },
						description: "本次任务唯一标识，重试复用；重新执行使用新值",
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/CreateRun" },
							example: { prompt: "分析工单 TK001 并给出结论", external_ref: { type: "ticket", id: "TK001" } },
						},
					},
				},
				responses: {
					"202": {
						description: "任务已接受或幂等重放",
						content: {
							"application/json": {
								schema: envelope({
									type: "object",
									required: ["run_id", "status", "duplicate"],
									properties: {
										run_id: uuid,
										status: {
											type: "string",
											enum: ["queued", "running", "completed", "failed", "cancelled"],
										},
										duplicate: { type: "boolean" },
									},
								}),
							},
						},
					},
					"409": errorResponse("幂等键已用于不同的请求内容，或配置发生冲突"),
					...errors,
				},
			},
		},
		"/api/aaas/v1/runs/{run_id}": {
			get: {
				summary: "查询任务",
				operationId: "getRun",
				description: "建议每 2～5 秒轮询；completed、failed、cancelled 是终态。result 为模型原文字符串。",
				parameters: [runId],
				responses: { "200": runResponse, ...errors },
			},
		},
		"/api/aaas/v1/runs/{run_id}/cancel": {
			post: {
				summary: "请求取消任务",
				operationId: "cancelRun",
				description: "取消后不接受迟到结果，但不代表外部工具已停止或副作用可撤销。重复取消返回当前状态。",
				parameters: [runId],
				requestBody: {
					required: true,
					content: { "application/json": { schema: { type: "object" }, example: {} } },
				},
				responses: { "200": runResponse, ...errors },
			},
		},
	},
	components: {
		securitySchemes: {
			IntegrationToken: { type: "http", scheme: "bearer", description: "平台单独提供的 Integration Token" },
		},
		schemas: {
			CreateRun: {
				type: "object",
				additionalProperties: false,
				oneOf: [
					{ required: ["prompt"], not: { required: ["input"] } },
					{ required: ["input"], not: { required: ["prompt"] } },
				],
				properties: {
					prompt: {
						type: "string",
						minLength: 1,
						maxLength: 48000,
						pattern: "\\S",
						description: "本次完整提示词，覆盖默认系统提示词",
					},
					input: { type: "object", additionalProperties: true, description: "可选任务数据，与默认系统提示词配合" },
					external_ref: ref,
					metadata: {
						type: "object",
						additionalProperties: true,
						description: "追踪数据，序列化最多 8 KiB，不得包含凭据",
					},
					credentials: {
						type: "object",
						additionalProperties: { type: "string", minLength: 4, maxLength: 4096 },
						description:
							"任务工具凭据，名称以字母或下划线开头，后续仅允许字母、数字和下划线；仅通过安全渠道提供，不写入 prompt 或 metadata",
					},
				},
			},
			Error: {
				type: "object",
				required: ["error"],
				properties: {
					error: {
						type: "object",
						required: ["code", "message", "requestId", "retryable"],
						properties: {
							code: { type: "string" },
							message: { type: "string" },
							requestId: { type: "string" },
							retryable: { type: "boolean" },
						},
					},
				},
			},
		},
	},
};

const apiKeyMcpServer = { $ref: "#/components/schemas/ApiKeyMcpServer" };
const apiKeyMcpServerSummary = { $ref: "#/components/schemas/ApiKeyMcpServerSummary" };
const apiKeyRecord = {
	type: "object",
	required: ["keyId", "name", "status", "createdAt", "updatedAt", "orchestrationVersionId"],
	properties: {
		keyId: uuid,
		name: { type: "string" },
		status: { type: "string", enum: ["enabled", "disabled", "revoked"] },
		createdAt: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
		orchestrationVersionId: { ...uuid, nullable: true },
		routerCapabilityScope: { type: "string", enum: ["legacy", "dual", "router"] },
		directCapabilityRevision: { type: "integer", minimum: 0 },
	},
};

/**
 * Independent V1 API Key contract. Deliberately separate from `aaasOpenApi` so the
 * legacy Integration contract (three paths, IntegrationToken) is never rewritten.
 * Only the routes this server actually serves are documented.
 */
export const aaasApiKeyOpenApi = {
	openapi: "3.0.3",
	info: {
		title: "API Key 管理",
		version: "1.0.0",
	},
	security: [{ ApiKey: [] }],
	paths: {
		"/api/aaas/v1/mcp-servers": {
			get: {
				summary: "查询可用 MCP Server 列表",
				operationId: "listApiKeyMcpServers",
				description:
					"返回本 Key 有效配置中已配置且可用的 Server 概要：标识、名称、描述、生效 revision、实际允许工具数和凭据需求摘要。不包含工具列表、输入 Schema 或逐工具凭据明细；按需调用详情接口获取。",
				responses: {
					"200": {
						description: "当前可用的 MCP Server 概要",
						content: { "application/json": { schema: envelope({ type: "array", items: apiKeyMcpServerSummary }) } },
					},
					...errors,
				},
			},
		},
		"/api/aaas/v1/mcp-servers/{server_id}": {
			get: {
				summary: "查询单个 MCP Server 详情",
				operationId: "getApiKeyMcpServer",
				description:
					"按需返回指定 Server 的实际允许工具快照、描述、公开参数 Schema 和凭据需求。列表与详情使用同一有效配置解析；不在当前有效范围内的 Server 返回 404，不暴露其是否存在。敏感参数已从公开 Schema 移除；不返回任何凭据值。",
				parameters: [mcpServerId],
				responses: {
					"200": {
						description: "指定 Server 的完整元数据",
						content: { "application/json": { schema: envelope(apiKeyMcpServer) } },
					},
					...errors,
				},
			},
		},
		"/api/admin/v1/aaas/keys": {
			get: {
				security: [{ AdminBearer: [] }],
				summary: "列出 Key",
				operationId: "listApiKeys",
				description: "管理员接口。不返回密钥哈希或明文。",
				responses: {
					"200": {
						description: "Key 列表",
						content: { "application/json": { schema: envelope({ type: "array", items: apiKeyRecord }) } },
					},
					...errors,
				},
			},
			post: {
				security: [{ AdminBearer: [] }],
				summary: "创建 Key",
				operationId: "createApiKey",
				description: "独立创建 Key；管理员可通过密钥读取接口再次查看。",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["name"],
								additionalProperties: false,
								properties: {
									name: { type: "string", minLength: 1, maxLength: 200 },
									orchestration_version_id: { ...uuid, nullable: true },
									configuration_id: { ...uuid, nullable: true },
									router_only: { type: "boolean", default: false, description: "创建使用直接能力的 Router-only Key" },
								},
							},
						},
					},
				},
				responses: {
					"201": {
						description: "已创建，返回 token",
						content: {
							"application/json": {
								schema: envelope({
									...apiKeyRecord,
									properties: { ...apiKeyRecord.properties, token: { type: "string" } },
								}),
							},
						},
					},
					...errors,
				},
			},
		},
		"/api/admin/v1/aaas/keys/{key_id}/router": {
			parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }],
			get: { security: [{ AdminBearer: [] }], operationId: "getRouterKeyCapabilities", summary: "读取 Key 直接能力和修订", responses: { "200": { description: "能力与切换状态" }, ...errors } },
			put: { security: [{ AdminBearer: [] }], operationId: "saveRouterKeyCapabilities", summary: "保存 Key 直接能力",
				requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["expected_revision", "capabilities"], properties: {
					expected_revision: { type: "integer", minimum: 0 }, capabilities: { type: "object", required: ["model", "mcp_servers", "skills", "execution_policy"], description: "冻结模型、MCP Revision 与工具、Skill Revision 及策略" },
				} } } } }, responses: { "200": { description: "返回新修订" }, ...errors } },
			patch: { security: [{ AdminBearer: [] }], operationId: "switchRouterKeyScope", summary: "切换或回退单个 Key 的旧入口资格",
				requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["expected_revision", "action"], properties: {
					expected_revision: { type: "integer", minimum: 0 }, action: { type: "string", enum: ["cutover", "rollback"] },
					migration_confirmed: { type: "boolean", enum: [true], description: "cutover 必填" },
				} } } } }, responses: { "200": { description: "返回范围和新修订" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/legacy-configuration-status": {
			get: { security: [{ AdminBearer: [] }], operationId: "getLegacyAaasConfigurationStatus", summary: "读取旧 AaaS 配置的写入状态", responses: { "200": { description: "writable 决定兼容入口是否为只读" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/router-executions": {
			get: {
				security: [{ AdminBearer: [] }],
				operationId: "listAdminRouterExecutions",
				summary: "查询租户内的 Router Operation",
				parameters: [
					{ name: "q", in: "query", schema: { type: "string", maxLength: 200 }, description: "Task ID、Operation ID、Key ID 或 Key 名称" },
					{ name: "key_id", in: "query", schema: uuid },
					{ name: "status", in: "query", schema: { type: "string", enum: ["queued", "running", "completed", "failed", "canceled"] } },
					{ name: "after", in: "query", schema: uuid },
				],
				responses: { "200": { description: "items、next_cursor 和指定 Key 时的累计用量" }, ...errors },
			},
		},
		"/api/admin/v1/aaas/keys/sandbox/environment": {
			get: {
				security: [{ AdminBearer: [] }],
				operationId: "getAdminSandboxEnvironment",
				summary: "探测当前 Sandbox 运行环境",
				responses: { "200": { description: "可用状态、实际运行时与 Python 依赖，或探测错误" }, ...errors },
			},
		},
		"/api/admin/v1/aaas/keys/sandbox/statistics": {
			get: {
				security: [{ AdminBearer: [] }],
				operationId: "getAdminSandboxStatistics",
				summary: "查询当前租户的 Bash 执行统计",
				parameters: [
					{ name: "hours", in: "query", schema: { type: "string", enum: ["24", "168", "720"], default: "24" } },
				],
				responses: { "200": { description: "按单次启动聚合的结果、耗时、按小时或天统计的执行趋势与最近 50 条执行记录" }, ...errors },
			},
		},
		"/api/admin/v1/aaas/keys/{key_id}/router/tasks": {
			get: { security: [{ AdminBearer: [] }], operationId: "listAdminRouterTasks", summary: "查询 Key 的 Task 和累计 Usage", parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }, { name: "after", in: "query", schema: uuid }], responses: { "200": { description: "任务列表和游标" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/{key_id}/router/tasks/{task_id}": {
			get: { security: [{ AdminBearer: [] }], operationId: "getAdminRouterTask", summary: "查询 Task、Operation 列表和清理状态", parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }, { name: "task_id", in: "path", required: true, schema: uuid }], responses: { "200": { description: "任务、占用状态及 execution_duration_ms（Task 全部已启动 Operation 累计执行毫秒数，运行中计至查询时刻，不含排队时间）" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/{key_id}/router/tasks/{task_id}/history": {
			get: { security: [{ AdminBearer: [] }], operationId: "listAdminRouterHistory", summary: "查询脱敏 Task History", parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }, { name: "task_id", in: "path", required: true, schema: uuid }], responses: { "200": { description: "事件摘要和游标" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/{key_id}/router/operations/{operation_id}": {
			get: { security: [{ AdminBearer: [] }], operationId: "getAdminRouterOperation", summary: "读取 Operation 与 Usage", parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }, { name: "operation_id", in: "path", required: true, schema: uuid }], responses: { "200": { description: "Operation 详情与 cache_read（tokens 为已确认的缓存读取量，无可信数据时为 null；reported_calls 与 total_calls 表示调用记录覆盖率）。逐次模型用量可通过同一路径的 /trajectory?kind=model 分页读取" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/{key_id}": {
			patch: {
				security: [{ AdminBearer: [] }],
				summary: "启停、撤销或轮换 Key",
				operationId: "updateApiKey",
				description: "撤销为终态；轮换保持逻辑 ID，旧密钥立即失效，管理员可再次读取新 token。",
				parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["action"],
								additionalProperties: false,
								properties: { action: { type: "string", enum: ["enable", "disable", "revoke", "rotate"] } },
							},
						},
					},
				},
				responses: {
					"200": {
						description: "更新后的状态或新 token",
						content: {
							"application/json": {
								schema: envelope({
									type: "object",
									properties: { status: { type: "string" }, token: { type: "string" } },
								}),
							},
						},
					},
					...errors,
				},
			},
		},
		"/api/admin/v1/aaas/keys/{key_id}/secret": {
			post: {
				security: [{ AdminBearer: [] }],
				summary: "查看 Key 密钥",
				operationId: "revealApiKey",
				description: "仅管理员可读取可恢复密钥，历史仅存摘要的 Key 须先轮换。响应禁止缓存。",
				parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }],
				requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
				responses: {
					"200": {
						description: "完整密钥",
						content: {
							"application/json": {
								schema: envelope({
									type: "object",
									required: ["token"],
									properties: { token: { type: "string" } },
								}),
							},
						},
					},
					...errors,
				},
			},
		},
		"/api/admin/v1/aaas/keys/configurations": {
			get: {
				security: [{ AdminBearer: [] }],
				summary: "列出可供 Key 选择的编排配置", operationId: "listApiKeyConfigurations",
				description: "返回配置名称、当前生效版本、模型及冻结工具数；管理员按配置名选择，不操作历史版本 ID。",
				responses: { "200": { description: "配置列表" }, ...errors },
			},
		},
		"/api/admin/v1/aaas/keys/{key_id}/configuration": {
			put: {
				security: [{ AdminBearer: [] }],
				summary: "设置 Key 的配置关联", operationId: "setApiKeyConfiguration",
				description: "platform=跟随平台默认；configuration=跟随指定配置的生效版本；version=固定历史版本（兼容已有绑定）。前两者不固定版本。",
				parameters: [{ name: "key_id", in: "path", required: true, schema: uuid }],
				requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["mode"], additionalProperties: false, properties: {
					mode: { type: "string", enum: ["platform", "configuration", "version"] },
					configuration_id: { ...uuid, nullable: true },
					orchestration_version_id: { ...uuid, nullable: true },
				} } } } },
				responses: { "200": { description: "已更新，返回 Key 记录（含实际关联模式）" }, ...errors },
			},
		},
		"/api/admin/v1/aaas/keys/versions/{version_id}/credential-bindings": {
			get: { security: [{ AdminBearer: [] }], summary: "读取版本工具参数映射", operationId: "getVersionCredentialBindings", parameters: [{ name: "version_id", in: "path", required: true, schema: uuid }], responses: { "200": { description: "credential_bindings 为 null 表示未登记，空数组表示无需工具凭据" }, ...errors } },
			put: { security: [{ AdminBearer: [] }], summary: "登记不可变版本映射", operationId: "setVersionCredentialBindings", parameters: [{ name: "version_id", in: "path", required: true, schema: uuid }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["credential_bindings"], additionalProperties: false, properties: { credential_bindings: { type: "array", maxItems: 128, items: { type: "object", required: ["mcpServerId", "toolName", "parameter", "credentialId"], additionalProperties: false, properties: { mcpServerId: { type: "string" }, toolName: { type: "string" }, parameter: { type: "string" }, credentialId: { type: "string" } } } } } } } } }, responses: { "200": { description: "已登记或同内容重投" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/platform-configuration/versions": {
			get: { security: [{ AdminBearer: [] }], summary: "列出可用的已发布版本", operationId: "listApiKeyConfigurationVersions", responses: { "200": { description: "本租户版本的非敏感元数据" }, ...errors } },
		},
		"/api/admin/v1/aaas/keys/platform-configuration": {
			get: {
				security: [{ AdminBearer: [] }],
				summary: "读取平台默认执行配置",
				operationId: "getApiKeyPlatformConfiguration",
				responses: {
					"200": {
						description: "配置标识与凭据映射元数据；未配置时为 null",
						content: {
							"application/json": {
								schema: envelope({
									type: "object",
									nullable: true,
									properties: {
										configuration_id: uuid,
										orchestration_version_id: uuid,
										enabled: { type: "boolean" },
										credential_bindings: { type: "array", items: { type: "object" } },
									},
								}),
							},
						},
					},
					...errors,
				},
			},
			put: {
				security: [{ AdminBearer: [] }],
				summary: "绑定平台默认执行配置",
				operationId: "setApiKeyPlatformConfiguration",
				description: "绑定已发布版本；映射未登记时须提供映射，已登记映射不可更改。Key 可指定其他版本。",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["configuration_id", "orchestration_version_id"],
								additionalProperties: false,
								properties: {
									configuration_id: uuid,
									orchestration_version_id: uuid,
									credential_bindings: {
										type: "array",
										maxItems: 128,
										items: {
											type: "object",
											required: ["mcpServerId", "toolName", "parameter", "credentialId"],
											additionalProperties: false,
											properties: {
												mcpServerId: { type: "string" },
												toolName: { type: "string" },
												parameter: { type: "string" },
												credentialId: { type: "string" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "已绑定",
						content: {
							"application/json": {
								schema: envelope({
									type: "object",
									required: ["configured"],
									properties: { configured: { type: "boolean" } },
								}),
							},
						},
					},
					...errors,
				},
			},
		},
	},
	components: {
		securitySchemes: {
			ApiKey: { type: "http", scheme: "bearer", description: "ak_ 前缀的独立 API Key" },
			AdminBearer: { type: "http", scheme: "bearer", description: "管理员认证凭据" },
		},
		schemas: {
			ApiKeyMcpServerSummary: {
				type: "object",
				required: ["server_id", "name", "revision", "tool_count", "authentication", "credential_requirements"],
				properties: {
					server_id: { type: "string" },
					name: { type: "string" },
					description: { type: "string", nullable: true },
					revision: { type: "integer" },
					tool_count: { type: "integer", minimum: 0 },
					authentication: { type: "string", enum: ["none", "bearer", "api_key"] },
					credential_requirements: {
						type: "object",
						required: ["connection_credential", "tool_credential"],
						properties: { connection_credential: { type: "boolean" }, tool_credential: { type: "boolean" } },
					},
				},
			},
			ApiKeyMcpServer: {
				type: "object",
				required: ["server_id", "name", "revision", "tool_count", "authentication", "tools", "required_credentials", "credential_requirements"],
				properties: {
					server_id: { type: "string" },
					name: { type: "string" },
					description: { type: "string", nullable: true },
					revision: { type: "integer" },
					tool_count: { type: "integer", minimum: 0 },
					authentication: { type: "string", enum: ["none", "bearer", "api_key"] },
					credential_requirements: { type: "object", required: ["connection_credential", "tool_credential"], properties: { connection_credential: { type: "boolean" }, tool_credential: { type: "boolean" } } },
					tools: {
						type: "array",
						items: {
							type: "object",
							required: ["name", "description", "input_schema"],
							properties: {
								name: { type: "string" },
								description: { type: "string", nullable: true },
								input_schema: { type: "object", additionalProperties: true },
							},
						},
					},
					required_credentials: {
						type: "array",
						items: {
							type: "object",
							required: ["credential_id", "scope", "required"],
							properties: {
								credential_id: { type: "string" },
								scope: { type: "string", enum: ["connection", "tool"] },
								tool_name: { type: "string" },
								parameter: { type: "string" },
								required: { type: "boolean" },
							},
						},
					},
				},
			},
			Error: {
				type: "object",
				required: ["error"],
				properties: {
					error: {
						type: "object",
						required: ["code", "message", "requestId", "retryable"],
						properties: {
							code: { type: "string" },
							message: { type: "string" },
							requestId: { type: "string" },
							retryable: { type: "boolean" },
						},
					},
				},
			},
		},
	},
};

const require = createRequire(import.meta.url);
const assetDir = dirname(require.resolve("swagger-ui-dist/package.json"));
const assets: Record<string, string> = {
	"swagger-ui.css": "text/css; charset=utf-8",
	"swagger-ui-bundle.js": "text/javascript; charset=utf-8",
};
const html = routerDeveloperPage(base);

/** The reference page and the public JSON use the same Router contract. */
export const aaasApiKeyPublicOpenApi = routerOpenApi;

export const apiDocumentationHttp: HttpRequestHandler = async (request, response) => {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	if (path !== base && !path.startsWith(`${base}/`)) return false;
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
	);
	if (request.method !== "GET") {
		response.writeHead(405);
		response.end();
		return true;
	}
	if (path === `${base}/openapi.json`) {
		jsonBody(response, 200, aaasOpenApi);
		return true;
	}
	// Separate document for the independent API Key contract; the legacy document above
	// remains byte-for-byte compatible with the published three-route contract.
	if (path === `${base}/v1/openapi.json`) {
		jsonBody(response, 200, aaasApiKeyOpenApi);
		return true;
	}
	if (path === `${base}/v1/public/openapi.json`) {
		jsonBody(response, 200, aaasApiKeyPublicOpenApi);
		return true;
	}
	if (path === base || path === `${base}/`) {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
		return true;
	}
	if (path === `${base}/router.js`) {
		response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
		response.end(routerDeveloperScript);
		return true;
	}
	if (path === `${base}/router.css`) {
		response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
		response.end(routerDeveloperStyles);
		return true;
	}
	const name = path.slice(base.length + 1);
	if (Object.hasOwn(assets, name)) {
		const contents = await readFile(join(assetDir, name));
		response.writeHead(200, { "Content-Type": assets[name]! });
		response.end(contents);
		return true;
	}
	response.writeHead(404);
	response.end();
	return true;
};

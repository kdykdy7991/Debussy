import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { HttpRequestHandler } from "../types.ts";
import { jsonBody } from "../web/http-shared.ts";

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

const require = createRequire(import.meta.url);
const assetDir = dirname(require.resolve("swagger-ui-dist/package.json"));
const assets: Record<string, string> = {
	"swagger-ui.css": "text/css; charset=utf-8",
	"swagger-ui-bundle.js": "text/javascript; charset=utf-8",
};
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Agent 任务 API</title><link rel="stylesheet" href="${base}/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="${base}/swagger-ui-bundle.js"></script><script src="${base}/init.js"></script></body></html>`;
const init = `window.onload = () => SwaggerUIBundle({url: '${base}/openapi.json', dom_id: '#swagger-ui', validatorUrl: null, persistAuthorization: false, deepLinking: true});`;

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
	if (path === base || path === `${base}/`) {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
		return true;
	}
	if (path === `${base}/init.js`) {
		response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
		response.end(init);
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

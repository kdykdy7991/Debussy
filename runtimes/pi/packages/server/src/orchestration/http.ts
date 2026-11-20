import type { IncomingMessage } from "node:http";
import { ZodError, z } from "zod";
import { errorEnvelope, jsonBody, readJsonBody, readRequestId } from "../embed/http-shared.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import { createRun } from "./aaas.ts";
import { apiDocumentationHttp } from "./api-documentation.ts";
import { createConfigurationHttp } from "./configuration-http.ts";
import { configurationSchema, createIntegrationSchema, eventSchema, OrchestrationError } from "./contracts.ts";
import type { OrchestrationService } from "./service.ts";

/** Backend integration API and separately authenticated admin projections. Never returns stored keys. */
export function createOrchestrationHttp(
	service: OrchestrationService,
	isAdmin: (request: IncomingMessage) => boolean,
): HttpRequestHandler {
	const configurationHandler = createConfigurationHttp(service, isAdmin);
	return async (request, response) => {
		if (await apiDocumentationHttp(request, response)) return true;
		if (await configurationHandler(request, response)) return true;
		const pathname = requestPathname(request.url) ?? "";
		const admin = pathname === "/api/admin/v1/orchestration" || pathname.startsWith("/api/admin/v1/orchestration/");
		const external = pathname === "/api/orchestration/v1" || pathname.startsWith("/api/orchestration/v1/");
		const aaas = pathname === "/api/aaas/v1" || pathname.startsWith("/api/aaas/v1/");
		if (!admin && !external && !aaas) return false;
		response.setHeader("Cache-Control", "no-store");
		const requestId = readRequestId(request);
		try {
			if (admin && !isAdmin(request)) throw new OrchestrationError(401, "UNAUTHORIZED", "需要管理员认证");
			const integration = admin ? undefined : await service.store.authenticate(request.headers.authorization);
			const base = admin ? "/api/admin/v1/orchestration" : aaas ? "/api/aaas/v1" : "/api/orchestration/v1";
			const parts = pathname.slice(base.length).split("/").filter(Boolean);
			const method = request.method;
			let body: unknown;
			if (method === "POST" || method === "PUT" || method === "PATCH") {
				const parsed = await readJsonBody(request, 96 * 1024);
				if (parsed.kind !== "ok")
					throw new OrchestrationError(
						parsed.kind === "too_large" ? 413 : 400,
						"INVALID_REQUEST",
						"请求体无效或过大",
					);
				body = parsed.value;
			}
			let data: unknown,
				status = 200;
			if (aaas && integration) {
				if (parts[0] === "integrations" && parts.length === 3 && parts[2] === "runs" && method === "POST") {
					if (z.string().uuid().parse(parts[1]) !== integration.id)
						throw new OrchestrationError(404, "NOT_FOUND", "接入不存在");
					data = await createRun(service.store, integration, request.headers["idempotency-key"], body);
					status = 202;
				} else if (parts[0] === "runs" && parts.length === 2 && method === "GET") {
					data = await service.store.run(z.string().uuid().parse(parts[1]), integration.id);
				} else if (parts[0] === "runs" && parts.length === 3 && parts[2] === "cancel" && method === "POST") {
					const id = z.string().uuid().parse(parts[1]);
					await service.store.run(id, integration.id);
					await service.store.cancel(id, integration.id);
					data = await service.store.run(id, integration.id);
				} else throw new OrchestrationError(404, "NOT_FOUND", "接口不存在");
			} else if (admin && parts[0] === "configurations" && parts.length === 1 && method === "GET")
				data = await service.independentConfigurations();
			else if (admin && parts[0] === "configurations" && parts.length === 1 && method === "POST") {
				const input = z
					.object({ name: z.string().trim().min(1).max(200), draft: z.unknown() })
					.strict()
					.parse(body);
				data = await service.createIndependentConfiguration(input.name, input.draft);
				status = 201;
			} else if (admin && parts[0] === "configurations" && parts.length === 2 && method === "GET")
				data = await service.independentConfiguration(z.string().uuid().parse(parts[1]));
			else if (
				admin &&
				parts[0] === "configurations" &&
				parts.length === 3 &&
				parts[2] === "draft" &&
				method === "PUT"
			) {
				const input = z
					.object({ expectedRevision: z.number().int().positive(), draft: z.unknown() })
					.strict()
					.parse(body);
				data = await service.saveIndependentDraft(
					z.string().uuid().parse(parts[1]),
					input.expectedRevision,
					input.draft,
				);
			} else if (
				admin &&
				parts[0] === "configurations" &&
				parts.length === 3 &&
				parts[2] === "versions" &&
				method === "POST"
			) {
				const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(body);
				data = await service.publishIndependentConfiguration(
					z.string().uuid().parse(parts[1]),
					input.expectedRevision,
				);
				status = 201;
			} else if (
				admin &&
				parts[0] === "configurations" &&
				parts.length === 2 &&
				parts[1] === "current" &&
				method === "PUT"
			) {
				const binding = z.object({
					mcpServerId: z.string().regex(/^mcp_[0-9a-f-]{36}$/),
					toolName: z.string().min(1).max(200),
					parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
					credentialId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
				}).strict();
				const input = z.object({
					configuration_id: z.string().uuid().nullable(),
					name: z.string().trim().min(1).max(200),
					draft: z.unknown(),
					expected_revision: z.number().int().positive().optional(),
					credential_bindings: z.array(binding).max(128),
				}).strict().parse(body);
				data = await service.applyCurrentConfiguration({
					configurationId: input.configuration_id,
					name: input.name,
					draft: input.draft,
					expectedRevision: input.expected_revision,
					credentialBindings: input.credential_bindings,
				});
			} else if (
				admin &&
				parts[0] === "configurations" &&
				parts.length === 4 &&
				parts[2] === "versions" &&
				method === "GET"
			)
				data = await service.independentVersion(
					z.string().uuid().parse(parts[1]),
					z.string().uuid().parse(parts[3]),
				);
			else if (admin && parts[0] === "catalog" && parts.length === 1 && method === "GET")
				data = await service.catalog();
			else if (admin && parts[0] === "integrations" && parts.length === 1 && method === "GET")
				data = await service.store.listIntegrations();
			else if (admin && parts[0] === "integrations" && parts.length === 1 && method === "POST") {
				data = await service.createIntegration(createIntegrationSchema.parse(body));
				status = 201;
			} else if (
				admin &&
				parts[0] === "integrations" &&
				parts.length === 3 &&
				parts[2] === "migrate" &&
				method === "POST"
			) {
				const expected = z
					.object({ expected_revision: z.number().int().positive(), expected_active_version: z.string() })
					.strict()
					.parse(body);
				data = await service.migrateConfiguration(
					z.string().uuid().parse(parts[1]),
					expected.expected_revision,
					expected.expected_active_version,
				);
			} else if (
				admin &&
				parts[0] === "integrations" &&
				parts.length === 3 &&
				parts[2] === "debug-runs" &&
				method === "POST"
			) {
				const debug = z
					.object({
						requestId: z.string().min(1).max(160),
						prompt: z.string().min(1).max(48_000),
						credentials: eventSchema.shape.credentials,
					})
					.strict()
					.parse(body);
				const current = await service.store.getLegacyIntegration(z.string().uuid().parse(parts[1]));
				const created = await createRun(
					service.store,
					current,
					`console_debug:${debug.requestId}`,
					{
						prompt: debug.prompt,
						credentials: debug.credentials,
						external_ref: { type: "console_debug", id: debug.requestId },
						metadata: { source: "admin_console_debug" },
					},
					{ internalConsoleDebug: true },
				);
				data = await service.store.workItem(created.run_id, current.id);
				status = 202;
			} else if (admin && parts[0] === "integrations" && parts.length === 2 && method === "PATCH") {
				const id = z.string().uuid().parse(parts[1]);
				const patch = z
					.discriminatedUnion("action", [
						z.object({ action: z.literal("enable") }).strict(),
						z.object({ action: z.literal("disable") }).strict(),
						z.object({ action: z.literal("rotate") }).strict(),
						z.object({ action: z.literal("rename"), name: z.string().trim().min(1).max(200) }).strict(),
					])
					.parse(body);
				data =
					patch.action === "rename"
						? await service.store.renameIntegration(id, patch.name)
						: await service.store.updateAccess(id, patch.action);
			} else if (parts[0] === "configuration" && parts.length === 1 && integration) {
				throw new OrchestrationError(
					403,
					"CONFIGURATION_FORBIDDEN",
					"业务调用凭据不授予配置权限，请使用独立配置会话",
				);
			} else if (admin && parts[0] === "integrations" && parts[2] === "configuration" && parts.length === 3) {
				const current = await service.store.getLegacyIntegration(z.string().uuid().parse(parts[1]));
				if (method === "GET") data = await service.configuration(current);
				else if (method === "PUT") data = await service.saveConfiguration(current, configurationSchema.parse(body));
				else throw new OrchestrationError(405, "METHOD_NOT_ALLOWED", "方法不支持");
			} else if (parts[0] === "events" && parts.length === 1 && integration && method === "POST") {
				const input = eventSchema.parse(body);
				if (Object.values(input.credentials).some((secret) => input.input.includes(secret)))
					throw new OrchestrationError(400, "CREDENTIAL_IN_INPUT", "凭据必须放在独立 credentials 字段中");
				data = await service.store.accept(integration, input);
				status = 202;
			} else if (parts[0] === "work-items" && parts.length === 1 && method === "GET") {
				const params = new URL(request.url!, "http://localhost").searchParams;
				const requested = admin ? z.string().uuid().safeParse(params.get("integrationId")) : undefined;
				const state = params.get("state"),
					q = params.get("q")?.trim(),
					externalRefType = params.get("externalRefType")?.trim();
				data = await service.store.listWorkItems(
					integration?.id ?? (requested?.success ? requested.data : undefined),
					params.get("alarmId") ?? undefined,
					{
						...(state && ["queued", "running", "succeeded", "failed", "cancelled"].includes(state)
							? { state }
							: {}),
						...(q ? { query: q.slice(0, 200) } : {}),
						...(externalRefType ? { externalRefType: externalRefType.slice(0, 100) } : {}),
					},
				);
			} else if (parts[0] === "work-items" && parts.length === 2 && method === "GET") {
				data = await service.store.workItem(z.string().uuid().parse(parts[1]), integration?.id);
			} else if (parts[0] === "work-items" && parts.length === 3 && method === "POST") {
				const id = z.string().uuid().parse(parts[1]);
				if (parts[2] === "cancel") data = await service.cancel(id, integration?.id);
				else if (parts[2] === "retry") {
					await service.store.retry(id, integration?.id);
					data = { queued: true };
				} else throw new OrchestrationError(404, "NOT_FOUND", "接口不存在");
			} else throw new OrchestrationError(404, "NOT_FOUND", "接口不存在");
			jsonBody(response, status, { data, requestId });
		} catch (error) {
			const e =
				error instanceof OrchestrationError
					? error
					: error instanceof ZodError
						? new OrchestrationError(400, "INVALID_REQUEST", "请求不符合接口契约")
						: error instanceof Error && "code" in error && error.code === "23505"
							? new OrchestrationError(409, "CONFLICT", "接入已存在或配置发生并发修改，请刷新后重试")
							: new OrchestrationError(500, "INTERNAL", "操作失败，请检查服务状态或配置冲突");
			jsonBody(response, e.status, errorEnvelope(e.code, e.message, requestId, e.status >= 500));
		}
		return true;
	};
}

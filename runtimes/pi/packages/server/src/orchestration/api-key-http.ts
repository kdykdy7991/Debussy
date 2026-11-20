import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { errorEnvelope, jsonBody, readJsonBody, readRequestId } from "../embed/http-shared.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import type { ApiKeyStore } from "./api-key.ts";
import { API_KEY_PREFIX } from "./api-key-contracts.ts";
import type { ApiKeyRunService } from "./api-key-runs.ts";
import { OrchestrationError } from "./contracts.ts";
import type { createRouterAdmin } from "./router-admin.ts";

const ADMIN_BASE = "/api/admin/v1/aaas/keys";
const RUNS_BASE = "/api/aaas/v1/runs";
const MCP_SERVERS_BASE = "/api/aaas/v1/mcp-servers";
const bindingsSchema = z.array(z.object({
	mcpServerId: z.string().regex(/^mcp_[0-9a-f-]{36}$/),
	toolName: z.string().min(1).max(200),
	parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	credentialId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
}).strict()).max(128);

/**
 * Independent API Key surface. Composition guarantees mutual exclusion: an `ak_`
 * credential or a `/api/admin/v1/aaas/keys` path never falls back to the legacy
 * Integration authenticator, and an unrecognised credential is a uniform 401.
 */
export function createApiKeyHttp(options: {
	readonly keys: ApiKeyStore;
	readonly runs?: ApiKeyRunService;
	readonly isAdmin: (request: IncomingMessage) => boolean;
	readonly routerAdmin?: ReturnType<typeof createRouterAdmin>;
}): HttpRequestHandler {
	const { keys, runs } = options;
	return async (request: IncomingMessage, response: ServerResponse) => {
		const pathname = requestPathname(request.url) ?? "";
		const adminKeys = pathname === ADMIN_BASE || pathname.startsWith(`${ADMIN_BASE}/`);
		// `/api/aaas/v1/runs/{run_id}[/cancel]` is shared with the legacy Integration
		// contract, so it is claimed only for an `ak_` credential. A legacy `oi_`
		// credential must fall through to the Integration handler, not get a 401 here.
		const sharedRunPaths = pathname.startsWith(`${RUNS_BASE}/`);
		const mcpServerParts = pathname.startsWith(`${MCP_SERVERS_BASE}/`)
			? pathname.slice(MCP_SERVERS_BASE.length).split("/").filter(Boolean)
			: [];
		const mcpDetailPath = mcpServerParts.length === 1;
		const newOnlyPaths =
			pathname === RUNS_BASE ||
			pathname === MCP_SERVERS_BASE ||
			mcpDetailPath ||
			pathname === "/api/aaas/v1/usage";
		const authorization = request.headers.authorization;
		const apiKeyCredential = authorization?.startsWith(`Bearer ${API_KEY_PREFIX}`) === true;
		const legacyCredential = authorization?.startsWith("Bearer oi_") === true;
		if (sharedRunPaths && !apiKeyCredential && legacyCredential) return false;
		if (!adminKeys && !newOnlyPaths && !sharedRunPaths && !apiKeyCredential) return false;
		response.setHeader("Cache-Control", "no-store");
		const requestId = readRequestId(request);
		try {
			if (pathname === RUNS_BASE && request.method === "POST") {
				await keys.authenticate(authorization);
				throw new OrchestrationError(410, "LEGACY_RUN_CREATION_RETIRED", "旧 Run 创建接口已停用，请使用 POST /api/aaas/v1/tasks");
			}
			let body: unknown;
			if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
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
			if (adminKeys) {
				if (!options.isAdmin(request)) throw new OrchestrationError(401, "UNAUTHORIZED", "需要管理员认证");
				const parts = pathname.slice(ADMIN_BASE.length).split("/").filter(Boolean);
				if (pathname === `${ADMIN_BASE}/router-executions` && request.method === "GET" && options.routerAdmin) {
					data = await options.routerAdmin.listExecutions(new URL(request.url ?? "/", "http://localhost"));
				} else if (pathname === `${ADMIN_BASE}/sandbox/environment` && request.method === "GET" && options.routerAdmin) {
					data = await options.routerAdmin.sandboxEnvironment();
				} else if (pathname === `${ADMIN_BASE}/sandbox/statistics` && request.method === "GET" && options.routerAdmin) {
					data = await options.routerAdmin.sandboxStatistics(new URL(request.url ?? "/", "http://localhost"));
				} else if (parts[1] === "router" && options.routerAdmin) {
					data = await options.routerAdmin.handle(parts[0], parts.slice(2), request.method, new URL(request.url ?? "/", "http://localhost"), body, requestId);
				} else if (pathname === `${ADMIN_BASE}/legacy-configuration-status` && request.method === "GET") {
					data = { writable: await keys.legacyConfigurationWritable() };
				} else if (pathname === `${ADMIN_BASE}/platform-configuration/versions` && request.method === "GET") {
					data = await keys.platformConfigurationVersions(!(await keys.legacyConfigurationWritable()));
				} else if (pathname === `${ADMIN_BASE}/configurations` && request.method === "GET") {
					data = await keys.configurationChoices();
				} else if (parts.length === 3 && parts[0] === "versions" && parts[2] === "credential-bindings" && request.method === "GET") {
					data = { credential_bindings: await keys.versionBindings(z.string().uuid().parse(parts[1])) };
				} else if (parts.length === 3 && parts[0] === "versions" && parts[2] === "credential-bindings" && request.method === "PUT") {
					await keys.assertLegacyConfigurationWritable();
					const input = z.object({ credential_bindings: bindingsSchema }).strict().parse(body);
					await keys.setVersionBindings(z.string().uuid().parse(parts[1]), input.credential_bindings);
					data = { credential_bindings: input.credential_bindings };
				} else if (pathname === `${ADMIN_BASE}/platform-configuration` && request.method === "GET") {
					data = await keys.platformConfigurationView();
				} else if (pathname === `${ADMIN_BASE}/platform-configuration` && request.method === "PUT") {
					await keys.assertLegacyConfigurationWritable();
					const input = z
						.object({
							configuration_id: z.string().uuid(),
							orchestration_version_id: z.string().uuid(),
							credential_bindings: z
								.array(
									z
										.object({
											mcpServerId: z.string().regex(/^mcp_[0-9a-f-]{36}$/),
											toolName: z.string().min(1).max(200),
											parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
											credentialId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
										})
										.strict(),
								)
								.max(128)
								.optional(),
						})
						.strict()
						.parse(body);
					await keys.setPlatformConfiguration(
						input.configuration_id,
						input.orchestration_version_id,
						input.credential_bindings,
					);
					data = { configured: true };
				} else if (parts.length === 0 && request.method === "GET") {
					data = await keys.listViews();
				} else if (parts.length === 0 && request.method === "POST") {
					const input = z
						.object({
							name: z.string().trim().min(1).max(200),
							orchestration_version_id: z.string().uuid().nullable().optional(),
							configuration_id: z.string().uuid().nullable().optional(),
							router_only: z.boolean().optional(),
						})
						.strict()
						.parse(body);
					if (!input.router_only) await keys.assertLegacyConfigurationWritable();
					const created = await keys.create(input.name, input.orchestration_version_id ?? null, input.configuration_id ?? null, input.router_only);
					data = { ...created.record, token: created.token };
					status = 201;
				} else if (parts.length === 1 && request.method === "PATCH") {
					const input = z
						.discriminatedUnion("action", [
							z.object({ action: z.literal("enable") }).strict(),
							z.object({ action: z.literal("disable") }).strict(),
							z.object({ action: z.literal("revoke") }).strict(),
							z.object({ action: z.literal("rotate") }).strict(),
						])
						.parse(body);
					data = await keys.updateAccess(z.string().uuid().parse(parts[0]), input.action);
				} else if (parts.length === 2 && parts[1] === "configuration" && request.method === "PUT") {
					const keyId = z.string().uuid().parse(parts[0]);
					const modeBody = z.object({
						mode: z.enum(["platform", "configuration", "version"]),
						configuration_id: z.string().uuid().nullable().optional(),
						orchestration_version_id: z.string().uuid().nullable().optional(),
					}).strict();
					const legacyBody = z.object({ orchestration_version_id: z.string().uuid().nullable() }).strict();
					const parsed = modeBody.safeParse(body);
					if (parsed.success) {
						data = await keys.setKeyConfiguration(keyId, parsed.data.mode, {
							configurationId: parsed.data.configuration_id,
							versionId: parsed.data.orchestration_version_id,
						});
					} else {
						const legacy = legacyBody.parse(body);
						data = await keys.setKeyConfiguration(
							keyId,
							legacy.orchestration_version_id === null ? "platform" : "version",
							{ versionId: legacy.orchestration_version_id },
						);
					}
				} else if (parts.length === 2 && parts[1] === "secret" && request.method === "POST") {
					data = { token: await keys.reveal(z.string().uuid().parse(parts[0])) };
				} else throw new OrchestrationError(404, "NOT_FOUND", "接口不存在");
			} else {
				// A failed API Key authentication ends here; no fallback to Integration auth.
				const principal = await keys.authenticate(request.headers.authorization);
				if (runs === undefined) throw new OrchestrationError(404, "NOT_FOUND", "接口不存在");
				const capabilityHeader = request.headers["x-router-capability-scope"];
				const capabilityScope = Array.isArray(capabilityHeader) ? capabilityHeader[0] : capabilityHeader;
				if (pathname === MCP_SERVERS_BASE && request.method === "GET") {
					data = await runs.mcpServers(principal, capabilityScope);
				} else if (mcpDetailPath && request.method === "GET") {
					data = await runs.mcpServer(principal, mcpServerParts[0]!, capabilityScope);
				} else if (pathname === "/api/aaas/v1/usage" && request.method === "GET") {
					data = await runs.usage(principal);
				} else {
					const parts = pathname.slice(RUNS_BASE.length).split("/").filter(Boolean);
					const id = z.string().uuid().parse(parts[0]);
					if (parts.length === 1 && request.method === "GET") data = await runs.run(principal, id);
					else if (parts.length === 2 && parts[1] === "cancel" && request.method === "POST")
						data = await runs.cancel(principal, id);
					else throw new OrchestrationError(404, "NOT_FOUND", "接口不存在");
				}
			}
			jsonBody(response, status, { data, requestId });
		} catch (error) {
			const e =
				error instanceof OrchestrationError
					? error
					: error instanceof ZodError
						? new OrchestrationError(400, "INVALID_REQUEST", "请求不符合接口契约")
						: error instanceof Error && "code" in error && error.code === "23505"
							? new OrchestrationError(409, "CONFLICT", "请求发生并发冲突")
							: new OrchestrationError(500, "INTERNAL", "操作失败，请检查服务状态或配置冲突");
			jsonBody(response, e.status, errorEnvelope(e.code, e.message, requestId, e.status >= 500));
		}
		return true;
	};
}

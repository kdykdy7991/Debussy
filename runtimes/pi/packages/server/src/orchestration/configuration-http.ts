import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ZodError, z } from "zod";
import { errorEnvelope, jsonBody, readJsonBody, readRequestId } from "../embed/http-shared.ts";
import type { HttpRequestHandler } from "../types.ts";
import { configurationPage } from "./configuration-page.ts";
import { ExternalConfigurationService } from "./configuration-service.ts";
import { OrchestrationError } from "./contracts.ts";
import type { OrchestrationService } from "./service.ts";

/** Only these configuration resources use the separate capability/session authenticator. */
export function createConfigurationHttp(
	service: OrchestrationService,
	isAdmin: (request: IncomingMessage) => boolean,
): HttpRequestHandler {
	const configuration = new ExternalConfigurationService(service);
	return async (request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const admin = /^\/api\/admin\/v1\/orchestration\/integrations\/([^/]+)\/configuration-grants(?:\/([^/]+))?$/.exec(
			path,
		);
		const resource = /^\/api\/aaas\/v1\/integrations\/([^/]+)\/(configuration|draft|publish)$/.exec(path);
		const page = /^\/aaas\/integrations\/([^/]+)\/configuration$/.exec(path);
		const exchange = path === "/api/aaas/v1/configuration/exchange",
			consume = path === "/api/aaas/v1/configuration/consume";
		if (!admin && !resource && !page && !exchange && !consume) return false;
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Content-Type-Options", "nosniff");
		const requestId = readRequestId(request);
		try {
			if (admin && !isAdmin(request)) throw new OrchestrationError(401, "UNAUTHORIZED", "需要管理员认证");
			let body: unknown;
			if (["POST", "PUT", "PATCH"].includes(request.method ?? "")) {
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
			if (page && request.method === "GET") {
				const origins = await configuration.pageOrigins(z.string().uuid().parse(page[1])),
					nonce = randomBytes(18).toString("base64");
				response.setHeader(
					"Content-Security-Policy",
					`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self' ${[...new Set(origins)].join(" ")}; base-uri 'none'; form-action 'none'`,
				);
				response.setHeader("Content-Type", "text/html; charset=utf-8");
				response.writeHead(200);
				response.end(configurationPage(nonce));
				return true;
			}
			if (admin) {
				const id = z.string().uuid().parse(admin[1]);
				if (request.method === "GET" && !admin[2]) data = await configuration.grants(id);
				else if (request.method === "POST" && !admin[2]) {
					data = await configuration.createGrant(id, body);
					status = 201;
				} else if (request.method === "PATCH" && admin[2])
					data = await configuration.updateGrant(id, z.string().uuid().parse(admin[2]), body);
				else throw new OrchestrationError(405, "METHOD_NOT_ALLOWED", "方法不支持");
			} else if (exchange && request.method === "POST")
				data = await configuration.exchange(request.headers.authorization, body);
			else if (consume && request.method === "POST") data = await configuration.consume(body);
			else if (resource) {
				const id = z.string().uuid().parse(resource[1]);
				if (resource[2] === "configuration" && request.method === "GET")
					data = await configuration.view(request.headers.authorization, id);
				else if (resource[2] === "draft" && request.method === "PUT")
					data = await configuration.saveDraft(request.headers.authorization, id, body);
				else if (resource[2] === "publish" && request.method === "POST")
					data = await configuration.publish(request.headers.authorization, id, body);
				else throw new OrchestrationError(405, "METHOD_NOT_ALLOWED", "方法不支持");
			} else throw new OrchestrationError(405, "METHOD_NOT_ALLOWED", "方法不支持");
			jsonBody(response, status, { data, requestId });
		} catch (error) {
			const e =
				error instanceof OrchestrationError
					? error
					: error instanceof ZodError
						? new OrchestrationError(400, "INVALID_REQUEST", "请求不符合配置接口契约")
						: new OrchestrationError(500, "CONFIGURATION_FAILED", "配置操作失败，原生效版本不变");
			jsonBody(response, e.status, errorEnvelope(e.code, e.message, requestId, e.status >= 500));
		}
		return true;
	};
}

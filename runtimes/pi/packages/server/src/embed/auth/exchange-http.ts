/**
 * Embed Exchange HTTP 端点（spec 27.4，TASK-015/028）。
 *
 * `POST /api/embed/v1/exchange`：
 *
 * - `mode: "anonymous"` —— 把 `(publicAppId, anonymousVisitorId)` 换成短期
 *   Access Token（TASK-015）。
 * - `mode: "signed_user"` —— 宿主后端签发的 `launchToken` 经
 *   `LaunchTokenVerifier` 验证后建立 external_user Principal（TASK-028）。
 *
 * 端点只做 HTTP 关注点（请求体校验、Origin 提取、CORS、requestId、错误
 * 信封），业务校验全部在 `ExchangeService` 中；Origin 校验复用 TASK-014 的
 * 单一策略函数。错误消息绝不回显 visitorId / launchToken / externalUserId。
 */

import type { SecretRegistry } from "../../logging/redact.ts";
import type { MetricRegistry } from "../../metrics/index.ts";
import { parsePublicAppId } from "../../publishing/domain/ids.ts";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import {
	errorEnvelope,
	jsonBody,
	readJsonBody,
	readRequestId,
	respondPreflight,
	setEmbedCorsHeaders,
} from "../http-shared.ts";
import { ipDiscriminator, type RateLimiter } from "../rate-limits/limiter.ts";
import { ANONYMOUS_VISITOR_ID_MAX_CHARS, ANONYMOUS_VISITOR_ID_MIN_CHARS, type ExchangeService } from "./principal.ts";

export const EMBED_API_PREFIX = "/api/embed/v1";
export const EMBED_EXCHANGE_PATH = "/api/embed/v1/exchange";
/** Exchange 请求体上限：匿名体很小，Launch Token 也可容纳（64 KiB）。 */
export const EMBED_MAX_BODY_BYTES = 64 * 1024;
/** Launch Token 长度边界（JWS 三段 base64url）。 */
const LAUNCH_TOKEN_MAX_CHARS = 16384;

export interface ExchangeHttpHandlerOptions {
	readonly service: ExchangeService;
	readonly maxBodyBytes?: number;
	readonly onError?: (error: unknown) => void;
	/** 分层限流（spec 14）：Exchange 维度，按调用方 IP 计数。 */
	readonly limiter?: RateLimiter;
	/** 指标注册表（spec 15.1）：`embed_exchange_total{result}`。 */
	readonly metrics?: MetricRegistry;
	/** 敏感值注册表（spec 13.3/15 脱敏）：签发 token / visitorId 注册后不出现在日志。 */
	readonly secrets?: SecretRegistry;
}

/** 请求体校验失败（映射 400）。 */
class ExchangeHttpValidationError extends Error {}

export function createExchangeHttpHandler(options: ExchangeHttpHandlerOptions): HttpRequestHandler {
	const maxBodyBytes = options.maxBodyBytes ?? EMBED_MAX_BODY_BYTES;
	// TASK-035：Exchange 结果计数（`embed_exchange_total{result}`），本地。
	const exchangeTotal = options.metrics?.counter({
		name: "embed_exchange_total",
		help: "Exchange attempts by result",
		labels: ["result"],
	});
	const recordResult = (result: string): void => {
		exchangeTotal?.inc({ result });
	};

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || pathname !== EMBED_EXCHANGE_PATH) return false;
		if (request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		if (request.method !== "POST") {
			jsonBody(response, 405, errorEnvelope("METHOD_NOT_ALLOWED", "Method not allowed", "", false));
			return true;
		}
		setEmbedCorsHeaders(response, request.headers.origin);
		const requestId = readRequestId(request);
		response.setHeader("X-Request-Id", requestId);

		// TASK-034：Exchange 维度限流先于业务处理（按 IP；System 层最粗、App 无
		// 身份只走 IP 区分）。超限 429，不透露后续端点信息。
		if (options.limiter !== undefined) {
			const allowed = await options.limiter.check({
				dimension: "exchange",
				scope: {},
				discriminator: ipDiscriminator(requestIp(request)),
			});
			if (!allowed.allowed) {
				recordResult("rate_limited");
				jsonBody(response, 429, errorEnvelope("RATE_LIMITED", "Rate limit exceeded", requestId, true));
				return true;
			}
		}

		const raw = await readJsonBody(request, maxBodyBytes);
		if (raw.kind === "too_large") {
			jsonBody(response, 413, errorEnvelope("PAYLOAD_TOO_LARGE", "Request body too large", requestId, false));
			return true;
		}
		if (raw.kind === "invalid_json") {
			jsonBody(response, 400, errorEnvelope("INVALID_JSON", "Request body must be valid JSON", requestId, false));
			return true;
		}
		let parsed: ParsedExchangeBody;
		try {
			parsed = parseExchangeBody(raw.value);
		} catch (error) {
			if (error instanceof ExchangeHttpValidationError) {
				jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", error.message, requestId, false));
				return true;
			}
			throw error;
		}
		const publicAppId = parsePublicAppId(parsed.publicAppId);
		if (publicAppId === null) {
			jsonBody(
				response,
				400,
				errorEnvelope("INVALID_REQUEST", "publicAppId must be a pub_<uuid> locator", requestId, false),
			);
			return true;
		}

		try {
			// TASK-035 脱敏：把本次输入的匿名身份/Launch Token 注册为敏感值，
			// 若误被记录，日志层会打码（这些值是本会话可复现的稳定标识或一次性凭据）。
			options.secrets?.register(
				parsed.mode === "anonymous"
					? parsed.anonymousVisitorId
					: parsed.mode === "preview"
						? parsed.ticket
						: parsed.launchToken,
			);
			const result =
				parsed.mode === "anonymous"
					? await options.service.exchangeAnonymous({
							publicAppId,
							anonymousVisitorId: parsed.anonymousVisitorId,
							origin: request.headers.origin,
						})
					: parsed.mode === "preview"
						? await options.service.exchangePreview({
								publicAppId,
								ticket: parsed.ticket,
								origin: request.headers.origin,
							})
						: await options.service.exchangeSignedUser({
								publicAppId,
								launchToken: parsed.launchToken,
								origin: request.headers.origin,
							});
			if (!result.ok) {
				recordResult(result.error.code === "RATE_LIMITED" ? "rate_limited" : "denied");
				jsonBody(
					response,
					result.error.httpStatus,
					errorEnvelope(result.error.code, result.error.message, requestId, result.error.retryable),
				);
				return true;
			}
			recordResult("ok");
			// 脱敏：登出的短期 Access Token 一旦被写进日志，日志层必须打码。
			options.secrets?.register(result.data.accessToken);
			jsonBody(response, 200, { data: result.data, requestId });
			return true;
		} catch (error) {
			options.onError?.(error);
			if (!response.headersSent) {
				recordResult("error");
				jsonBody(response, 500, errorEnvelope("INTERNAL", "Internal server error", requestId, true));
			}
			return true;
		}
	};
}

/** 调用方 IP：直连取 socket 地址，反向代理回显上游也可用。 */
function requestIp(request: import("node:http").IncomingMessage): string | undefined {
	const forwarded = request.headers["x-forwarded-for"];
	const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	return request.socket.remoteAddress;
}

type ParsedExchangeBody =
	| { readonly mode: "anonymous"; readonly publicAppId: string; readonly anonymousVisitorId: string }
	| { readonly mode: "signed_user"; readonly publicAppId: string; readonly launchToken: string }
	| { readonly mode: "preview"; readonly publicAppId: string; readonly ticket: string };

/** 校验 Exchange 请求体；错误消息绝不回显 visitorId / launchToken 的值。 */
function parseExchangeBody(body: unknown): ParsedExchangeBody {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ExchangeHttpValidationError("request body must be a JSON object");
	}
	const record = body as Record<string, unknown>;
	const publicAppId = record.publicAppId;
	const mode = record.mode;
	if (typeof publicAppId !== "string" || publicAppId === "") {
		throw new ExchangeHttpValidationError("publicAppId must be a string");
	}
	if (mode === "anonymous") {
		const visitorId = record.anonymousVisitorId;
		if (
			typeof visitorId !== "string" ||
			visitorId.length < ANONYMOUS_VISITOR_ID_MIN_CHARS ||
			visitorId.length > ANONYMOUS_VISITOR_ID_MAX_CHARS
		) {
			throw new ExchangeHttpValidationError(
				`anonymousVisitorId must be a string of ${ANONYMOUS_VISITOR_ID_MIN_CHARS}..${ANONYMOUS_VISITOR_ID_MAX_CHARS} characters`,
			);
		}
		return { mode: "anonymous", publicAppId, anonymousVisitorId: visitorId };
	}
	if (mode === "signed_user") {
		const launchToken = record.launchToken;
		if (typeof launchToken !== "string" || launchToken === "" || launchToken.length > LAUNCH_TOKEN_MAX_CHARS) {
			throw new ExchangeHttpValidationError("launchToken must be a non-empty JWS string");
		}
		return { mode: "signed_user", publicAppId, launchToken };
	}
	if (mode === "preview") {
		const ticket = record.ticket;
		if (typeof ticket !== "string" || ticket === "" || ticket.length > LAUNCH_TOKEN_MAX_CHARS) {
			throw new ExchangeHttpValidationError("ticket must be a non-empty JWS string");
		}
		return { mode: "preview", publicAppId, ticket };
	}
	throw new ExchangeHttpValidationError("mode must be 'anonymous', 'preview' or 'signed_user'");
}

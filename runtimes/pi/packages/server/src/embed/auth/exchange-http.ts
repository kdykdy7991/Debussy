/**
 * Embed Exchange HTTP 端点（spec 27.4，TASK-015）。
 *
 * `POST /api/embed/v1/exchange`：匿名模式把 `(publicAppId, mode:
 * "anonymous", anonymousVisitorId)` 换成短期 Access Token。签名用户模式
 * （launchToken）由 TASK-028 实现，当前返回 400。
 *
 * 端点只做 HTTP 关注点（请求体校验、Origin 提取、CORS、requestId、错误
 * 信封），业务校验（App 状态 / accessMode / Origin allowlist / Principal /
 * Token 签发）全部在 `ExchangeService` 中，Origin 校验复用 TASK-014 的单一
 * 策略函数。
 */
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
import { ANONYMOUS_VISITOR_ID_MAX_CHARS, ANONYMOUS_VISITOR_ID_MIN_CHARS, type ExchangeService } from "./principal.ts";

export const EMBED_API_PREFIX = "/api/embed/v1";
export const EMBED_EXCHANGE_PATH = "/api/embed/v1/exchange";
/** Exchange 请求体上限：匿名体很小，Launch Token 也可容纳（64 KiB）。 */
export const EMBED_MAX_BODY_BYTES = 64 * 1024;

export interface ExchangeHttpHandlerOptions {
	readonly service: ExchangeService;
	readonly maxBodyBytes?: number;
	readonly onError?: (error: unknown) => void;
}

/** 请求体校验失败（映射 400）。 */
class ExchangeHttpValidationError extends Error {}

export function createExchangeHttpHandler(options: ExchangeHttpHandlerOptions): HttpRequestHandler {
	const maxBodyBytes = options.maxBodyBytes ?? EMBED_MAX_BODY_BYTES;

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

		const raw = await readJsonBody(request, maxBodyBytes);
		if (raw.kind === "too_large") {
			jsonBody(response, 413, errorEnvelope("PAYLOAD_TOO_LARGE", "Request body too large", requestId, false));
			return true;
		}
		if (raw.kind === "invalid_json") {
			jsonBody(response, 400, errorEnvelope("INVALID_JSON", "Request body must be valid JSON", requestId, false));
			return true;
		}
		let parsed: { publicAppId: string; anonymousVisitorId: string };
		try {
			parsed = parseAnonymousBody(raw.value);
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
			const result = await options.service.exchangeAnonymous({
				publicAppId,
				anonymousVisitorId: parsed.anonymousVisitorId,
				origin: request.headers.origin,
			});
			if (!result.ok) {
				jsonBody(
					response,
					result.error.httpStatus,
					errorEnvelope(result.error.code, result.error.message, requestId, result.error.retryable),
				);
				return true;
			}
			jsonBody(response, 200, { data: result.data, requestId });
			return true;
		} catch (error) {
			options.onError?.(error);
			if (!response.headersSent) {
				jsonBody(response, 500, errorEnvelope("INTERNAL", "Internal server error", requestId, true));
			}
			return true;
		}
	};
}

/** 校验匿名 Exchange 请求体；错误消息绝不回显 visitorId 的值。 */
function parseAnonymousBody(body: unknown): { publicAppId: string; anonymousVisitorId: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ExchangeHttpValidationError("request body must be a JSON object");
	}
	const record = body as Record<string, unknown>;
	const publicAppId = record.publicAppId;
	const mode = record.mode;
	const visitorId = record.anonymousVisitorId;
	if (typeof publicAppId !== "string" || publicAppId === "") {
		throw new ExchangeHttpValidationError("publicAppId must be a string");
	}
	if (mode !== "anonymous") {
		throw new ExchangeHttpValidationError("mode must be 'anonymous'; signed_user exchange is not part of this MVP");
	}
	if (
		typeof visitorId !== "string" ||
		visitorId.length < ANONYMOUS_VISITOR_ID_MIN_CHARS ||
		visitorId.length > ANONYMOUS_VISITOR_ID_MAX_CHARS
	) {
		throw new ExchangeHttpValidationError(
			`anonymousVisitorId must be a string of ${ANONYMOUS_VISITOR_ID_MIN_CHARS}..${ANONYMOUS_VISITOR_ID_MAX_CHARS} characters`,
		);
	}
	return { publicAppId, anonymousVisitorId: visitorId };
}

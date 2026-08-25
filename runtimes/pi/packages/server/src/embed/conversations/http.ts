/**
 * Conversation HTTP API（spec 27.5 / 8.2，TASK-016）。
 *
 * 端点：
 * - `POST   /api/embed/v1/conversations`                              创建（服务端固定版本；Idempotency-Key）
 * - `GET    /api/embed/v1/conversations`                              列表（opaque cursor 分页）
 * - `GET    /api/embed/v1/conversations/:id`                          会话 + 增量事件恢复
 * - `POST   /api/embed/v1/conversations/:id/archive`                  归档
 * - `GET    /api/embed/v1/conversations/:id/reasoning`               会话 reasoning 状态读取
 * - `PUT    /api/embed/v1/conversations/:id/reasoning`               会话 reasoning effort 覆盖
 *
 * 每个请求先经 `EmbedAuthenticator` 认证（Bearer Access Token，失败统一
 * 401），再以 Principal 为 scope 走 `ConversationService`；HTTP 层只负责
 * 解析/校验/信封，授权在 Service 内完成（越权 = 统一不可用）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReasoningEffort, ReasoningUpdateRequest } from "@earendil-works/pi-protocol";
import { type EmbedError, runtimeUnavailable } from "../../publishing/domain/errors.ts";
import {
	type ConversationEventId,
	type ConversationId,
	fromPublicId,
	type PublishedAppVersionId,
	type RequestId,
	toPublicId,
} from "../../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../publishing/repositories.ts";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import type { WsTicketService } from "../auth/ws-ticket.ts";
import {
	errorEnvelope,
	jsonBody,
	readJsonBody,
	readRequestId,
	respondPreflight,
	setEmbedCorsHeaders,
} from "../http-shared.ts";
import type { EmbedAuthContext, EmbedAuthenticator } from "../middleware/authenticate.ts";
import type { RateLimiter } from "../rate-limits/limiter.ts";
import type { ConversationService } from "./service.ts";

export const EMBED_CONVERSATIONS_PATH = "/api/embed/v1/conversations";
/** TASK-018 internal/dev 前缀（不构成最终公开协议）。 */
export const EMBED_DEV_CONVERSATIONS_PREFIX = "/api/embed/v1/dev/conversations";
export const EMBED_CONVERSATIONS_MAX_BODY_BYTES = 16 * 1024;
export const EMBED_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
/** 事件分页上限：单次最多 200 条（后续 Replay 走实时通道）。 */
export const EMBED_EVENTS_MAX_LIMIT = 200;
export const EMBED_EVENTS_DEFAULT_LIMIT = 50;

export interface ConversationsHttpHandlerOptions {
	readonly service: ConversationService;
	readonly authenticator: EmbedAuthenticator;
	/** 幂等记录（create 用，scope = token principal）。 */
	readonly repositories: PublishingRepositories;
	/** WebSocket Ticket 服务（TASK-024）；未配置时 ws-ticket 端点 503。 */
	readonly wsTickets?: WsTicketService;
	/** Realtime 端点基地址（spec 27.6 响应 realtimeUrl）。 */
	readonly realtimeBaseUrl?: string;
	readonly idempotencyTtlMs?: number;
	readonly maxBodyBytes?: number;
	readonly onError?: (error: unknown) => void;
	/** 分层限流（TASK-034）：ws-ticket=token 维度，dev turn=turn 维度。 */
	readonly limiter?: RateLimiter;
}

/** 请求体/查询参数校验失败（映射 400）。 */
class HttpValidationError extends Error {}

interface RouteContext {
	readonly request: IncomingMessage;
	readonly response: ServerResponse;
	readonly requestId: string;
	readonly principal: EmbedAuthContext;
	readonly conversationId?: string;
}

interface Route {
	readonly conversationId?: string;
	readonly handler: (ctx: RouteContext) => Promise<void>;
}

const CREATE_PATTERN = /^\/api\/embed\/v1\/conversations$/;
const GET_PATTERN = /^\/api\/embed\/v1\/conversations\/([^/]+)$/;
const ARCHIVE_PATTERN = /^\/api\/embed\/v1\/conversations\/([^/]+)\/archive$/;
const REASONING_PATTERN = /^\/api\/embed\/v1\/conversations\/([^/]+)\/reasoning$/;
/** TASK-018 internal/dev 文本 Turn 路径，不作为最终公开协议。 */
const DEV_TURN_PATTERN = /^\/api\/embed\/v1\/dev\/conversations\/([^/]+)\/turn$/;
/** TASK-024：一次性 WebSocket Ticket 申请端点（spec 27.6）。 */
const WS_TICKET_PATTERN = /^\/api\/embed\/v1\/conversations\/([^/]+)\/ws-ticket$/;
export const EMBED_DEV_TURN_MAX_TEXT = 32_000;

export function createConversationsHttpHandler(options: ConversationsHttpHandlerOptions): HttpRequestHandler {
	const idempotencyTtlMs = options.idempotencyTtlMs ?? EMBED_IDEMPOTENCY_TTL_MS;
	const maxBodyBytes = options.maxBodyBytes ?? EMBED_CONVERSATIONS_MAX_BODY_BYTES;
	const service = options.service;

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (
			pathname === undefined ||
			(!pathname.startsWith(EMBED_CONVERSATIONS_PATH) && !pathname.startsWith(EMBED_DEV_CONVERSATIONS_PREFIX))
		) {
			return false;
		}
		if (request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		setEmbedCorsHeaders(response, request.headers.origin);
		const requestId = readRequestId(request);
		response.setHeader("X-Request-Id", requestId);

		try {
			// 认证先行：缺失/无效/过期 token 统一 401，不泄露端点存在性。
			const principal = await options.authenticator.authenticate(request);
			if (principal instanceof Error) {
				jsonBody(response, 401, errorEnvelope(principal.code, principal.message, requestId, principal.retryable));
				return true;
			}
			const route = routeFor(request.method, pathname);
			if (route === null) {
				jsonBody(response, 404, errorEnvelope("NOT_FOUND", "Unknown conversations route", requestId, false));
				return true;
			}
			await route.handler({ request, response, requestId, principal, conversationId: route.conversationId });
			return true;
		} catch (error) {
			if (error instanceof HttpValidationError) {
				jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", error.message, requestId, false));
				return true;
			}
			options.onError?.(error);
			if (!response.headersSent) {
				jsonBody(response, 500, errorEnvelope("INTERNAL", "Internal server error", requestId, true));
			}
			return true;
		}
	};

	async function createRoute(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.request, maxBodyBytes);
		if (body.kind === "too_large") {
			jsonBody(
				ctx.response,
				413,
				errorEnvelope("PAYLOAD_TOO_LARGE", "Request body too large", ctx.requestId, false),
			);
			return;
		}
		if (body.kind === "invalid_json") {
			jsonBody(
				ctx.response,
				400,
				errorEnvelope("INVALID_JSON", "Request body must be valid JSON", ctx.requestId, false),
			);
			return;
		}
		const title = parseTitle(body.value);
		const idempotencyKey = readIdempotencyKey(ctx.request);
		if (idempotencyKey === undefined) {
			await executeCreate(ctx, title);
			return;
		}
		const scope = { tenantId: ctx.principal.tenantId, principalId: ctx.principal.principalId };
		const requestHash = `embed.conversations.create|${JSON.stringify({ title })}`;
		const began = await options.repositories.idempotency.begin(
			scope,
			"embed.conversations.create",
			idempotencyKey,
			requestHash,
			idempotencyTtlMs,
		);
		if (began.outcome === "replay") {
			jsonBody(ctx.response, began.record.responseStatus ?? 200, began.record.responseBody);
			return;
		}
		if (began.outcome === "conflict") {
			jsonBody(
				ctx.response,
				409,
				errorEnvelope(
					"IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different request",
					ctx.requestId,
					false,
				),
			);
			return;
		}
		if (began.outcome === "in_progress") {
			jsonBody(
				ctx.response,
				409,
				errorEnvelope(
					"IDEMPOTENCY_IN_PROGRESS",
					"A request with this idempotency key is already running",
					ctx.requestId,
					true,
				),
			);
			return;
		}
		const envelope = await buildCreateEnvelope(ctx, title);
		await options.repositories.idempotency.complete(
			scope,
			"embed.conversations.create",
			idempotencyKey,
			envelope.status,
			envelope.body,
		);
		jsonBody(ctx.response, envelope.status, envelope.body);
	}

	async function executeCreate(ctx: RouteContext, title: string): Promise<void> {
		const envelope = await buildCreateEnvelope(ctx, title);
		jsonBody(ctx.response, envelope.status, envelope.body);
	}

	async function buildCreateEnvelope(ctx: RouteContext, title: string): Promise<{ status: number; body: unknown }> {
		const result = await service.createConversation({ principal: ctx.principal, title });
		if (!result.ok) {
			return {
				status: result.error.httpStatus,
				body: errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
			};
		}
		return {
			status: 201,
			body: {
				data: {
					conversation: conversationView(result.data.conversation),
					rollover: result.data.rollover,
				},
				requestId: ctx.requestId,
			},
		};
	}

	async function listRoute(ctx: RouteContext): Promise<void> {
		const query = parseQuery(ctx.request.url);
		const limit = parsePositiveInt(query.get("limit"), 20, 100, "limit");
		const cursor = query.get("cursor") ?? undefined;
		const result = await service.listConversations({ principal: ctx.principal, limit, cursor });
		if (!result.ok) {
			jsonBody(
				ctx.response,
				result.error.httpStatus,
				errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
			);
			return;
		}
		const items = result.data;
		const nextCursor = items.length === limit ? (items.at(-1)!.cursor ?? null) : null;
		jsonBody(ctx.response, 200, {
			data: { items: items.map(conversationView), nextCursor },
			requestId: ctx.requestId,
		});
	}

	async function getRoute(ctx: RouteContext): Promise<void> {
		const conversationId = parseConversationId(ctx);
		if (conversationId === null) return;
		const query = parseQuery(ctx.request.url);
		const afterSequence = parseOptionalNonNegativeInt(query.get("afterSequence"), "afterSequence");
		const limit = parsePositiveInt(query.get("limit"), EMBED_EVENTS_DEFAULT_LIMIT, EMBED_EVENTS_MAX_LIMIT, "limit");
		const conversation = await service.getConversation({ principal: ctx.principal, conversationId });
		if (!conversation.ok) {
			jsonBody(
				ctx.response,
				conversation.error.httpStatus,
				errorEnvelope(
					conversation.error.code,
					conversation.error.message,
					ctx.requestId,
					conversation.error.retryable,
				),
			);
			return;
		}
		const events = await service.listEvents({ principal: ctx.principal, conversationId, afterSequence, limit });
		if (!events.ok) {
			jsonBody(
				ctx.response,
				events.error.httpStatus,
				errorEnvelope(events.error.code, events.error.message, ctx.requestId, events.error.retryable),
			);
			return;
		}
		jsonBody(ctx.response, 200, {
			data: {
				conversation: conversationView(conversation.data),
				events: events.data.map(eventView),
			},
			requestId: ctx.requestId,
		});
	}

	async function updateReasoningRoute(ctx: RouteContext): Promise<void> {
		const conversationId = parseConversationId(ctx);
		if (conversationId === null) return;
		const body = await readJsonBody(ctx.request, maxBodyBytes);
		if (body.kind === "too_large") {
			jsonBody(
				ctx.response,
				413,
				errorEnvelope("PAYLOAD_TOO_LARGE", "Request body too large", ctx.requestId, false),
			);
			return;
		}
		if (body.kind === "invalid_json") {
			jsonBody(
				ctx.response,
				400,
				errorEnvelope("INVALID_JSON", "Request body must be valid JSON", ctx.requestId, false),
			);
			return;
		}
		const parsed = parseReasoningUpdate(body.value, ctx.requestId);
		if (!parsed.ok) {
			jsonBody(ctx.response, parsed.status, parsed.envelope);
			return;
		}
		const result = await service.setConversationReasoning({
			principal: ctx.principal,
			conversationId,
			request: parsed.body,
			requestId: ctx.requestId as RequestId,
		});
		if (!result.ok) {
			jsonBody(
				ctx.response,
				result.error.httpStatus,
				errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
			);
			return;
		}
		jsonBody(ctx.response, 200, { data: result.data, requestId: ctx.requestId });
	}

	async function getReasoningRoute(ctx: RouteContext): Promise<void> {
		const conversationId = parseConversationId(ctx);
		if (conversationId === null) return;
		const result = await service.getConversationReasoning({ principal: ctx.principal, conversationId });
		if (!result.ok) {
			jsonBody(
				ctx.response,
				result.error.httpStatus,
				errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
			);
			return;
		}
		jsonBody(ctx.response, 200, { data: result.data, requestId: ctx.requestId });
	}

	async function archiveRoute(ctx: RouteContext): Promise<void> {
		const conversationId = parseConversationId(ctx);
		if (conversationId === null) return;
		const result = await service.archiveConversation({ principal: ctx.principal, conversationId });
		if (!result.ok) {
			jsonBody(
				ctx.response,
				result.error.httpStatus,
				errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
			);
			return;
		}
		jsonBody(ctx.response, 200, { data: conversationView(result.data), requestId: ctx.requestId });
	}

	async function devTurnRoute(ctx: RouteContext): Promise<void> {
		const conversationId = parseConversationId(ctx);
		if (conversationId === null) return;
		const body = await readJsonBody(ctx.request, maxBodyBytes);
		if (body.kind === "too_large") {
			jsonBody(
				ctx.response,
				413,
				errorEnvelope("PAYLOAD_TOO_LARGE", "Request body too large", ctx.requestId, false),
			);
			return;
		}
		if (body.kind === "invalid_json") {
			jsonBody(
				ctx.response,
				400,
				errorEnvelope("INVALID_JSON", "Request body must be valid JSON", ctx.requestId, false),
			);
			return;
		}
		const text = parseTurnText(body.value);
		const idempotencyKey = readIdempotencyKey(ctx.request);
		if (idempotencyKey === undefined) {
			await executeDevTurn(ctx, conversationId, text);
			return;
		}
		const scope = { tenantId: ctx.principal.tenantId, principalId: ctx.principal.principalId };
		const requestHash = `embed.turns.execute|${conversationId}|${JSON.stringify({ text })}`;
		const began = await options.repositories.idempotency.begin(
			scope,
			"embed.turns.execute",
			idempotencyKey,
			requestHash,
			idempotencyTtlMs,
		);
		if (began.outcome === "replay") {
			jsonBody(ctx.response, began.record.responseStatus ?? 200, began.record.responseBody);
			return;
		}
		if (began.outcome === "conflict") {
			jsonBody(
				ctx.response,
				409,
				errorEnvelope(
					"IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different request",
					ctx.requestId,
					false,
				),
			);
			return;
		}
		if (began.outcome === "in_progress") {
			jsonBody(
				ctx.response,
				409,
				errorEnvelope(
					"IDEMPOTENCY_IN_PROGRESS",
					"A request with this idempotency key is already running",
					ctx.requestId,
					true,
				),
			);
			return;
		}
		const envelope = await buildDevTurnEnvelope(ctx, conversationId, text);
		await options.repositories.idempotency.complete(
			scope,
			"embed.turns.execute",
			idempotencyKey,
			envelope.status,
			envelope.body,
		);
		jsonBody(ctx.response, envelope.status, envelope.body);
	}

	async function wsTicketRoute(ctx: RouteContext): Promise<void> {
		const conversationId = parseConversationId(ctx);
		if (conversationId === null) return;
		// TASK-034：Token 维度限流（按 Principal；超限 429）。
		if (options.limiter !== undefined) {
			const allowed = await options.limiter.check({
				dimension: "token",
				scope: principalScope(ctx.principal),
			});
			if (!allowed.allowed) {
				jsonBody(ctx.response, 429, errorEnvelope("RATE_LIMITED", "Rate limit exceeded", ctx.requestId, true));
				return;
			}
		}
		if (options.wsTickets === undefined) {
			const error: EmbedError = runtimeUnavailable("WebSocket tickets are not configured");
			jsonBody(
				ctx.response,
				error.httpStatus,
				errorEnvelope(error.code, error.message, ctx.requestId, error.retryable),
			);
			return;
		}
		const owned = await service.getConversation({ principal: ctx.principal, conversationId });
		if (!owned.ok) {
			jsonBody(
				ctx.response,
				owned.error.httpStatus,
				errorEnvelope(owned.error.code, owned.error.message, ctx.requestId, owned.error.retryable),
			);
			return;
		}
		const issued = await options.wsTickets.issue({
			tenantId: ctx.principal.tenantId,
			publishedAppId: ctx.principal.publishedAppId,
			principalId: ctx.principal.principalId,
			principalType: ctx.principal.principalType,
			tokenId: ctx.principal.tokenId,
			conversationId,
			origin: ctx.request.headers.origin,
			publishedAppVersionId: ctx.principal.publishedAppVersionId,
		});
		const base = (options.realtimeBaseUrl ?? "").replace(/\/$/, "");
		jsonBody(ctx.response, 200, {
			data: {
				ticket: issued.ticket,
				expiresAt: issued.expiresAt.toISOString(),
				realtimeUrl: `${base}/api/embed/v1/realtime`,
			},
			requestId: ctx.requestId,
		});
	}

	async function executeDevTurn(ctx: RouteContext, conversationId: ConversationId, text: string): Promise<void> {
		const envelope = await buildDevTurnEnvelope(ctx, conversationId, text);
		jsonBody(ctx.response, envelope.status, envelope.body);
	}

	async function buildDevTurnEnvelope(
		ctx: RouteContext,
		conversationId: ConversationId,
		text: string,
	): Promise<{ status: number; body: unknown }> {
		// TASK-034：dev turn 的 turn 维度分层限流（并发槽在 Realtime 连接路径）。
		if (options.limiter !== undefined) {
			const allowed = await options.limiter.check({
				dimension: "turn",
				scope: { ...principalScope(ctx.principal), conversationId },
			});
			if (!allowed.allowed) {
				return {
					status: 429,
					body: errorEnvelope("RATE_LIMITED", "Rate limit exceeded", ctx.requestId, true),
				};
			}
		}
		const result = await service.executeTurn({ principal: ctx.principal, conversationId, text });
		if (!result.ok) {
			return {
				status: result.error.httpStatus,
				body: errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
			};
		}
		return {
			status: 200,
			body: {
				data: {
					turnId: toPublicId("TurnId", result.data.turnId),
					userMessageSequence: result.data.userMessageSequence,
					assistantSequence: result.data.assistantSequence,
					outputText: result.data.outputText,
				},
				requestId: ctx.requestId,
			},
		};
	}

	function routeFor(method: string | undefined, pathname: string): Route | null {
		if (method === "POST" && CREATE_PATTERN.test(pathname)) return { handler: createRoute };
		if (method === "GET" && CREATE_PATTERN.test(pathname)) return { handler: listRoute };
		const getMatch = method === "GET" ? pathname.match(GET_PATTERN) : null;
		if (getMatch !== null) return { conversationId: getMatch[1], handler: getRoute };
		const archiveMatch = method === "POST" ? pathname.match(ARCHIVE_PATTERN) : null;
		if (archiveMatch !== null) return { conversationId: archiveMatch[1], handler: archiveRoute };
		const reasoningMatch = method === "PUT" ? pathname.match(REASONING_PATTERN) : null;
		if (reasoningMatch !== null) return { conversationId: reasoningMatch[1], handler: updateReasoningRoute };
		const reasoningGetMatch = method === "GET" ? pathname.match(REASONING_PATTERN) : null;
		if (reasoningGetMatch !== null) return { conversationId: reasoningGetMatch[1], handler: getReasoningRoute };
		const devTurnMatch = method === "POST" ? pathname.match(DEV_TURN_PATTERN) : null;
		if (devTurnMatch !== null) return { conversationId: devTurnMatch[1], handler: devTurnRoute };
		const wsTicketMatch = method === "POST" ? pathname.match(WS_TICKET_PATTERN) : null;
		if (wsTicketMatch !== null) return { conversationId: wsTicketMatch[1], handler: wsTicketRoute };
		return null;
	}

	function conversationView(record: {
		conversationId: ConversationId;
		publishedAppVersionId: PublishedAppVersionId;
		status: string;
		title: string;
		lastEventSequence: number;
		createdAt: Date;
	}): Record<string, unknown> {
		return {
			id: toPublicId("ConversationId", record.conversationId),
			publishedAppVersionId: toPublicId("PublishedAppVersionId", record.publishedAppVersionId),
			status: record.status,
			title: record.title,
			lastEventSequence: record.lastEventSequence,
			createdAt: record.createdAt.toISOString(),
		};
	}

	function eventView(event: {
		eventId: ConversationEventId;
		sequence: number;
		eventType: string;
		turnId: string | null;
		payload: unknown;
		createdAt: Date;
	}): Record<string, unknown> {
		return {
			id: toPublicId("ConversationEventId", event.eventId),
			sequence: event.sequence,
			eventType: event.eventType,
			turnId: event.turnId,
			payload: event.payload,
			createdAt: event.createdAt.toISOString(),
		};
	}
}

function parseTitle(body: unknown): string {
	if (body === undefined) return "";
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new HttpValidationError("request body must be a JSON object");
	}
	const title = (body as Record<string, unknown>).title;
	if (title === undefined) return "";
	if (typeof title !== "string" || title.length > 200) {
		throw new HttpValidationError("title must be a string of at most 200 characters");
	}
	return title;
}

function parseTurnText(body: unknown): string {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new HttpValidationError("request body must be a JSON object");
	}
	const text = (body as Record<string, unknown>).text;
	if (typeof text !== "string" || text.trim() === "") {
		throw new HttpValidationError("text must be a non-empty string");
	}
	if (text.length > EMBED_DEV_TURN_MAX_TEXT) {
		throw new HttpValidationError(`text must be at most ${EMBED_DEV_TURN_MAX_TEXT} characters`);
	}
	return text;
}

function parseConversationId(ctx: RouteContext): ConversationId | null {
	if (ctx.conversationId === undefined) return null;
	const parsed = fromPublicId("ConversationId", ctx.conversationId);
	if (parsed === null) {
		jsonBody(
			ctx.response,
			400,
			errorEnvelope("INVALID_REQUEST", "conversationId must be a conv_<uuid> id", ctx.requestId, false),
		);
		return null;
	}
	return parsed;
}

function parsePositiveInt(raw: string | null | undefined, fallback: number, max: number, label: string): number {
	if (raw === null || raw === undefined || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) throw new HttpValidationError(`${label} must be a positive integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new HttpValidationError(`${label} must be between 1 and ${max}`);
	}
	return value;
}

function parseOptionalNonNegativeInt(raw: string | null | undefined, label: string): number | undefined {
	if (raw === null || raw === undefined || raw === "") return undefined;
	if (!/^\d+$/.test(raw)) throw new HttpValidationError(`${label} must be a non-negative integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0)
		throw new HttpValidationError(`${label} must be a non-negative integer`);
	return value;
}

function parseQuery(url: string | undefined): Map<string, string> {
	const query = new URL(url ?? "/", "http://embed.invalid").searchParams;
	const out = new Map<string, string>();
	for (const [key, value] of query) out.set(key, value);
	return out;
}

/** 限流 scope：Principal 标识（conversationId 由调用方按需叠加）。 */
function principalScope(principal: EmbedAuthContext): {
	readonly tenantId: string;
	readonly publishedAppId: string;
	readonly principalId: string;
} {
	return {
		tenantId: principal.tenantId,
		publishedAppId: principal.publishedAppId,
		principalId: principal.principalId,
	};
}

function readIdempotencyKey(request: IncomingMessage): string | undefined {
	const header = request.headers["idempotency-key"];
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Stable Agent V2 reasoning tiers accepted at the embed HTTP boundary. */
const EMBED_REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Parse + shape-validate a `ReasoningUpdateRequest`. Shape errors map to 400;
 * a string effort that is not a protocol tier maps to 422 REASONING_INVALID_EFFORT. */
function parseReasoningUpdate(
	value: unknown,
	requestId: string,
):
	| { readonly ok: true; readonly body: ReasoningUpdateRequest }
	| { readonly ok: false; readonly status: number; readonly envelope: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {
			ok: false,
			status: 400,
			envelope: errorEnvelope("INVALID_REQUEST", "reasoning body must be an object", requestId, false),
		};
	}
	const record = value as Record<string, unknown>;
	if (!Object.hasOwn(record, "effort")) {
		return {
			ok: false,
			status: 400,
			envelope: errorEnvelope("INVALID_REQUEST", "reasoning body must contain an effort field", requestId, false),
		};
	}
	const extra = Object.keys(record).filter((key) => key !== "effort");
	if (extra.length > 0) {
		return {
			ok: false,
			status: 400,
			envelope: errorEnvelope(
				"INVALID_REQUEST",
				"reasoning body must not contain additional fields",
				requestId,
				false,
			),
		};
	}
	const effort = record.effort;
	if (effort === null) return { ok: true, body: { effort: null } };
	if (typeof effort !== "string") {
		return {
			ok: false,
			status: 400,
			envelope: errorEnvelope("INVALID_REQUEST", "effort must be null or a string", requestId, false),
		};
	}
	if (!EMBED_REASONING_EFFORTS.has(effort as ReasoningEffort)) {
		return {
			ok: false,
			status: 422,
			envelope: errorEnvelope(
				"REASONING_INVALID_EFFORT",
				"effort is not one of the supported reasoning tiers",
				requestId,
				false,
			),
		};
	}
	return { ok: true, body: { effort: effort as ReasoningEffort } };
}

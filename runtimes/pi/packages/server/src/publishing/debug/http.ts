/**
 * Debug Conversation control HTTP handler (Phase 1 + 2E, admin workbench).
 *
 * Routes (all behind control-plane admin auth):
 *
 *   GET  /api/control/v1/debug-conversations?agentId=<id>&limit=<n>
 *                                                                  list active history
 *   GET  /api/control/v1/debug-conversations/recent?agentId=<id>  resume most recent active
 *   POST /api/control/v1/debug-conversations { agentId }          create a NEW active conversation
 *   GET  /api/control/v1/debug-conversations/{id}/events          list events (reload restore)
 *   POST /api/control/v1/debug-conversations/{id}/messages { text, turnId? }  execute a turn
 *
 * Phase 2E convention: the base collection path is `GET` = list (matches the
 * production `GET /api/control/v1/conversations` style); the singular "resume
 * most recent" is its own sub-path so the two never collide on query-param
 * heuristics.
 *
 * Revision is resolved server-side per Turn (`followLatest`); the client never
 * submits a revision number, so changing an Agent revision keeps the same
 * conversation id and history.
 */
import type { IncomingMessage } from "node:http";
import { errorEnvelope, readJsonBody, readRequestId } from "../../embed/http-shared.ts";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import { jsonBody } from "../../web/http-shared.ts";
import { type AgentDefinitionId, type DebugConversationId, fromPublicId, parseId, toPublicId } from "../domain/ids.ts";
import type { DebugConversationService } from "./service.ts";
import type { DebugConversationEventRecord, DebugConversationRecord } from "./types.ts";

const BASE = "/api/control/v1/debug-conversations";
const RECENT_PATTERN = /^\/api\/control\/v1\/debug-conversations\/recent$/;
const MESSAGE_PATTERN = /^\/api\/control\/v1\/debug-conversations\/([^/]+)\/messages$/;
const EVENTS_PATTERN = /^\/api\/control\/v1\/debug-conversations\/([^/]+)\/events$/;
const MAX_BODY_BYTES = 128 * 1024;

export function createAdminDebugConversationHandler(options: {
	readonly service: DebugConversationService;
	readonly isAuthorized: (request: IncomingMessage) => boolean;
}): HttpRequestHandler {
	const { service, isAuthorized } = options;

	const handler: HttpRequestHandler = async (request, response) => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || (!pathname.startsWith(`${BASE}/`) && pathname !== BASE)) return false;
		const requestId = readRequestId(request);
		if (!isAuthorized(request)) {
			jsonBody(response, 401, errorEnvelope("UNAUTHORIZED", "Unauthorized", requestId, false));
			return true;
		}
		try {
			const query = queryAgentId(request);
			// Phase 2E: GET on the base path is the History list (collection
			// semantics, matching `GET /api/control/v1/conversations`).
			if (request.method === "GET" && pathname === BASE) {
				const agentId = parseAgentId(query);
				if (agentId === null) {
					return badRequest(response, requestId, "agentId is required for debug conversation list");
				}
				const limit = queryLimit(request);
				const items = await service.listHistory(agentId, limit);
				jsonBody(response, 200, { data: { items }, requestId });
				return true;
			}
			// Phase 2E: resume-most-recent moved to a dedicated sub-path so the
			// list endpoint and the resume endpoint never share query semantics.
			const recentMatch = pathname.match(RECENT_PATTERN);
			if (request.method === "GET" && recentMatch !== null) {
				const agentId = parseAgentId(query);
				const conversation = agentId === null ? undefined : await service.resume(agentId);
				const events = conversation === undefined ? [] : await service.listEvents(conversation.debugConversationId);
				jsonBody(response, 200, {
					data: { conversation: toConversationDto(conversation), events: toEventDtos(events) },
					requestId,
				});
				return true;
			}
			if (request.method === "POST" && pathname === BASE) {
				const body = await readJsonBody(request, MAX_BODY_BYTES);
				if (body.kind !== "ok" || !isRecord(body.value) || typeof body.value.agentId !== "string") {
					return invalid(response, requestId);
				}
				const agentId = parseAgentId(body.value.agentId);
				if (agentId === null) return invalid(response, requestId);
				const conversation = await service.createNew(agentId);
				jsonBody(response, 201, { data: { conversation: toConversationDto(conversation), events: [] }, requestId });
				return true;
			}
			const messageMatch = pathname.match(MESSAGE_PATTERN);
			if (request.method === "POST" && messageMatch !== null) {
				const conversationId = parseConversationId(messageMatch[1]);
				if (conversationId === null) return unavailable(response, requestId);
				const body = await readJsonBody(request, MAX_BODY_BYTES);
				if (body.kind !== "ok" || !isRecord(body.value) || typeof body.value.text !== "string") {
					return invalid(response, requestId);
				}
				const text = body.value.text;
				if (text.trim() === "") return invalid(response, requestId);
				const turnId =
					typeof body.value.turnId === "string" && body.value.turnId.length > 0
						? (parseId("TurnId", body.value.turnId) ?? undefined)
						: undefined;
				const attachmentIds = Array.isArray(body.value.attachmentIds)
					? body.value.attachmentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
					: undefined;
				if (Array.isArray(body.value.attachmentIds) && attachmentIds?.length !== body.value.attachmentIds.length) {
					return invalid(response, requestId);
				}
				const result = await service.executeTurn(conversationId, text, turnId, { attachmentIds });
				if (!result.ok) {
					jsonBody(response, 422, errorEnvelope("DEBUG_TURN_FAILED", result.error, requestId, false));
					return true;
				}
				jsonBody(response, 200, {
					data: {
						conversation: toConversationDto(result.conversation),
						turn: {
							turnId: toPublicId("TurnId", result.turnId),
							outputText: result.outputText,
							...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
						},
					},
					requestId,
				});
				return true;
			}
			const eventsMatch = pathname.match(EVENTS_PATTERN);
			if (request.method === "GET" && eventsMatch !== null) {
				const conversationId = parseConversationId(eventsMatch[1]);
				if (conversationId === null) return unavailable(response, requestId);
				const afterSequence = queryAfterSequence(request);
				const events = await service.listEvents(conversationId, afterSequence);
				jsonBody(response, 200, { data: toEventDtos(events), requestId });
				return true;
			}
			jsonBody(response, 405, errorEnvelope("METHOD_NOT_ALLOWED", "Method not allowed", requestId, false));
			return true;
		} catch {
			jsonBody(
				response,
				500,
				errorEnvelope("DEBUG_CONVERSATION_FAILED", "Debug conversation operation failed", requestId, true),
			);
			return true;
		}
	};
	return handler;
}

function parseAgentId(value: string | null): AgentDefinitionId | null {
	if (value === null) return null;
	return fromPublicId("AgentDefinitionId", value);
}

function parseConversationId(value: string): DebugConversationId | null {
	const publicId = fromPublicId("DebugConversationId", value);
	if (publicId !== null) return publicId;
	return parseId("DebugConversationId", value);
}

function queryAgentId(request: IncomingMessage): string | null {
	const url = safeUrl(request.url);
	return url?.searchParams.get("agentId") ?? null;
}

/**
 * Phase 2E: optional `?limit=N` on the History list. The service layer
 * re-clamps the value; this parser only returns `undefined` for absent /
 * non-integer / negative input so the service picks the default.
 */
function queryLimit(request: IncomingMessage): number | undefined {
	const url = safeUrl(request.url);
	const raw = url?.searchParams.get("limit");
	if (raw === null || raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

function queryAfterSequence(request: IncomingMessage): number {
	const url = safeUrl(request.url);
	const raw = url?.searchParams.get("afterSequence");
	if (raw === null || raw === undefined) return 0;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeUrl(value: string | undefined | null): URL | null {
	if (value === undefined || value === null) return null;
	try {
		return new URL(value, "http://localhost");
	} catch {
		return null;
	}
}

function toConversationDto(conversation: DebugConversationRecord | undefined): object | null {
	if (conversation === undefined) return null;
	return {
		conversationId: toPublicId("DebugConversationId", conversation.debugConversationId),
		agentId: conversation.agentId === null ? null : toPublicId("AgentDefinitionId", conversation.agentId),
		status: conversation.status,
		lastActiveAt: conversation.lastActiveAt.toISOString(),
		lastEventSequence: conversation.lastEventSequence,
	};
}

function toEventDtos(events: readonly DebugConversationEventRecord[]): object[] {
	return events.map((event) => ({
		eventId: toPublicId("DebugConversationEventId", event.eventId),
		sequence: event.sequence,
		eventType: event.eventType,
		turnId: event.turnId === null ? null : toPublicId("TurnId", event.turnId),
		payload: event.payload,
		createdAt: event.createdAt.toISOString(),
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(response: Parameters<HttpRequestHandler>[1], requestId: string): true {
	jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", "Invalid debug conversation request", requestId, false));
	return true;
}

function badRequest(response: Parameters<HttpRequestHandler>[1], requestId: string, message: string): true {
	jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", message, requestId, false));
	return true;
}

function unavailable(response: Parameters<HttpRequestHandler>[1], requestId: string): true {
	jsonBody(
		response,
		404,
		errorEnvelope("DEBUG_CONVERSATION_NOT_FOUND", "Debug conversation unavailable", requestId, false),
	);
	return true;
}

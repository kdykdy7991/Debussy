/**
 * TTS HTTP adapter for the embed data plane (spec 15 / TASK-036).
 *
 * Routes under `/api/embed/v1/conversations/:convId/tts`:
 * - `GET    .../tts`       -> speech feature flag + shared queue stats
 * - `POST   .../tts`       -> enqueue a synthesis job (202 + jobId), gated by
 *                             the app's RuntimeSpec `capabilities.speech`
 * - `DELETE .../tts/:jobId`-> cancel a job (cross-session allowed by id)
 *
 * Errors are interpretable and never leak identity: 401 unauthenticated,
 * 503 `SPEECH_DISABLED` (not enabled or auto-degraded to text), 503
 * `TTS_UNAVAILABLE` (no provider configured), 429 `QUEUE_FULL` (bounded queue).
 * A speech failure never affects the text turn path.
 */
import { randomUUID } from "node:crypto";
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
import type { EmbedAuthContext, EmbedAuthenticator } from "../middleware/authenticate.ts";
import type { EmbedTtsError } from "./provider.ts";
import type { EmbedTtsQueue } from "./queue.ts";

export const EMBED_TTS_PATH_PREFIX = "/api/embed/v1/conversations";

export interface TtsHttpHandlerOptions {
	readonly authenticator: EmbedAuthenticator;
	readonly queue: EmbedTtsQueue;
	/** Resolve whether speech is enabled for this conversation's app version. */
	readonly speechEnabled: (principal: EmbedAuthContext, conversationId: string) => Promise<boolean>;
	/** True when a shared TTS provider is configured. */
	readonly providerAvailable: boolean;
	readonly maxBodyBytes?: number;
}

interface TtsBody {
	readonly text: string;
	readonly voice?: string;
}

/** Extract the trailing jobId from `.../tts/:jobId`, or null. */
function parseTtsPath(pathname: string): { convId: string; jobId: string | null } | null {
	const prefix = `${EMBED_TTS_PATH_PREFIX}/`;
	if (!pathname.startsWith(prefix)) return null;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith("/tts")) {
		const ttsAt = rest.indexOf("/tts/");
		if (ttsAt === -1) return null;
		const convId = rest.slice(0, ttsAt);
		const jobId = rest.slice(ttsAt + "/tts/".length);
		if (convId === "" || jobId === "" || jobId.includes("/")) return null;
		return { convId, jobId };
	}
	return { convId: rest.slice(0, rest.length - "/tts".length), jobId: null };
}

function parseTtsBody(body: unknown): TtsBody | "invalid" {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return "invalid";
	const record = body as Record<string, unknown>;
	const text = record.text;
	if (typeof text !== "string" || text.length === 0 || text.length > 4096) return "invalid";
	if (record.voice !== undefined && typeof record.voice !== "string") return "invalid";
	return { text, voice: record.voice };
}

export function createTtsHttpHandler(options: TtsHttpHandlerOptions): HttpRequestHandler {
	const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined) return false;
		// Only claim TTS sub-routes (`.../conversations/:id/tts[/:jobId]`);
		// everything else on the conversations family belongs to other handlers.
		const parsed = parseTtsPath(pathname);
		if (parsed === null) return false;
		if (request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		setEmbedCorsHeaders(response, request.headers.origin);
		const requestId = readRequestId(request);
		response.setHeader("X-Request-Id", requestId);

		const principal = await options.authenticator.authenticate(request);
		if (principal instanceof Error) {
			jsonBody(response, 401, errorEnvelope(principal.code, principal.message, requestId, principal.retryable));
			return true;
		}
		const conversationId = parsed.convId;

		if (request.method === "GET") {
			const enabled = await options.speechEnabled(principal, conversationId);
			jsonBody(response, 200, {
				data: {
					enabled,
					providerAvailable: options.providerAvailable,
					queue: options.queue.stats(),
				},
				requestId,
			});
			return true;
		}

		if (request.method === "DELETE") {
			if (parsed.jobId === null) {
				jsonBody(response, 404, errorEnvelope("NOT_FOUND", "jobId required", requestId, false));
				return true;
			}
			options.queue.cancel(parsed.jobId);
			jsonBody(response, 200, { data: { cancelled: true }, requestId });
			return true;
		}

		if (request.method !== "POST") {
			jsonBody(response, 405, errorEnvelope("METHOD_NOT_ALLOWED", "Method not allowed", requestId, false));
			return true;
		}

		// Speech gate: enabled for this app version, otherwise degrade to text.
		if (!(await options.speechEnabled(principal, conversationId))) {
			jsonBody(
				response,
				503,
				errorEnvelope("SPEECH_DISABLED", "Speech is not enabled for this app", requestId, false),
			);
			return true;
		}
		if (!options.providerAvailable) {
			jsonBody(response, 503, errorEnvelope("TTS_UNAVAILABLE", "No speech provider is configured", requestId, true));
			return true;
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
		const body = parseTtsBody(raw.value);
		if (body === "invalid") {
			jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", "text (1..4096 chars) required", requestId, false));
			return true;
		}

		const result = options.queue.enqueue({ id: randomUUID(), conversationId, text: body.text, voice: body.voice });
		if (!result.ok) {
			jsonBody(
				response,
				429,
				errorEnvelope(toHttpErrorCode(result.error), result.error.message, requestId, result.error.retryable),
			);
			return true;
		}
		jsonBody(response, 202, {
			data: { jobId: result.handle.id, position: result.position, status: "queued" },
			requestId,
		});
		return true;
	};
}

function toHttpErrorCode(error: EmbedTtsError): string {
	switch (error.code) {
		case "queue_full":
			return "QUEUE_FULL";
		case "timeout":
			return "SPEECH_TIMEOUT";
		case "cancelled":
			return "SPEECH_CANCELLED";
		case "provider":
			return "SPEECH_PROVIDER";
		default:
			return "SPEECH_ERROR";
	}
}

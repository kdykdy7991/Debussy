import type { IncomingMessage, ServerResponse } from "node:http";
import { runtimeUnavailable } from "../publishing/domain/errors.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import type { VoiceProxyTicketService } from "./auth/voice-proxy-ticket.ts";
import { errorEnvelope, jsonBody, readRequestId, respondPreflight, setEmbedCorsHeaders } from "./http-shared.ts";
import type { EmbedAuthenticator } from "./middleware/authenticate.ts";

export const VOICE_ENGINE_TICKET_PATH = "/api/embed/v1/voice-engine/ws-ticket";

export function createVoiceEngineTicketHttpHandler(options: {
	readonly authenticator: EmbedAuthenticator;
	readonly repositories: PublishingRepositories;
	readonly tickets?: VoiceProxyTicketService;
	readonly voiceEnginePath?: string;
	readonly onError?: (error: unknown) => void;
}): HttpRequestHandler {
	return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
		if (requestPathname(request.url) !== VOICE_ENGINE_TICKET_PATH) return false;
		if (request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		setEmbedCorsHeaders(response, request.headers.origin);
		const requestId = readRequestId(request);
		response.setHeader("X-Request-Id", requestId);
		if (request.method !== "POST") {
			jsonBody(response, 404, errorEnvelope("NOT_FOUND", "Unknown voice engine route", requestId, false));
			return true;
		}
		try {
			const principal = await options.authenticator.authenticate(request);
			if (principal instanceof Error) {
				jsonBody(response, 401, errorEnvelope(principal.code, principal.message, requestId, principal.retryable));
				return true;
			}
			if (options.tickets === undefined) {
				const error = runtimeUnavailable("Voice Engine tickets are not configured");
				jsonBody(response, error.httpStatus, errorEnvelope(error.code, error.message, requestId, error.retryable));
				return true;
			}
			const version = await options.repositories.publishedAppVersions.get(
				{ tenantId: principal.tenantId, publishedAppId: principal.publishedAppId },
				principal.publishedAppVersionId,
			);
			if (!runtimeSpecAllowsRealtimeVoice(version?.runtimeSpec)) {
				jsonBody(
					response,
					403,
					errorEnvelope("FEATURE_DISABLED", "Realtime voice is not enabled", requestId, false),
				);
				return true;
			}
			const issued = await options.tickets.issue({
				tenantId: principal.tenantId,
				publishedAppId: principal.publishedAppId,
				principalId: principal.principalId,
				principalType: principal.principalType,
				tokenId: principal.tokenId,
				origin: request.headers.origin,
			});
			jsonBody(response, 200, {
				data: {
					ticket: issued.ticket,
					expiresAt: issued.expiresAt.toISOString(),
					voiceEngineUrl: options.voiceEnginePath ?? "/api/voice-engine/v1/ws",
				},
				requestId,
			});
			return true;
		} catch (error) {
			options.onError?.(error);
			const unavailable = runtimeUnavailable("Voice Engine ticket unavailable");
			jsonBody(
				response,
				unavailable.httpStatus,
				errorEnvelope(unavailable.code, unavailable.message, requestId, unavailable.retryable),
			);
			return true;
		}
	};
}

export function runtimeSpecAllowsRealtimeVoice(runtimeSpec: unknown): boolean {
	const parsed = parseRuntimeSpec(runtimeSpec);
	return parsed.ok && parsed.spec.capabilities.realtimeVoice.enabled;
}

/**
 * Browser-facing live PCM stream route: `GET/OPTIONS
 * /api/pi/v4/live-speech/{jobId}/stream`.
 *
 * Auth/CORS/Host handling is fully reused from `createHttpAuthorizer`. The
 * stream itself is driven by the job's utterance queue through a deferred
 * `PendingPcmSink` — this handler only claims the job and attaches the
 * response; the queue (via the sink) writes headers on the first PCM byte,
 * applies backpressure, and ends/204/502s on terminal.
 */

import type { ServerResponse } from "node:http";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import { LIVE_SPEECH_STREAM_PATH_PREFIX, type LiveSpeechManager } from "../voice/live/live-speech-manager.ts";
import { createHttpAuthorizer, errorBody } from "./http-shared.ts";

const STREAM_SUFFIX = "/stream";

export interface LiveSpeechHttpHandlerOptions {
	/** Lazily resolve the active LiveSpeechManager; absent when live is not configured. */
	getLiveSpeechManager: () => LiveSpeechManager | undefined;
	/** Expected `Authorization: Bearer <token>`. When undefined, no Bearer check is applied. */
	webToken?: string;
	/** Exact or wildcard Origin allowlist, mirroring the WebSocket listener. */
	allowedOrigins?: readonly string[];
	/** Host header allowlist, mirroring the WebSocket listener. */
	allowedHosts?: readonly string[];
	onError?: (error: unknown) => void;
}

function liveSpeechJobIdFrom(pathname: string | undefined): string | undefined {
	if (!pathname) return undefined;
	const prefix = `${LIVE_SPEECH_STREAM_PATH_PREFIX}/`;
	if (!pathname.startsWith(prefix)) return undefined;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith(STREAM_SUFFIX)) return undefined;
	const jobId = rest.slice(0, -STREAM_SUFFIX.length);
	if (!jobId || jobId.includes("/")) return undefined;
	return decodeURIComponent(jobId);
}

/** Browser-facing live PCM stream proxy. PCM never enters the WebSocket protocol. */
export function createLiveSpeechHttpHandler(options: LiveSpeechHttpHandlerOptions): HttpRequestHandler {
	const { originAllowed, setCorsHeaders, authorize } = createHttpAuthorizer({
		webToken: options.webToken,
		allowedOrigins: options.allowedOrigins,
		allowedHosts: options.allowedHosts,
	});

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		const jobId = liveSpeechJobIdFrom(pathname);
		if (jobId === undefined) return false;

		const origin = request.headers.origin;
		setCorsHeaders(response, origin);
		if (request.method === "OPTIONS") {
			if (!originAllowed(origin)) {
				errorBody(response, { status: 403, code: "forbidden", message: "Origin is not allowed" });
				return true;
			}
			response.writeHead(204);
			response.end();
			return true;
		}
		const authorization = authorize(request);
		if (authorization) {
			errorBody(response, authorization);
			return true;
		}
		if (request.method !== "GET") {
			errorBody(response, { status: 405, code: "invalid_request", message: "Method not allowed" });
			return true;
		}
		handleStream(jobId, response, options);
		return true;
	};
}

function handleStream(jobId: string, response: ServerResponse, options: LiveSpeechHttpHandlerOptions): void {
	const manager = options.getLiveSpeechManager();
	if (!manager) {
		errorBody(response, { status: 404, code: "not_found", message: "Live speech is not configured" });
		return;
	}
	const claim = manager.claimStream(jobId);
	if (claim.status === "not_found") {
		errorBody(response, { status: 404, code: "not_found", message: "Live speech job not found" });
		return;
	}
	if (claim.status === "claimed") {
		errorBody(response, {
			status: 409,
			code: "live_speech_stream_claimed",
			message: "Live speech stream has already been claimed",
		});
		return;
	}
	if (claim.status === "expired") {
		errorBody(response, {
			status: 410,
			code: "live_speech_stream_expired",
			message: "Live speech stream has expired",
		});
		return;
	}
	// From here the sink owns the response: it writes headers on the first PCM
	// byte, streams with backpressure, ends/204/502s on terminal, and cancels
	// the job if the browser closes early. No further handler work is needed.
	claim.claim.run.attachResponse(response);
}

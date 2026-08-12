import type { ServerResponse } from "node:http";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import { SPEECH_STREAM_PATH_PREFIX, type SpeechManager } from "../voice/speech-manager.ts";
import type { VoiceStreamResult } from "../voice/types.ts";
import { createHttpAuthorizer, errorBody } from "./http-shared.ts";

const STREAM_SUFFIX = "/stream";

export interface SpeechHttpHandlerOptions {
	/** Lazily resolve the active SpeechManager; absent when voice is not configured. */
	getSpeechManager: () => SpeechManager | undefined;
	/** Expected `Authorization: Bearer <token>`. When undefined, no Bearer check is applied. */
	webToken?: string;
	/** Exact or wildcard Origin allowlist, mirroring the WebSocket listener. */
	allowedOrigins?: readonly string[];
	/** Host header allowlist, mirroring the WebSocket listener. */
	allowedHosts?: readonly string[];
	onError?: (error: unknown) => void;
}

function speechJobIdFrom(pathname: string | undefined): string | undefined {
	if (!pathname) return undefined;
	const prefix = `${SPEECH_STREAM_PATH_PREFIX}/`;
	if (!pathname.startsWith(prefix)) return undefined;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith(STREAM_SUFFIX)) return undefined;
	const jobId = rest.slice(0, -STREAM_SUFFIX.length);
	if (!jobId || jobId.includes("/")) return undefined;
	return decodeURIComponent(jobId);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Browser-facing streaming PCM proxy. PCM never enters the WebSocket protocol. */
export function createSpeechHttpHandler(options: SpeechHttpHandlerOptions): HttpRequestHandler {
	const { originAllowed, setCorsHeaders, authorize } = createHttpAuthorizer({
		webToken: options.webToken,
		allowedOrigins: options.allowedOrigins,
		allowedHosts: options.allowedHosts,
	});

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		const jobId = speechJobIdFrom(pathname);
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
		await handleStream(jobId, response, options);
		return true;
	};
}

async function handleStream(jobId: string, response: ServerResponse, options: SpeechHttpHandlerOptions): Promise<void> {
	const manager = options.getSpeechManager();
	if (!manager) {
		errorBody(response, { status: 404, code: "not_found", message: "Speech is not configured" });
		return;
	}
	const claim = manager.claimStream(jobId);
	if (claim.status === "not_found") {
		errorBody(response, { status: 404, code: "not_found", message: "Speech job not found" });
		return;
	}
	if (claim.status === "claimed") {
		errorBody(response, {
			status: 409,
			code: "speech_stream_claimed",
			message: "Speech stream has already been claimed",
		});
		return;
	}
	if (claim.status === "expired") {
		errorBody(response, { status: 410, code: "speech_stream_expired", message: "Speech stream has expired" });
		return;
	}
	const { job } = claim.claim;

	// Abort upstream whenever the browser drops the response, and again on a
	// normal end (a no-op once the job is terminal).
	const onClose = () => manager.abort(job.id);
	response.once("close", onClose);

	let stream: VoiceStreamResult;
	try {
		stream = await manager.openStream(job.id);
	} catch (error) {
		response.off("close", onClose);
		if (!response.destroyed && !isAbortError(error)) {
			// Pre-first-byte failure: still able to send a JSON error (502).
			manager.failJob(job.id, "voice_unavailable", "Voice Service is unavailable");
			errorBody(response, { status: 502, code: "voice_unavailable", message: "Voice Service is unavailable" });
			return;
		}
		// Abort path: the job was already settled by the abort trigger; close the wire.
		if (!response.destroyed) response.destroy();
		return;
	}

	const { format, body } = stream;
	response.writeHead(200, {
		"content-type": "application/vnd.pi.pcm",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"x-pi-speech-job-id": job.id,
		"x-pi-audio-encoding": format.encoding,
		"x-pi-audio-sample-rate": String(format.sampleRate),
		"x-pi-audio-channels": String(format.channels),
		"access-control-expose-headers":
			"X-Pi-Speech-Job-Id, X-Pi-Audio-Encoding, X-Pi-Audio-Sample-Rate, X-Pi-Audio-Channels",
	});

	const reader = body.getReader();
	let firstByte = true;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (firstByte) {
				firstByte = false;
				manager.noteStreaming(job.id, format);
			}
			manager.noteBytes(job.id, value.byteLength);
			if (!response.write(value)) {
				await new Promise<void>((resolve) => {
					const onDrain = () => resolve();
					const onAbortedClose = () => resolve();
					response.once("drain", onDrain);
					response.once("close", onAbortedClose);
				});
			}
		}
		if (manager.completeJob(job.id)) response.end();
		else response.destroy();
	} catch (error) {
		if (response.destroyed) {
			// The browser disconnected; `onClose` already aborted and settled the job.
		} else if (!isAbortError(error)) {
			manager.failJob(job.id, "speech_generation_failed", "Audio stream failed");
		}
		if (!response.destroyed) response.destroy();
	} finally {
		response.off("close", onClose);
	}
}

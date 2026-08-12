import type { SpeechAudioFormat } from "@earendil-works/pi-protocol";

/**
 * HTTP data plane for streaming speech PCM.
 *
 * The Pi Server is the only security boundary between the browser and the Voice
 * Service. This helper talks to that boundary: it validates that `streamPath`
 * is a server-generated relative path on the same origin as `baseUrl`, sends the
 * bearer token only in the `Authorization` header, and strictly parses the audio
 * metadata headers. The transport is injectable so Node/Unix users are not forced
 * to depend on browser globals.
 */

export type SpeechStreamErrorCode = "invalid_stream_path" | "network_error" | "http_error" | "invalid_audio_format";

export class SpeechStreamError extends Error {
	readonly code: SpeechStreamErrorCode;
	/** HTTP status for `http_error`; undefined otherwise. */
	readonly status: number | undefined;
	/** Server-reported error code from the JSON body; undefined when not provided. */
	readonly serverCode: string | undefined;

	constructor(code: SpeechStreamErrorCode, message: string, details?: { status?: number; serverCode?: string }) {
		super(message);
		this.name = "SpeechStreamError";
		this.code = code;
		this.status = details?.status;
		this.serverCode = details?.serverCode;
	}
}

export interface OpenSpeechStreamOptions {
	/** HTTP origin of the pi-web backend, e.g. `http://127.0.0.1:8765`. */
	baseUrl: string;
	/** Server-generated relative stream path, e.g. `/api/pi/v3/speech/{jobId}/stream`. */
	streamPath: string;
	/** Bearer token sent as `Authorization: Bearer <token>`; omitted when not configured. */
	token?: string;
	signal?: AbortSignal;
	/** Injectable fetch for non-browser transports; defaults to the global fetch. */
	fetch?: SpeechStreamFetch;
}

/** Structural subset of `Response` so non-browser transports can inject their own. */
export interface SpeechStreamResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	readonly body: ReadableStream<Uint8Array> | null;
}

export type SpeechStreamFetch = (
	url: URL,
	init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<SpeechStreamResponse>;

export interface SpeechStream {
	format: SpeechAudioFormat;
	body: ReadableStream<Uint8Array>;
}

/** Upper bound on the JSON error body the client will read from a failed stream. */
const MAX_ERROR_BODY_BYTES = 1024;

export async function openSpeechStream(options: OpenSpeechStreamOptions): Promise<SpeechStream> {
	const fetchImpl: SpeechStreamFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const url = assertSameOriginStreamUrl(options.baseUrl, options.streamPath);
	let response: SpeechStreamResponse;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
			signal: options.signal,
		});
	} catch (error) {
		if (error instanceof SpeechStreamError) throw error;
		const message = error instanceof Error ? error.message : "Speech stream request failed";
		throw new SpeechStreamError("network_error", message);
	}
	if (!response.ok) throw await httpErrorFromResponse(response);
	const format = parseAudioMetadata(response);
	const body = response.body;
	if (!body) {
		throw new SpeechStreamError("invalid_audio_format", "Speech stream response has no body");
	}
	return { format, body };
}

/**
 * Options for {@link openLiveSpeechStream}. Identical wire-level guarantees to
 * {@link OpenSpeechStreamOptions}, except the helper additionally recognises
 * the spec-defined `204 No Content` short-circuit (no speakable text) and the
 * legacy `410 gone` claim-expired paths emitted by the Phase 2 HTTP route.
 */
export interface OpenLiveSpeechStreamOptions {
	baseUrl: string;
	streamPath: string;
	token?: string;
	signal?: AbortSignal;
	fetch?: SpeechStreamFetch;
}

/**
 * Outcome of a Phase 2 live speech stream attempt. `null` means the server
 * legitimately reported "no speakable text" via `204`; callers should resolve
 * the playback as completed without raising a `SpeechStreamError`.
 */
export type LiveSpeechStreamResult = SpeechStream | null;

export async function openLiveSpeechStream(options: OpenLiveSpeechStreamOptions): Promise<LiveSpeechStreamResult> {
	const fetchImpl: SpeechStreamFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const url = assertSameOriginStreamUrl(options.baseUrl, options.streamPath);
	let response: SpeechStreamResponse;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
			signal: options.signal,
		});
	} catch (error) {
		if (error instanceof SpeechStreamError) throw error;
		const message = error instanceof Error ? error.message : "Live speech stream request failed";
		throw new SpeechStreamError("network_error", message);
	}
	if (response.status === 204) return null;
	if (!response.ok) throw await httpErrorFromResponse(response);
	const format = parseAudioMetadata(response);
	const body = response.body;
	if (!body) {
		throw new SpeechStreamError("invalid_audio_format", "Live speech stream response has no body");
	}
	return { format, body };
}

function assertSameOriginStreamUrl(baseUrl: string, streamPath: string): URL {
	if (!streamPath.startsWith("/") || streamPath.startsWith("//")) {
		throw new SpeechStreamError("invalid_stream_path", "Speech stream path must be a server-relative path");
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(streamPath)) {
		throw new SpeechStreamError("invalid_stream_path", "Speech stream path must not be an absolute URL");
	}
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new SpeechStreamError("invalid_stream_path", `Invalid stream base URL: ${baseUrl}`);
	}
	const url = new URL(streamPath, base);
	if (url.origin !== base.origin) {
		throw new SpeechStreamError("invalid_stream_path", "Speech stream path must stay on the backend origin");
	}
	return url;
}

async function httpErrorFromResponse(response: SpeechStreamResponse): Promise<SpeechStreamError> {
	const body = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
	let serverCode: string | undefined;
	let message = `Speech stream failed (HTTP ${response.status})`;
	try {
		const json = JSON.parse(body) as { error?: { code?: string; message?: string } };
		if (json.error?.message) message = json.error.message;
		serverCode = json.error?.code;
	} catch {
		// Fall back to the status-based message when the body is not JSON.
	}
	return new SpeechStreamError("http_error", message, { status: response.status, serverCode });
}

function parseAudioMetadata(response: SpeechStreamResponse): SpeechAudioFormat {
	const encoding = response.headers.get("x-pi-audio-encoding");
	const sampleRate = Number(response.headers.get("x-pi-audio-sample-rate"));
	const channels = Number(response.headers.get("x-pi-audio-channels"));
	const contentType = response.headers.get("content-type");
	if (contentType && contentType !== "application/vnd.pi.pcm") {
		throw new SpeechStreamError("invalid_audio_format", `Unexpected speech content type: ${contentType}`);
	}
	if (encoding !== "pcm_f32le") {
		throw new SpeechStreamError("invalid_audio_format", `Unsupported speech encoding: ${String(encoding)}`);
	}
	if (!Number.isInteger(sampleRate) || sampleRate < 1) {
		throw new SpeechStreamError("invalid_audio_format", `Invalid speech sample rate: ${String(sampleRate)}`);
	}
	if (channels !== 1) {
		throw new SpeechStreamError("invalid_audio_format", `Invalid speech channel count: ${String(channels)}`);
	}
	return { encoding: "pcm_f32le", sampleRate, channels: 1 };
}

async function readBoundedText(response: SpeechStreamResponse, limit: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	try {
		const decoder = new TextDecoder();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (total < limit) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			const take = Math.min(value.byteLength, limit - total);
			chunks.push(value.subarray(0, take));
			total += take;
		}
		return decoder.decode(concatBytes(chunks));
	} finally {
		await reader.cancel().catch(() => {});
	}
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const combined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

import type { StreamSynthesisRequest, VoiceAudioFormat, VoiceServiceClient, VoiceStreamResult } from "./types.ts";
import { VoiceLimitError, VoiceUpstreamError } from "./types.ts";

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export interface VoiceServiceClientOptions {
	/** Voice Service base URL, e.g. `http://127.0.0.1:18876`. */
	baseUrl: string;
	/** Server-to-service bearer secret; never exposed to the browser. */
	token: string;
	/** PCM chunk size requested from the upstream provider. Default 8. */
	chunkSize?: number;
	/** Max wait for the first PCM chunk after the request starts. Default 60s. */
	firstChunkTimeoutMs?: number;
	/** Max idle time between consecutive chunks. Default 30s. */
	idleTimeoutMs?: number;
	/** Max wall-clock time for the whole upstream stream. Default 5m. */
	totalTimeoutMs?: number;
	/** Max bytes forwarded from upstream. Default 100 MiB. */
	maxBytes?: number;
	/** Injectable fetch for tests. Defaults to globalThis.fetch. */
	fetch?: typeof fetch;
	/** Injectable clock for timeout bookkeeping. Defaults to Date.now. */
	now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Wrap the upstream body so the remaining reads enforce the idle timeout, total
 * timeout and byte cap without ever buffering the full response.
 */
function limitStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	options: { startedAt: number; idleTimeoutMs: number; totalTimeoutMs: number; maxBytes: number; now: () => number },
): ReadableStream<Uint8Array> {
	let bytes = 0;
	let lastActivityAt = options.now();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const now = options.now();
			if (now - options.startedAt > options.totalTimeoutMs) {
				controller.error(new VoiceLimitError("total_timeout", "Voice stream exceeded the total timeout"));
				return;
			}
			if (now - lastActivityAt > options.idleTimeoutMs) {
				controller.error(new VoiceLimitError("idle_timeout", "Voice stream exceeded the idle timeout"));
				return;
			}
			const remaining = Math.max(0, options.totalTimeoutMs - (now - options.startedAt));
			const readTimeout = Math.min(options.idleTimeoutMs, remaining);
			const result = await withTimeout(
				reader.read(),
				readTimeout,
				() => new VoiceLimitError("idle_timeout", "Voice stream exceeded the idle timeout"),
			);
			if (result.done) {
				controller.close();
				return;
			}
			lastActivityAt = options.now();
			bytes += result.value.byteLength;
			if (bytes > options.maxBytes) {
				controller.error(new VoiceLimitError("max_bytes", "Voice stream exceeded the maximum byte limit"));
				return;
			}
			controller.enqueue(result.value);
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		},
	});
}

/** Prepend the already-read first chunk to the limited continuation. */
function concatFirstChunk(first: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	let emittedFirst = false;
	const restReader = rest.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!emittedFirst) {
				emittedFirst = true;
				controller.enqueue(first);
				return;
			}
			const { done, value } = await restReader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel(reason) {
			await restReader.cancel(reason).catch(() => {});
		},
	});
}

/** HTTP client for the streaming Voice Service endpoint. */
export class VoiceServiceHttpClient implements VoiceServiceClient {
	private readonly options: Required<VoiceServiceClientOptions>;

	constructor(options: VoiceServiceClientOptions) {
		if (!options.baseUrl) throw new TypeError("Voice Service baseUrl must not be empty");
		if (!options.token) throw new TypeError("Voice Service token must not be empty");
		this.options = {
			baseUrl: options.baseUrl,
			token: options.token,
			chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
			firstChunkTimeoutMs: options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
			idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
			maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
			fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
			now: options.now ?? (() => Date.now()),
		};
	}

	async openStream(request: StreamSynthesisRequest, signal: AbortSignal): Promise<VoiceStreamResult> {
		const startedAt = this.options.now();
		const url = new URL("/v1/synthesize/stream", this.options.baseUrl).toString();
		const response = await this.options.fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.options.token}`,
				"content-type": "application/json",
				accept: "application/vnd.pi.pcm",
			},
			body: JSON.stringify({
				text: request.text,
				language: request.language,
				speaker: request.speaker,
				instruct: request.instruct ?? null,
				chunkSize: request.chunkSize ?? this.options.chunkSize,
				encoding: "pcm_f32le",
			}),
			signal,
		});
		if (!response.ok) {
			throw new VoiceUpstreamError(`Voice Service responded with status ${response.status}`);
		}
		const format = parseAudioFormat(response);
		const body = response.body;
		if (!body) throw new VoiceUpstreamError("Voice Service returned no audio body");

		const reader = body.getReader();
		// Await the first PCM chunk while headers are still unwritten so a
		// first-chunk timeout can surface as a 502 before the browser commits.
		const firstRead = await withTimeout(
			reader.read(),
			this.options.firstChunkTimeoutMs,
			() => new VoiceUpstreamError("Voice Service did not produce the first audio chunk in time"),
		);
		if (firstRead.done) throw new VoiceUpstreamError("Voice Service produced no audio chunks");
		const limited = limitStream(reader, {
			startedAt,
			idleTimeoutMs: this.options.idleTimeoutMs,
			totalTimeoutMs: this.options.totalTimeoutMs,
			maxBytes: this.options.maxBytes,
			now: this.options.now,
		});
		return { format, body: concatFirstChunk(firstRead.value, limited) };
	}
}

function parseAudioFormat(response: Response): VoiceAudioFormat {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.startsWith("application/vnd.pi.pcm")) {
		throw new VoiceUpstreamError(`Unexpected Voice Service content type: ${contentType}`);
	}
	const encoding = response.headers.get("x-pi-audio-encoding");
	if (encoding !== "pcm_f32le") {
		throw new VoiceUpstreamError(`Unexpected audio encoding: ${encoding ?? "missing"}`);
	}
	const sampleRateHeader = response.headers.get("x-pi-audio-sample-rate");
	const sampleRate = Number.parseInt(sampleRateHeader ?? "", 10);
	if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
		throw new VoiceUpstreamError(`Invalid audio sample rate: ${sampleRateHeader ?? "missing"}`);
	}
	const channelsHeader = response.headers.get("x-pi-audio-channels");
	if (channelsHeader !== "1") {
		throw new VoiceUpstreamError(`Unexpected audio channels: ${channelsHeader ?? "missing"}`);
	}
	return { encoding: "pcm_f32le", sampleRate, channels: 1 };
}

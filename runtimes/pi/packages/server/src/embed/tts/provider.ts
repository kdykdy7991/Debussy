/**
 * TTS provider abstraction (spec 5.4 / TASK-036).
 *
 * The embed data plane exposes exactly **one shared process-level provider**
 * (never one per user): a single `EmbedTtsQueue` drives it with bounded
 * concurrency (default 1) so a GPU-backed model is only ever loaded once and
 * shared across all conversations — this is the "不为每用户加载模型" invariant.
 *
 * `TtsProvider` is the seam an actual backend plugs into. There is no wired
 * default backend; if none is configured the speech feature stays off and the
 * HTTP adapter returns `TTS_UNAVAILABLE` (never a silent fake success).
 */
export interface TtsSynthesisInput {
	readonly text: string;
	/** Optional voice id from the published app's speech config (read-only). */
	readonly voice?: string;
}

export interface TtsAudioResult {
	readonly bytes: Uint8Array;
	readonly contentType: string;
}

export type TtsProvider = (input: TtsSynthesisInput, signal: AbortSignal) => Promise<TtsAudioResult>;

/** Human-readable errors surfaced to the client as `{code, retryable}`. */
export type TtsErrorCode = "queue_full" | "timeout" | "cancelled" | "provider" | "not_found";

export class EmbedTtsError extends Error {
	readonly code: TtsErrorCode;
	readonly retryable: boolean;
	constructor(code: TtsErrorCode, message: string, retryable: boolean) {
		super(message);
		this.name = "EmbedTtsError";
		this.code = code;
		this.retryable = retryable;
	}
}

export function ttsCancelledError(): EmbedTtsError {
	return new EmbedTtsError("cancelled", "speech request cancelled", false);
}
export function ttsQueueFullError(): EmbedTtsError {
	return new EmbedTtsError("queue_full", "speech queue is full; retry later", true);
}
export function ttsTimeoutError(): EmbedTtsError {
	return new EmbedTtsError("timeout", "speech synthesis timed out", true);
}
export function ttsProviderError(message: string, retryable = true): EmbedTtsError {
	return new EmbedTtsError("provider", message, retryable);
}

/** Default per-task synthesis timeout. */
export const DEFAULT_TTS_TIMEOUT_MS = 30_000;
/** Default bounded pending-queue capacity. */
export const DEFAULT_TTS_MAX_PENDING = 64;
/** Default synthesis concurrency (single shared model). */
export const DEFAULT_TTS_CONCURRENCY = 1;

export function toAbortError(signal: AbortSignal): EmbedTtsError {
	// An abort may carry an explicit reason (timeout/cancel); fall back to the
	// aborted/unaborted distinction for providers that abort for other reasons.
	if (signal.reason instanceof EmbedTtsError) return signal.reason;
	return signal.aborted ? ttsCancelledError() : ttsTimeoutError();
}

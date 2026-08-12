/**
 * Incremental Utterance Queue (Phase 2 live speech).
 *
 * Owns the ordered TTS pipeline between the V6 segmenter's `CommittedUtterance`
 * output and the single browser PCM response the V8 coordinator will publish.
 *
 * Contract (Phase 2 Spec §11 + V7 task §4-6):
 *
 * - Strict sequence order. The queue never reorders, never skips, never
 *   guesses. A repeated or out-of-order sequence fails the job.
 * - Single upstream request in flight. N+1 only starts after N's source EOF.
 * - The first source's audio format is frozen for the lifetime of the queue.
 *   Any subsequent format mismatch fails the job before the first byte of
 *   that utterance is forwarded.
 * - Downstream backpressure (a pending `sink.write` promise) pauses the
 *   upstream reader; the next utterance also waits for sink drain.
 * - The queue never logs utterance text. Errors and lifecycle events go
 *   through `onEvent`; they carry `sequence` and a safe error code only.
 * - `closeInput()` rejects further `enqueue`. After the in-flight + queued
 *   work drains, the queue settles as `completed` (even when no utterances
 *   were ever enqueued).
 * - `cancel(reason)` is idempotent and settles the queue exactly once.
 *
 * The queue is intentionally a transport, not an orchestrator: it does not
 * listen to Agent runtime events, open public Jobs, handle HTTP, or know
 * about profiles — all of that is the V8 coordinator's responsibility.
 */

import type { LiveSpeechErrorCode } from "@earendil-works/pi-protocol";
import type { VoiceAudioFormat } from "../types.ts";
import type { CommittedUtterance } from "./text-segmenter.ts";

// ---- V7 frozen defaults (see V7 task §6) -------------------------------

/** V7-frozen default for `maxQueuedUtterances`. */
export const DEFAULT_MAX_QUEUED_UTTERANCES = 12;
/** V7-frozen default for `maxQueuedCharacters`. */
export const DEFAULT_MAX_QUEUED_CHARACTERS = 1200;
/** V7-frozen default for `maxEstimatedAudioSeconds`. */
export const DEFAULT_MAX_ESTIMATED_AUDIO_SECONDS = 90;
/**
 * Conservative chars-per-second used to convert queued characters into an
 * estimated audio length. Chosen to *over*-estimate audio time so backlog
 * protection fires before the browser actually runs out of buffer.
 */
export const DEFAULT_CHARACTERS_PER_SECOND = 16;

// ---- Public types ------------------------------------------------------

/** A streaming PCM source the queue reads from while a single utterance is live. */
export interface PcmSource {
	/** Format declared by the upstream Voice Service before the body opens. */
	format: VoiceAudioFormat;
	/** Raw PCM bytes (one Float32 little-endian frame per 4 bytes). */
	body: ReadableStream<Uint8Array>;
}

/**
 * The downstream-facing sink: the V8 coordinator will compose this with the
 * single browser HTTP response. The queue calls `write` exactly once per
 * upstream chunk; `close` is called once when the queue has drained cleanly;
 * `fail` is called when the queue must surface a safe error code.
 */
export interface PcmSink {
	/**
	 * Forward a chunk to the browser. Resolves only when the downstream has
	 * drained enough to accept more — used by the queue to apply
	 * backpressure on the upstream reader.
	 */
	write(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
	/** Close the downstream response cleanly. Idempotent. */
	close(signal: AbortSignal): Promise<void>;
	/** Surface a terminal error to the downstream. Idempotent. */
	fail(error: { code: LiveSpeechErrorCode; message: string }, signal: AbortSignal): Promise<void>;
}

export interface QueueLimits {
	maxQueuedUtterances?: number;
	maxQueuedCharacters?: number;
	maxEstimatedAudioSeconds?: number;
	/**
	 * Conversion factor used by the backlog estimator. The default is
	 * intentionally conservative so we *over*-estimate audio seconds.
	 */
	charactersPerSecond?: number;
}

export type QueueCancelReason =
	| "user_cancel"
	| "owner_disconnect"
	| "agent_abort"
	| "agent_steer"
	| "session_removed"
	| "downstream_close"
	| "shutdown"
	| "backlog_exceeded"
	| "format_mismatch";

/**
 * Lifecycle events surfaced to the V8 coordinator. None of them carry
 * utterance text — only safe metadata (`sequence`, character counts, error
 * codes, the frozen format). The coordinator publishes the corresponding
 * `live_speech_job` events; nothing here crosses the protocol boundary.
 */
export type QueueEvent =
	| { type: "enqueued"; sequence: number; characters: number }
	| { type: "started"; sequence: number }
	| { type: "format_locked"; format: VoiceAudioFormat }
	| {
			type: "backlog_exceeded";
			reason: "max_utterances" | "max_characters" | "max_audio_seconds";
			queueDepth: number;
			queueCharacters: number;
			estimatedAudioSeconds: number;
	  }
	| { type: "completed"; sequence: number; characters: number }
	| { type: "discarded"; sequence: number; reason: "cancelled" | "backlog_exceeded" | "format_mismatch" }
	| { type: "cancelled"; reason: QueueCancelReason }
	| { type: "failed"; error: { code: LiveSpeechErrorCode; message: string } };

/**
 * A function the queue uses to ask the V8 coordinator to open a streaming
 * TTS request. The queue owns the abort signal it passes in; cancelling
 * the queue aborts the request, the upstream body, and any pending
 * downstream writes.
 */
export type SynthesizeFn = (input: { text: string; profileId: string; signal: AbortSignal }) => Promise<PcmSource>;

export interface UtteranceQueueOptions {
	/** Profile id the queue forwards to `synthesize` for every utterance. */
	profileId: string;
	/** Factory the queue uses to open one Voice Service stream per utterance. */
	synthesize: SynthesizeFn;
	/** Downstream sink; the queue never inspects it beyond the three methods. */
	sink: PcmSink;
	/** Backlog limits; defaults are V7-frozen (12/1200/90s, 16 chars/s). */
	limits?: QueueLimits;
	/** External abort signal — when fired, the queue cancels and aborts everything. */
	signal: AbortSignal;
	/** Lifecycle sink. The queue calls this synchronously; do not throw. */
	onEvent: (event: QueueEvent) => void;
	/** Optional clock for tests; defaults to `() => Date.now()`. */
	now?: () => number;
}

export type QueueResult =
	| {
			status: "completed";
			completedUtterances: number;
			failedUtterances: number;
			discardedUtterances: number;
	  }
	| {
			status: "cancelled";
			reason: QueueCancelReason;
			completedUtterances: number;
			discardedUtterances: number;
			failedUtterances: number;
	  }
	| {
			status: "failed";
			error: { code: LiveSpeechErrorCode; message: string };
			completedUtterances: number;
			failedUtterances: number;
			discardedUtterances: number;
	  };

export interface UtteranceQueue {
	/**
	 * Append a committed utterance. Throws if the queue has been closed
	 * via `closeInput` or `cancel`, or if the sequence is not exactly
	 * `lastSequence + 1`. Backlog checks run on enqueue; a violation
	 * cancels the queue (asynchronously) and surfaces `backlog_exceeded`.
	 */
	enqueue(utterance: CommittedUtterance): void;
	/** Stop accepting new utterances. Resolves once the in-flight + queued work drains. */
	closeInput(): Promise<QueueResult>;
	/**
	 * Idempotent terminal cancel. Resolves with the same result the
	 * `completion` promise settled on; the queue only ever settles once
	 * no matter how many times cancel is called.
	 */
	cancel(reason: QueueCancelReason): Promise<QueueResult>;
	/** Single-settle completion promise; resolves exactly once. */
	readonly completion: Promise<QueueResult>;
}

// ---- Internal helpers --------------------------------------------------

type RequiredLimits = {
	maxQueuedUtterances: number;
	maxQueuedCharacters: number;
	maxEstimatedAudioSeconds: number;
	charactersPerSecond: number;
};

interface InternalEntry {
	sequence: number;
	text: string;
	characters: number;
}

const TERMINAL_CODES_FOR_BACKLOG: ReadonlySet<LiveSpeechErrorCode> = new Set<LiveSpeechErrorCode>([
	"speech_backlog_exceeded",
	"speech_generation_failed",
	"speech_cancelled",
	"voice_unavailable",
]);

function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) count += 1;
	return count;
}

function isPcmFormat(value: VoiceAudioFormat): value is VoiceAudioFormat {
	return (
		value &&
		value.encoding === "pcm_f32le" &&
		Number.isInteger(value.sampleRate) &&
		value.sampleRate > 0 &&
		value.channels === 1
	);
}

function sameFormat(a: VoiceAudioFormat, b: VoiceAudioFormat): boolean {
	return a.encoding === b.encoding && a.sampleRate === b.sampleRate && a.channels === b.channels;
}

function safeErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error) {
		// Phase 2 Spec §16 forbids logging the full stack or request body. We
		// only keep a short safe message; if a queue consumer wants a richer
		// error they can rethrow with the original inside their own code.
		const msg = error.message;
		if (msg.length <= 200) return msg;
		return `${msg.slice(0, 200)}…`;
	}
	return fallback;
}

// ---- Public factory ----------------------------------------------------

export function createUtteranceQueue(options: UtteranceQueueOptions): UtteranceQueue {
	if (!options.synthesize) throw new TypeError("synthesize is required");
	if (!options.sink) throw new TypeError("sink is required");
	if (!options.onEvent) throw new TypeError("onEvent is required");
	if (!options.signal) throw new TypeError("signal is required");
	if (!options.profileId) throw new TypeError("profileId is required");

	const limits: RequiredLimits = {
		maxQueuedUtterances: options.limits?.maxQueuedUtterances ?? DEFAULT_MAX_QUEUED_UTTERANCES,
		maxQueuedCharacters: options.limits?.maxQueuedCharacters ?? DEFAULT_MAX_QUEUED_CHARACTERS,
		maxEstimatedAudioSeconds: options.limits?.maxEstimatedAudioSeconds ?? DEFAULT_MAX_ESTIMATED_AUDIO_SECONDS,
		charactersPerSecond: options.limits?.charactersPerSecond ?? DEFAULT_CHARACTERS_PER_SECOND,
	};
	if (limits.maxQueuedUtterances < 1) throw new RangeError("maxQueuedUtterances must be >= 1");
	if (limits.maxQueuedCharacters < 1) throw new RangeError("maxQueuedCharacters must be >= 1");
	if (limits.maxEstimatedAudioSeconds < 1) throw new RangeError("maxEstimatedAudioSeconds must be >= 1");
	if (limits.charactersPerSecond < 1) throw new RangeError("charactersPerSecond must be >= 1");

	const _now = options.now ?? (() => Date.now());
	const externalSignal = options.signal;

	// State -------------------------------------------------------------

	type Phase = { kind: "open" } | { kind: "draining" } | { kind: "settling" };

	let _phase: Phase = { kind: "open" };
	const pending: InternalEntry[] = [];
	let _lastSequence = 0;
	let expectedSequence = 1;
	/** True once `closeInput()` has resolved and nothing else can be enqueued. */
	let inputClosed = false;
	/** True once the queue has settled in any terminal state. */
	let settled = false;
	/**
	 * `step()` may be re-entered while a previous invocation is awaiting the
	 * `synthesize` factory. We must guarantee single-flight: only one
	 * invocation is allowed past the entry-shift point at any time. This
	 * flag is set synchronously when `step()` enters the critical section
	 * and cleared in the matching `finally`.
	 */
	let stepInFlight = false;
	/** The currently streaming utterance (if any). `null` while idle/draining. */
	let inFlight: {
		entry: InternalEntry;
		source: PcmSource;
		reader: ReadableStreamDefaultReader<Uint8Array>;
		signal: AbortController;
		/** True once the first byte has been observed (format frozen). */
		formatLocked: boolean;
	} | null = null;
	/**
	 * The utterance currently claimed by `step()` but not yet streaming — the
	 * window between the entry leaving `pending` and `inFlight` being assigned
	 * (while `synthesize` is still pending). The backlog estimator counts this
	 * as the "generating" item so the limits see the true unfinished total,
	 * even before the Voice Service has returned a source.
	 */
	let claimed: InternalEntry | null = null;
	/** Per-queue AbortController. Mirrors `externalSignal` plus our own cancel. */
	const internalController = new AbortController();
	let onExternalAbort: (() => void) | null = null;
	if (externalSignal.aborted) {
		// External abort arrived before construction. Replay as our own abort.
		internalController.abort();
	} else {
		onExternalAbort = () => internalController.abort();
		externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	}

	// Counters for the result payload.
	let completedUtterances = 0;
	let failedUtterances = 0;
	let discardedUtterances = 0;

	// Single-settle completion machinery. The promise resolves exactly once.
	let resolveCompletion: ((result: QueueResult) => void) | null = null;
	const completion: Promise<QueueResult> = new Promise<QueueResult>((resolve) => {
		resolveCompletion = resolve;
	});

	function emit(event: QueueEvent): void {
		try {
			options.onEvent(event);
		} catch {
			// The consumer must not throw; swallow to keep the queue running.
		}
	}

	function remainingSequenceExpected(): number {
		return expectedSequence;
	}

	// ---- Backlog estimation -----------------------------------------

	/**
	 * The V7 task §6 explicitly asks us to freeze whether the *currently
	 * generating* utterance counts toward the backlog limit. V7 recommends
	 * counting it as part of the total unfinished work: while a slow Voice
	 * Service is generating, more text can still flow in and we should fail
	 * fast rather than drown the queue.
	 *
	 * Therefore: `pending = queued + (generating ? 1 : 0)` and the new
	 * utterance (after this enqueue) is included in the projection. The
	 * characters and audio-seconds estimates include the in-flight text.
	 */
	/**
	 * Estimate the post-enqueue backlog. `extra` represents the entry the
	 * caller is about to push; including it lets `checkBacklog` reason about
	 * the *new* total rather than the current state.
	 */
	function estimateBacklog(extra?: { characters: number }): {
		count: number;
		characters: number;
		estimatedAudioSeconds: number;
	} {
		const generating = claimed ?? (inFlight ? inFlight.entry : null);
		let characters = 0;
		for (const entry of pending) characters += entry.characters;
		if (extra) characters += extra.characters;
		if (generating) characters += generating.characters;
		const count = pending.length + (extra ? 1 : 0) + (generating ? 1 : 0);
		return {
			count,
			characters,
			estimatedAudioSeconds: characters / limits.charactersPerSecond,
		};
	}

	function checkBacklog(extra?: { characters: number }):
		| {
				ok: true;
		  }
		| {
				ok: false;
				reason: "max_utterances" | "max_characters" | "max_audio_seconds";
				projection: ReturnType<typeof estimateBacklog>;
		  } {
		const projection = estimateBacklog(extra);
		if (projection.count > limits.maxQueuedUtterances) {
			return { ok: false, reason: "max_utterances", projection };
		}
		if (projection.characters > limits.maxQueuedCharacters) {
			return { ok: false, reason: "max_characters", projection };
		}
		if (projection.estimatedAudioSeconds > limits.maxEstimatedAudioSeconds) {
			return { ok: false, reason: "max_audio_seconds", projection };
		}
		return { ok: true };
	}

	// ---- Settlement ---------------------------------------------------

	function failWith(code: LiveSpeechErrorCode, message: string, surfaceEvent: boolean): void {
		if (settled) return;
		settled = true;
		_phase = { kind: "settling" };
		// Drain all pending entries silently — they are never enqueued into TTS
		// and their text must not appear in any error/log.
		discardedUtterances += pending.length;
		pending.length = 0;
		if (surfaceEvent) emit({ type: "failed", error: { code, message } });
		// Abort everything and settle the completion.
		internalController.abort();
		void finalizeSettle({
			status: "failed",
			error: { code, message },
			completedUtterances,
			failedUtterances,
			discardedUtterances,
		});
	}

	function completeWith(): void {
		if (settled) return;
		settled = true;
		_phase = { kind: "settling" };
		void finalizeSettle({
			status: "completed",
			completedUtterances,
			failedUtterances,
			discardedUtterances,
		});
	}

	async function finalizeSettle(result: QueueResult): Promise<void> {
		// Best-effort sink close. Sink.close / sink.fail are idempotent so this
		// is safe even when the consumer already invoked them.
		try {
			if (result.status === "completed") {
				await options.sink.close(internalController.signal);
			} else {
				const err =
					result.status === "failed"
						? result.error
						: { code: "speech_cancelled" as const, message: `Queue cancelled: ${result.reason}` };
				await options.sink.fail(err, internalController.signal);
			}
		} catch {
			// Sink errors during shutdown are not actionable; swallow.
		}
		// Release all listeners and references so no late callback can touch us.
		if (onExternalAbort) {
			externalSignal.removeEventListener("abort", onExternalAbort);
			onExternalAbort = null;
		}
		// Cancel any reader we still hold.
		if (inFlight) {
			try {
				await inFlight.reader.cancel().catch(() => undefined);
			} catch {
				// ignore
			}
		}
		inFlight = null;
		claimed = null;
		// Hand the result to whoever awaits `completion`.
		const resolver = resolveCompletion;
		resolveCompletion = null;
		if (resolver) resolver(result);
	}

	// ---- Pipeline loop -----------------------------------------------

	async function step(): Promise<void> {
		// Single-step: pull the next pending entry, run synthesis + source read.
		// Invariant: at most one `step` runs at a time. We rely on the fact
		// that `enqueue` and `closeInput` always wake the loop by calling
		// `step()` (without `await`); the next call no-ops if a step is
		// already running.
		if (inFlight || stepInFlight || settled) return;
		stepInFlight = true;
		try {
			const entry = pending.shift();
			if (!entry) {
				if (inputClosed) completeWith();
				return;
			}
			// The entry is claimed the moment it leaves `pending`, so the backlog
			// estimator counts it as the generating item while `synthesize` is
			// still pending. It stays claimed until it becomes `inFlight`.
			claimed = entry;
			const signal = internalController.signal;
			if (signal.aborted) {
				// The queue was cancelled while the entry was pending.
				claimed = null;
				discardedUtterances += 1;
				emit({ type: "discarded", sequence: entry.sequence, reason: "cancelled" });
				return;
			}
			let source: PcmSource;
			try {
				emit({ type: "started", sequence: entry.sequence });
				source = await options.synthesize({
					text: entry.text,
					profileId: options.profileId,
					signal,
				});
			} catch (error) {
				claimed = null;
				if (settled) return;
				const code: LiveSpeechErrorCode = TERMINAL_CODES_FOR_BACKLOG.has(
					(error as { code?: LiveSpeechErrorCode })?.code as LiveSpeechErrorCode,
				)
					? ((error as { code?: LiveSpeechErrorCode }).code as LiveSpeechErrorCode)
					: "speech_generation_failed";
				const message = safeErrorMessage(error, "Voice synthesis failed");
				discardedUtterances += 1;
				emit({ type: "discarded", sequence: entry.sequence, reason: "cancelled" });
				failedUtterances += 1;
				failWith(code, message, true);
				return;
			}
			if (settled) {
				// Cancel raced with us; clean up the source we just opened.
				claimed = null;
				try {
					await source.body.cancel().catch(() => undefined);
				} catch {
					// ignore
				}
				return;
			}
			if (!isPcmFormat(source.format)) {
				claimed = null;
				try {
					await source.body.cancel().catch(() => undefined);
				} catch {
					// ignore
				}
				discardedUtterances += 1;
				emit({ type: "discarded", sequence: entry.sequence, reason: "format_mismatch" });
				failedUtterances += 1;
				failWith("speech_generation_failed", "Voice source returned an unsupported audio format", true);
				return;
			}
			// Set `inFlight` synchronously BEFORE returning so any further
			// microtask (e.g. another queued `step`) sees the slot taken.
			const entryController = new AbortController();
			const reader = source.body.getReader();
			claimed = null;
			inFlight = { entry, source, reader, signal: entryController, formatLocked: false };
			void streamEntry(entry, source, reader, entryController);
		} finally {
			stepInFlight = false;
		}
	}

	async function streamEntry(
		entry: InternalEntry,
		source: PcmSource,
		reader: ReadableStreamDefaultReader<Uint8Array>,
		entryController: AbortController,
	): Promise<void> {
		// Propagate the queue's abort to the per-entry controller.
		const onAbort = () => {
			if (!entryController.signal.aborted) entryController.abort();
		};
		internalController.signal.addEventListener("abort", onAbort, { once: true });
		try {
			// Read & forward until the source is exhausted.
			// Backpressure: `sink.write` returns a promise; we await it before
			// pulling the next chunk, so a slow downstream naturally throttles
			// the upstream reader.
			while (!entryController.signal.aborted) {
				let read: Awaited<ReturnType<typeof reader.read>>;
				try {
					read = await reader.read();
				} catch (error) {
					if (settled) return;
					const message = safeErrorMessage(error, "Voice source errored");
					discardedUtterances += 1;
					emit({ type: "discarded", sequence: entry.sequence, reason: "cancelled" });
					failedUtterances += 1;
					failWith("speech_generation_failed", message, true);
					return;
				}
				if (read.done) {
					// EOF for this utterance. Free the in-flight slot so the
					// next pending entry (or completion) can run.
					if (inFlight && inFlight.entry.sequence === entry.sequence) inFlight = null;
					completedUtterances += 1;
					emit({
						type: "completed",
						sequence: entry.sequence,
						characters: entry.characters,
					});
					void step();
					return;
				}
				if (read.value.byteLength === 0) continue;
				// Lock the format on the first non-empty chunk.
				if (!inFlight?.formatLocked) {
					if (inFlight) inFlight.formatLocked = true;
					if (lockedFormat === null) {
						lockedFormat = source.format;
						emit({ type: "format_locked", format: source.format });
					} else if (!sameFormat(lockedFormat, source.format)) {
						// Mismatch — fail before forwarding the first byte.
						discardedUtterances += 1;
						emit({ type: "discarded", sequence: entry.sequence, reason: "format_mismatch" });
						failedUtterances += 1;
						failWith("speech_generation_failed", "Voice source format changed mid-stream", true);
						return;
					}
				}
				// Backpressure-aware forward. The `signal` argument lets the
				// sink bail out if the downstream response is closed.
				if (settled) return;
				try {
					await options.sink.write(read.value, internalController.signal);
				} catch (error) {
					if (settled) return;
					const message = safeErrorMessage(error, "Downstream sink rejected a chunk");
					discardedUtterances += 1;
					emit({ type: "discarded", sequence: entry.sequence, reason: "cancelled" });
					failedUtterances += 1;
					failWith("speech_generation_failed", message, true);
					return;
				}
			}
		} finally {
			internalController.signal.removeEventListener("abort", onAbort);
		}
	}

	// The first source's format is captured here. Subsequent sources must
	// match exactly. The variable is mutated only when a non-empty chunk is
	// observed, which is when the format becomes binding.
	let lockedFormat: VoiceAudioFormat | null = null;

	// ---- Public surface -----------------------------------------------

	function enqueue(utterance: CommittedUtterance): void {
		if (settled) {
			throw new Error("UtteranceQueue: cannot enqueue after the queue has settled");
		}
		if (inputClosed) {
			throw new Error("UtteranceQueue: cannot enqueue after closeInput()");
		}
		if (!utterance || typeof utterance.text !== "string") {
			throw new TypeError("UtteranceQueue: utterance.text must be a string");
		}
		if (!Number.isInteger(utterance.sequence) || utterance.sequence < 1) {
			throw new RangeError("UtteranceQueue: utterance.sequence must be a positive integer");
		}
		const expected = remainingSequenceExpected();
		if (utterance.sequence !== expected) {
			// Out-of-order / duplicate / gap. V7 §5 forbids guessing — fail loud.
			failWith(
				"speech_generation_failed",
				`Utterance sequence out of order: expected ${expected}, got ${utterance.sequence}`,
				true,
			);
			throw new Error(`UtteranceQueue: sequence mismatch (expected ${expected})`);
		}
		expectedSequence += 1;
		_lastSequence = utterance.sequence;
		const characters = codePointLength(utterance.text);
		// Backlog is evaluated *as if* this entry were already in the queue.
		// The estimator merges `pending + inFlight + this entry` so the
		// limits reflect the post-enqueue state. The entry is only pushed
		// once the check has passed — a failure must not leak partial state.
		const tentative = { sequence: utterance.sequence, text: utterance.text, characters };
		const backlog = checkBacklog(tentative);
		if (!backlog.ok) {
			// Push so sequence bookkeeping matches what the caller observed;
			// `failWith` then drains pending into `discardedUtterances`.
			pending.push(tentative);
			emit({
				type: "backlog_exceeded",
				reason: backlog.reason,
				queueDepth: backlog.projection.count,
				queueCharacters: backlog.projection.characters,
				estimatedAudioSeconds: Number(backlog.projection.estimatedAudioSeconds.toFixed(3)),
			});
			failWith("speech_backlog_exceeded", "Utterance queue backlog limit exceeded", true);
			return;
		}
		pending.push(tentative);
		emit({ type: "enqueued", sequence: utterance.sequence, characters });
		void step();
	}

	async function closeInput(): Promise<QueueResult> {
		if (settled) {
			return completion;
		}
		inputClosed = true;
		// If nothing is in flight AND nothing pending AND no step is currently
		// mid-shift (which would otherwise race the inFlight assignment), we
		// can complete immediately. Otherwise the queue will settle naturally
		// once the in-flight work drains.
		if (!inFlight && !stepInFlight && pending.length === 0) {
			completeWith();
		}
		return completion;
	}

	async function cancel(reason: QueueCancelReason): Promise<QueueResult> {
		if (settled) {
			return completion;
		}
		settled = true;
		_phase = { kind: "settling" };
		// Mark every pending entry as discarded for the result counters; we
		// also fire a per-utterance discarded event so the coordinator can
		// keep its progress counters honest.
		for (const entry of pending) {
			discardedUtterances += 1;
			emit({ type: "discarded", sequence: entry.sequence, reason: "cancelled" });
		}
		pending.length = 0;
		emit({ type: "cancelled", reason });
		internalController.abort();
		await finalizeSettle({
			status: "cancelled",
			reason,
			completedUtterances,
			failedUtterances,
			discardedUtterances,
		});
		return completion;
	}

	return {
		enqueue,
		closeInput,
		cancel,
		completion,
	};
}

/**
 * Shared, bounded TTS synthesis queue (spec 15.1 / TASK-036).
 *
 * One `EmbedTtsQueue` per process drives **one shared provider** — a model is
 * only ever loaded once and shared across all conversations (never per user,
 * spec "不为每用户加载模型"). Invariants:
 * - **bounded FIFO**: at most `maxPending` queued jobs; enqueue beyond that
 *   returns an interpretable `queue_full` (429) error — never an unbounded
 *   queue (禁止继续项).
 * - **concurrency 1 default** (GPU/audio card): at most `concurrency` jobs
 *   synthesize at once; the rest wait in line.
 * - **on-demand only**: nothing is synthesized automatically — a job exists
 *   only because a client called enqueue (禁止"自动为所有回复生成语音").
 * - **timeout + cancel**: each running job has a deadline (`timeoutMs`) and
 *   can be cancelled; a cancel aborts the in-flight provider call via
 *   `AbortSignal` and removes still-pending jobs (cross-conversation cancel
 *   supported through `cancelForConversation`).
 */
import {
	DEFAULT_TTS_CONCURRENCY,
	DEFAULT_TTS_MAX_PENDING,
	DEFAULT_TTS_TIMEOUT_MS,
	EmbedTtsError,
	type TtsAudioResult,
	type TtsProvider,
	toAbortError,
	ttsCancelledError,
	ttsProviderError,
	ttsQueueFullError,
	ttsTimeoutError,
} from "./provider.ts";

export interface TtsEnqueueInput {
	readonly id: string;
	/** Scope for cross-session cancel (e.g. a conversation the client left). */
	readonly conversationId: string;
	readonly text: string;
	readonly voice?: string;
}

export interface TtsJobHandle {
	readonly id: string;
	/** Resolves with audio when synthesized; rejects with an `EmbedTtsError`. */
	readonly done: Promise<TtsAudioResult>;
	/** Cancel a still-pending job (true if it was removed from the queue). */
	cancel(): boolean;
}

export type TtsEnqueueResult =
	| { readonly ok: true; readonly handle: TtsJobHandle; readonly position: number }
	| { readonly ok: false; readonly error: EmbedTtsError };

export interface TtsQueueStats {
	readonly pendingLocked: number;
	readonly running: number;
	readonly maxPending: number;
	readonly concurrency: number;
}

/** Observable lifecycle events (TASK-035 metrics + observability). */
export interface TtsQueueEvent {
	readonly type: "queued" | "started" | "completed" | "failed" | "cancelled";
	readonly jobId: string;
}

export interface EmbedTtsQueueOptions {
	readonly provider: TtsProvider;
	readonly maxPending?: number;
	readonly concurrency?: number;
	readonly timeoutMs?: number;
	readonly onEvent?: (event: TtsQueueEvent) => void;
}

interface Deferred<T> {
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
	readonly promise: Promise<T>;
}

interface PendingJob {
	readonly id: string;
	readonly conversationId: string;
	readonly text: string;
	readonly voice: string | undefined;
	readonly deferred: Deferred<TtsAudioResult>;
}

interface RunningJob {
	readonly id: string;
	readonly conversationId: string;
	readonly controller: AbortController;
}

export class EmbedTtsQueue {
	private readonly provider: TtsProvider;
	private readonly maxPending: number;
	private readonly concurrency: number;
	private readonly timeoutMs: number;
	private readonly onEvent: ((event: TtsQueueEvent) => void) | undefined;
	private readonly pending: PendingJob[] = [];
	private readonly running = new Map<string, RunningJob>();

	constructor(options: EmbedTtsQueueOptions) {
		if (options.maxPending !== undefined && options.maxPending < 1) {
			throw new Error("TTS queue maxPending must be >= 1");
		}
		if (options.concurrency !== undefined && options.concurrency < 1) {
			throw new Error("TTS queue concurrency must be >= 1");
		}
		if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
			throw new Error("TTS queue timeoutMs must be > 0");
		}
		this.provider = options.provider;
		this.maxPending = options.maxPending ?? DEFAULT_TTS_MAX_PENDING;
		this.concurrency = options.concurrency ?? DEFAULT_TTS_CONCURRENCY;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
		this.onEvent = options.onEvent;
	}

	enqueue(input: TtsEnqueueInput): TtsEnqueueResult {
		if (this.pending.length >= this.maxPending) {
			return { ok: false, error: ttsQueueFullError() };
		}
		const deferred = createDeferred<TtsAudioResult>();
		const job: PendingJob = {
			id: input.id,
			conversationId: input.conversationId,
			text: input.text,
			voice: input.voice,
			deferred,
		};
		const position = this.pending.length;
		this.pending.push(job);
		this.emit("queued", job.id);
		this.pump();
		return {
			ok: true,
			position,
			handle: {
				id: job.id,
				done: deferred.promise,
				cancel: () => this.cancel(job.id),
			},
		};
	}

	/** Remove pending jobs (and abort running jobs) scoped to one conversation. */
	cancelForConversation(conversationId: string): number {
		let affected = 0;
		const stillPending: PendingJob[] = [];
		for (const job of this.pending) {
			if (job.conversationId === conversationId) {
				job.deferred.reject(ttsCancelledError());
				this.emit("cancelled", job.id);
				affected += 1;
			} else {
				stillPending.push(job);
			}
		}
		this.pending.length = 0;
		this.pending.push(...stillPending);
		for (const running of [...this.running.values()]) {
			if (running.conversationId === conversationId) {
				running.controller.abort(ttsCancelledError());
				affected += 1;
			}
		}
		return affected;
	}

	/** Cancel a specific job. Returns true if it was pending (and removed). */
	cancel(id: string): boolean {
		const index = this.pending.findIndex((job) => job.id === id);
		if (index >= 0) {
			const [job] = this.pending.splice(index, 1);
			job.deferred.reject(ttsCancelledError());
			this.emit("cancelled", job.id);
			return true;
		}
		const running = this.running.get(id);
		if (running !== undefined) {
			running.controller.abort(ttsCancelledError());
		}
		return false;
	}

	stats(): TtsQueueStats {
		return {
			pendingLocked: this.pending.length,
			running: this.running.size,
			maxPending: this.maxPending,
			concurrency: this.concurrency,
		};
	}

	private pump(): void {
		while (this.running.size < this.concurrency && this.pending.length > 0) {
			const job = this.pending.shift();
			if (job === undefined) break;
			void this.run(job);
		}
	}

	private async run(job: PendingJob): Promise<void> {
		const controller = new AbortController();
		const running: RunningJob = { id: job.id, conversationId: job.conversationId, controller };
		this.running.set(job.id, running);
		this.emit("started", job.id);
		const timer = setTimeout(() => {
			if (!controller.signal.aborted) controller.abort(ttsTimeoutError());
		}, this.timeoutMs);
		try {
			// Race the provider against an abort (cancel/timeout) waiter so a
			// stuck provider never blocks the queue past its deadline.
			const result = await Promise.race([
				this.provider({ text: job.text, voice: job.voice }, controller.signal),
				waitForAbort(controller),
			]);
			job.deferred.resolve(result);
			this.emit("completed", job.id);
		} catch (error) {
			const err = toTtsError(error);
			job.deferred.reject(err);
			this.emit(err.code === "cancelled" ? "cancelled" : "failed", job.id);
		} finally {
			clearTimeout(timer);
			this.running.delete(job.id);
			this.pump();
		}
	}

	private emit(type: TtsQueueEvent["type"], jobId: string): void {
		this.onEvent?.({ type, jobId });
	}
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

/** Rejects when the abort fires (cancel/timeout), using the abort reason. */
function waitForAbort(controller: AbortController): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		const report = (): void => {
			reject(toAbortError(controller.signal));
		};
		if (controller.signal.aborted) {
			report();
			return;
		}
		controller.signal.addEventListener("abort", report, { once: true });
	});
}

function toTtsError(error: unknown): EmbedTtsError {
	if (error instanceof EmbedTtsError) return error;
	if (error instanceof Error) return ttsProviderError(error.message);
	return ttsProviderError(String(error));
}

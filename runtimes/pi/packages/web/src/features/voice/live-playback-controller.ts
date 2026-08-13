/**
 * Phase 2 live朗读 playback controller.
 *
 * This controller orchestrates a single active live朗读 job per page. It
 * owns the HTTP reader and the operation token, but borrows the page-level
 * `AudioContext` from {@link AudioContextUnlocker} and reuses the V3
 * `PcmDecoder` + `AudioPlayer`. Utterance boundaries are transparent to the
 * decoder — the server concatenates PCM across utterances in one response
 * (Spec §8), so we only need to detect `204` to short-circuit "no speakable
 * text" without raising a synthetic error.
 *
 * Lifecycle invariants (V9 §5.2):
 * - One live Job per HTTP reader.
 * - `stop()` mutes local sources, aborts the reader and dispatches
 *   `cancel_live_speech` through the handle, targeting < 500 ms wall-clock
 *   from button press to silence. Natural completion (`completed` / 204)
 *   does **not** send `cancel_live_speech` — the server is already closing.
 * - Late callbacks (job event / reader read / source onended) consult an
 *   operation token and silently no-op when a newer playback has begun.
 *
 * Operation token (`#operation`) semantics:
 * - Monotonic counter; every entry into a new playback lifecycle (start of
 *   attach, end via stop / natural finish / fail / disconnect / session
 *   change / dispose) increments it.
 * - Callbacks captured at operation X abort themselves when X < current.
 * - Bumping happens at lifecycle transitions, never inside `#teardownPlayback`
 *   so internal callers don't double-bump.
 */

import {
	type LiveSpeechJobHandle,
	type LiveSpeechStreamResult,
	type OpenLiveSpeechStreamOptions,
	openLiveSpeechStream,
} from "@earendil-works/pi-client";
import type { LiveSpeechJob } from "@earendil-works/pi-protocol";
import type { AudioContextUnlocker } from "./audio-context-unlocker.ts";
import type { AudioPlayer } from "./audio-player.ts";
import { AudioPlayer as AudioPlayerImpl } from "./audio-player.ts";
import type { LivePlaybackHooks, LivePlaybackState } from "./live-types.ts";
import { PcmDecoder, type PcmFormat, PcmStreamError, validatePcmFormat } from "./pcm-stream.ts";

export interface LivePlaybackControllerOptions {
	/** Shared unlocker; the controller does not create its own AudioContext. */
	unlocker: AudioContextUnlocker;
	/** HTTP origin of the backend serving `/api/pi/v4/live-speech/{jobId}/stream`. */
	baseUrl: string;
	/** Web bearer token sent in `Authorization`. */
	token?: string;
	/** Hooks for downstream UI / metrics. */
	hooks?: LivePlaybackHooks;
	/** Injectable HTTP opener so tests can fake 200/204/error responses. */
	openStream?: (options: OpenLiveSpeechStreamOptions) => Promise<LiveSpeechStreamResult>;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (id: number) => void;
	firstBufferMs?: number;
	targetBufferMs?: number;
	maxBufferMs?: number;
}

const DEFAULT_TARGET_BUFFER_MS = 250;
const DEFAULT_MAX_BUFFER_MS = 2000;

/** Server-side statuses that should keep the reader running. */
const ACTIVE_STATUSES: ReadonlySet<LiveSpeechJob["status"]> = new Set(["waiting_for_text", "generating", "streaming"]);

export class LivePlaybackController {
	readonly #unlocker: AudioContextUnlocker;
	readonly #baseUrl: string;
	readonly #token: string | undefined;
	readonly #hooks: Required<LivePlaybackHooks>;
	readonly #openStream: (options: OpenLiveSpeechStreamOptions) => Promise<LiveSpeechStreamResult>;
	readonly #requestFrame: ((callback: () => void) => number) | undefined;
	readonly #cancelFrame: ((id: number) => void) | undefined;
	readonly #firstBufferMs: number | undefined;
	readonly #targetBufferMs: number;
	readonly #maxBufferMs: number;
	readonly #listeners = new Set<() => void>();
	#state: LivePlaybackState = "idle";
	#error: string | undefined;
	#handle: LiveSpeechJobHandle | undefined;
	#lastJobId: string | undefined;
	#unsubscribeHandle: (() => void) | undefined;
	#operation = 0;
	#player: AudioPlayer | undefined;
	#decoder: PcmDecoder | undefined;
	#abort: AbortController | undefined;
	#reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	#streamOpening = false;
	#streamResolved = false;
	#drainWaiter: (() => void) | undefined;
	#disposed = false;

	constructor(options: LivePlaybackControllerOptions) {
		this.#unlocker = options.unlocker;
		this.#baseUrl = options.baseUrl;
		this.#token = options.token;
		this.#hooks = {
			onStateChange: options.hooks?.onStateChange ?? (() => {}),
			onError: options.hooks?.onError ?? (() => {}),
			onPlaybackStart: options.hooks?.onPlaybackStart ?? (() => {}),
			onPlaybackEnd: options.hooks?.onPlaybackEnd ?? (() => {}),
		};
		this.#openStream = options.openStream ?? defaultOpenLiveSpeechStream;
		this.#requestFrame = options.requestFrame;
		this.#cancelFrame = options.cancelFrame;
		this.#firstBufferMs = options.firstBufferMs;
		this.#targetBufferMs = options.targetBufferMs ?? DEFAULT_TARGET_BUFFER_MS;
		this.#maxBufferMs = options.maxBufferMs ?? DEFAULT_MAX_BUFFER_MS;
	}

	get state(): LivePlaybackState {
		return this.#state;
	}

	get error(): string | undefined {
		return this.#error;
	}

	get jobId(): string | undefined {
		return this.#handle?.job.id;
	}

	getState = (): LivePlaybackState => this.#state;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Bind a fresh live朗读 handle (returned in `PromptResult.liveSpeech`).
	 * Tears down any previous playback before subscribing and bumps the
	 * operation token so any in-flight callbacks from the prior playback
	 * silently no-op.
	 */
	attach(handle: LiveSpeechJobHandle): void {
		if (this.#disposed) return;
		++this.#operation;
		this.#teardownPlayback();
		this.#handle = handle;
		this.#lastJobId = handle.job.id;
		this.#streamResolved = false;
		this.#unsubscribeHandle = handle.subscribe((job) => this.#handleJob(job));
		this.#handleJob(handle.job);
	}

	/**
	 * Stop the current playback (muted < 500 ms) and dispatch
	 * `cancel_live_speech` through the handle. Idempotent on terminal states.
	 */
	stop(): void {
		if (this.#isTerminal()) return;
		++this.#operation;
		this.#teardownPlayback({ cancel: true });
		this.#setState("stopped");
		this.#hooks.onPlaybackEnd("user_stop");
	}

	/** Stops playback when the active session changes; no client cancel — server cleanup handles it. */
	handleSessionChanged(): void {
		if (this.#isTerminal()) return;
		++this.#operation;
		this.#teardownPlayback();
		this.#setState("stopped");
	}

	/** Stops playback when the underlying connection drops; no client cancel — server cleanup handles it. */
	handleDisconnected(): void {
		if (this.#isTerminal()) return;
		++this.#operation;
		this.#teardownPlayback();
		this.#setState("stopped");
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		++this.#operation;
		this.#teardownPlayback();
		this.#setState("stopped");
		this.#listeners.clear();
		// Do not invoke onPlaybackEnd on dispose: the UI is going away, and
		// downstream consumers (avatar bridge hooks, status row) should not
		// mutate shared state during unmount.
	}

	#isTerminal(): boolean {
		return this.#state === "idle" || this.#state === "ended" || this.#state === "stopped" || this.#state === "error";
	}

	#handleJob(job: LiveSpeechJob): void {
		if (job.id !== this.#lastJobId) return;
		if (job.status === "failed") {
			if (this.#isTerminal()) return;
			this.#fail("语音生成失败", job.error?.message);
			return;
		}
		if (job.status === "cancelled") {
			if (this.#isTerminal()) return;
			this.#fail("朗读已取消", job.error?.message);
			return;
		}
		if (job.status === "completed") {
			if (this.#state === "streaming") this.#setState("draining");
			// A cold voice provider can complete the job before the stream opener
			// resolves with its first PCM chunk. Keep an opening/open reader alive so
			// that audio is still decoded and drained instead of aborting it here.
			const hasPendingAudioStream = this.#streamOpening || this.#reader !== undefined;
			if ((this.#state === "waiting_for_text" || this.#state === "generating") && !hasPendingAudioStream) {
				++this.#operation;
				this.#teardownPlayback();
				this.#setState("ended");
				this.#hooks.onPlaybackEnd("completed");
			}
			return;
		}
		// Active statuses (waiting_for_text, generating, streaming) require the
		// handle binding. If teardown already cleared it, nothing to do.
		if (!this.#handle) return;
		this.#ensureStream();
	}

	#ensureStream(): void {
		if (this.#streamOpening || this.#reader || this.#streamResolved) return;
		const handle = this.#handle;
		if (!handle) return;
		const job = handle.job;
		if (!ACTIVE_STATUSES.has(job.status)) return;
		const operation = this.#operation;
		this.#streamOpening = true;
		if (this.#state === "idle" || this.#state === "waiting_for_text") {
			this.#setState(job.status === "waiting_for_text" ? "waiting_for_text" : "generating");
		}
		const abort = new AbortController();
		this.#abort = abort;
		void this.#openStream({
			baseUrl: this.#baseUrl,
			streamPath: job.streamPath,
			token: this.#token,
			signal: abort.signal,
		})
			.then((stream) => {
				if (operation !== this.#operation || this.#disposed) return;
				this.#streamOpening = false;
				this.#streamResolved = true;
				if (stream === null) {
					// 204: server reports no speakable text. Job will reach `completed`
					// shortly; close out without a synthetic error.
					this.#handleNoSpeakable(operation);
					return;
				}
				const format = validatePcmFormat(stream.format);
				this.#reader = stream.body.getReader();
				void this.#pump(format, operation);
			})
			.catch((error: unknown) => {
				if (operation !== this.#operation || this.#disposed) return;
				this.#streamOpening = false;
				const message = error instanceof Error ? error.message : "语音流中断";
				this.#fail("语音服务不可用", message);
			});
	}

	async #pump(format: PcmFormat, operation: number): Promise<void> {
		const context = this.#unlocker.context();
		if (!context || operation !== this.#operation || this.#disposed) return;
		this.#decoder = new PcmDecoder();
		const player: AudioPlayer = new AudioPlayerImpl({
			context,
			format,
			firstBufferMs: this.#firstBufferMs,
			callbacks: {
				onStarted: () => {
					if (operation !== this.#operation) return;
					this.#setState("streaming");
					this.#hooks.onPlaybackStart();
				},
				onBufferConsumed: () => this.#handleBufferConsumed(operation),
				onFinished: () => this.#handlePlaybackFinished(operation),
			},
			requestFrame: this.#requestFrame,
			cancelFrame: this.#cancelFrame,
		});
		this.#player = player;
		const reader = this.#reader;
		if (!reader) return;
		try {
			while (operation === this.#operation && !this.#disposed) {
				if (player.bufferedDuration > this.#maxBufferMs / 1000) {
					await this.#waitForBufferBelow(player, operation);
					if (operation !== this.#operation || this.#disposed) return;
					continue;
				}
				const { done, value } = await reader.read();
				if (operation !== this.#operation || this.#disposed) return;
				if (done) break;
				if (!value) continue;
				this.#decoder.push(value);
				const samples = this.#decoder.take();
				if (samples.length > 0) player.feed(samples);
			}
			if (operation !== this.#operation || this.#disposed) return;
			this.#decoder.end();
			if (this.#state === "streaming") this.#setState("draining");
			player.endOfStream();
		} catch (error) {
			if (operation !== this.#operation || this.#disposed) return;
			const message = error instanceof PcmStreamError ? error.message : "语音流中断";
			this.#fail("语音流中断", message);
		}
	}

	#handleNoSpeakable(operation: number): void {
		if (operation !== this.#operation || this.#disposed) return;
		// No PCM ever arrived; resolve immediately with a synthetic ended state
		// so the UI doesn't sit in "waiting_for_text" forever. The matching
		// `live_speech_job(completed)` event will follow (or already arrived);
		// #handleJob keeps this idempotent. We bump operation so any
		// subsequent reader / decode callbacks from the resolved promise abort.
		++this.#operation;
		this.#teardownPlayback();
		this.#setState("ended");
		this.#hooks.onPlaybackEnd("completed");
	}

	#waitForBufferBelow(player: AudioPlayer, operation: number): Promise<void> {
		return new Promise((resolve) => {
			this.#drainWaiter = () => {
				if (operation !== this.#operation) {
					resolve();
					this.#drainWaiter = undefined;
					return;
				}
				if (player.bufferedDuration <= this.#targetBufferMs / 1000) {
					this.#drainWaiter = undefined;
					resolve();
				}
			};
		});
	}

	#handleBufferConsumed(operation: number): void {
		if (operation !== this.#operation) return;
		this.#drainWaiter?.();
	}

	#handlePlaybackFinished(operation: number): void {
		if (operation !== this.#operation) return;
		if (this.#state === "stopped" || this.#state === "error") return;
		++this.#operation;
		this.#teardownPlayback();
		this.#setState("ended");
		this.#hooks.onPlaybackEnd("completed");
	}

	/**
	 * Release all per-playback resources (reader, player, decoder, abort
	 * controller, handle subscription, drain waiter). Optionally dispatches
	 * `cancel_live_speech` — only the user-driven `stop()` path does so.
	 * Session change / disconnect / natural completion / 204 / fail leave
	 * server cleanup to the V8 coordinator (Spec §12).
	 */
	#teardownPlayback(options: { cancel?: boolean } = {}): void {
		this.#abort?.abort();
		this.#abort = undefined;
		const reader = this.#reader;
		this.#reader = undefined;
		void reader?.cancel().catch(() => {});
		this.#streamOpening = false;
		this.#streamResolved = false;
		this.#unsubscribeHandle?.();
		this.#unsubscribeHandle = undefined;
		const handle = this.#handle;
		this.#player?.stop();
		this.#player = undefined;
		this.#decoder = undefined;
		if (handle && options.cancel) {
			void handle.cancel().catch(() => {});
		}
		this.#handle = undefined;
		const waiter = this.#drainWaiter;
		this.#drainWaiter = undefined;
		waiter?.();
	}

	#fail(title: string, detail?: string): void {
		if (this.#isTerminal()) return;
		++this.#operation;
		this.#teardownPlayback();
		const safe = detail ? `${title}（${detail}）` : title;
		this.#error = safe;
		this.#setState("error");
		this.#hooks.onError(safe);
		this.#hooks.onPlaybackEnd("error");
	}

	#setState(state: LivePlaybackState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#hooks.onStateChange(state);
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// Subscriber failures cannot corrupt playback state.
			}
		}
	}
}

/** Default stream opener delegating to the typed-client helper. */
const defaultOpenLiveSpeechStream = (options: OpenLiveSpeechStreamOptions): Promise<LiveSpeechStreamResult> =>
	openLiveSpeechStream(options);

import {
	type OpenSpeechStreamOptions,
	openSpeechStream,
	type SpeechJobHandle,
	type SpeechStream,
} from "@earendil-works/pi-client";
import type { SpeechJob, VoiceCapability } from "@earendil-works/pi-protocol";
import { type AudioContextLike, AudioPlayer } from "./audio-player.ts";
import { PcmDecoder, type PcmFormat, PcmStreamError, validatePcmFormat } from "./pcm-stream.ts";
import type {
	PlaybackEndReason,
	PlaybackState,
	SpeechControllerHooks,
	SpeechControllerSource,
	Unsubscribe,
} from "./types.ts";

export interface SpeechControllerOptions {
	/** Minimal PiClient surface used for the control plane. */
	source: SpeechControllerSource;
	/** HTTP origin of the pi-web backend that serves the PCM stream. */
	baseUrl: string;
	/** Web bearer token sent in the `Authorization` header. */
	token?: string;
	hooks?: SpeechControllerHooks;
	/** Creates the AudioContext lazily on the first user-gesture speak. */
	createAudioContext?: () => AudioContextLike;
	/** Injectable HTTP stream opener; defaults to the pi-client helper. */
	openStream?: (options: OpenSpeechStreamOptions) => Promise<SpeechStream>;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (id: number) => void;
	firstBufferMs?: number;
	targetBufferMs?: number;
	maxBufferMs?: number;
}

const DEFAULT_TARGET_BUFFER_MS = 250;
const DEFAULT_MAX_BUFFER_MS = 2000;

const TERMINAL_STATUSES: ReadonlySet<SpeechJob["status"]> = new Set(["completed", "failed", "cancelled"]);

/**
 * Orchestrates one active speech playback per page: start/cancel the server
 * job, open and pump the protected PCM stream, decode and schedule audio, and
 * clean up on session change, disconnect and unmount. Owns the AudioContext it
 * creates; no other feature may create a second media graph for this feature.
 */
export class SpeechController {
	readonly #source: SpeechControllerSource;
	readonly #baseUrl: string;
	readonly #token: string | undefined;
	readonly #hooks: Required<SpeechControllerHooks>;
	readonly #createAudioContext: () => AudioContextLike;
	readonly #openStream: (options: OpenSpeechStreamOptions) => Promise<SpeechStream>;
	readonly #requestFrame: ((callback: () => void) => number) | undefined;
	readonly #cancelFrame: ((id: number) => void) | undefined;
	readonly #firstBufferMs: number | undefined;
	readonly #targetBufferMs: number;
	readonly #maxBufferMs: number;
	readonly #listeners = new Set<() => void>();
	#state: PlaybackState = "idle";
	#error: string | undefined;
	#activeMessageId: string | undefined;
	#voiceProfileId: string | undefined;
	#handle: SpeechJobHandle | undefined;
	#unsubscribeHandle: Unsubscribe | undefined;
	#operation = 0;
	#jobCompleted = false;
	#streamOpening = false;
	#context: AudioContextLike | undefined;
	#player: AudioPlayer | undefined;
	#decoder: PcmDecoder | undefined;
	#abort: AbortController | undefined;
	#reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	#drainWaiter: (() => void) | undefined;
	#disposed = false;

	constructor(options: SpeechControllerOptions) {
		this.#source = options.source;
		this.#baseUrl = options.baseUrl;
		this.#token = options.token;
		this.#hooks = {
			onPlaybackStart: options.hooks?.onPlaybackStart ?? (() => {}),
			onAudioLevel: options.hooks?.onAudioLevel ?? (() => {}),
			onPlaybackEnd: options.hooks?.onPlaybackEnd ?? (() => {}),
		};
		this.#createAudioContext = options.createAudioContext ?? (() => new AudioContext());
		this.#openStream = options.openStream ?? openSpeechStream;
		this.#requestFrame = options.requestFrame;
		this.#cancelFrame = options.cancelFrame;
		this.#firstBufferMs = options.firstBufferMs;
		this.#targetBufferMs = options.targetBufferMs ?? DEFAULT_TARGET_BUFFER_MS;
		this.#maxBufferMs = options.maxBufferMs ?? DEFAULT_MAX_BUFFER_MS;
	}

	get state(): PlaybackState {
		return this.#state;
	}

	get error(): string | undefined {
		return this.#error;
	}

	get activeMessageId(): string | undefined {
		return this.#activeMessageId;
	}

	get voiceAvailable(): boolean {
		return this.#source.snapshot?.voice !== undefined;
	}

	/** The provider-neutral capability advertised by the server snapshot, if any. */
	get voice(): VoiceCapability | undefined {
		return this.#source.snapshot?.voice;
	}

	/** Preferred voice profile for new playbacks; falls back to the server default. */
	get voiceProfileId(): string | undefined {
		return this.#voiceProfileId;
	}

	setVoiceProfile(id: string): void {
		this.#voiceProfileId = id;
		this.#notify();
	}

	getState = (): PlaybackState => this.#state;

	subscribe(listener: () => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Starts speech for a completed assistant message. Must be called from a user
	 * gesture path: the AudioContext is created here and autoplay policies apply.
	 * Any existing playback is stopped first so only one message plays at a time.
	 */
	async speak(sessionId: string, messageId: string, voiceProfileId?: string): Promise<void> {
		if (this.#disposed) return;
		const operation = ++this.#operation;
		this.#teardownPlayback({ reason: "stopped", notify: false });
		this.#setState("requesting");
		this.#activeMessageId = messageId;
		try {
			const profile = voiceProfileId ?? this.#voiceProfileId;
			const handle = await this.#source.startSpeech({
				sessionId,
				messageId,
				...(profile ? { voiceProfileId: profile } : {}),
			});
			if (operation !== this.#operation || this.#disposed) return;
			this.#handle = handle;
			this.#jobCompleted = false;
			this.#unsubscribeHandle = handle.subscribe((job) => this.#handleJob(job));
			this.#handleJob(handle.job);
			this.#ensureStream();
		} catch (error) {
			if (operation !== this.#operation || this.#disposed) return;
			this.#fail("无法开始朗读", error);
		}
	}

	/** Stops the current playback and cancels the job. Idempotent. */
	stop(): void {
		if (this.#state === "idle" || this.#state === "ended" || this.#state === "error") return;
		++this.#operation;
		this.#teardownPlayback({ reason: "stopped", notify: true });
		this.#setState("stopped");
	}

	/** Stops playback when the active session changes or the page navigates away. */
	handleSessionChanged(): void {
		if (this.#state === "idle" || this.#state === "ended") return;
		++this.#operation;
		this.#teardownPlayback({ reason: "stopped", notify: false });
		this.#setState("stopped");
	}

	/** Aborts playback when the connection drops; jobs are cancelled server-side anyway. */
	handleDisconnected(): void {
		if (this.#state === "idle" || this.#state === "ended") return;
		++this.#operation;
		this.#teardownPlayback({ reason: "stopped", notify: false });
		this.#setState("stopped");
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		++this.#operation;
		this.#teardownPlayback({ reason: "stopped", notify: false });
		this.#state = "stopped";
		this.#listeners.clear();
	}

	#handleJob(job: SpeechJob): void {
		if (this.#handle?.job.id !== job.id) return;
		if (job.status === "failed") {
			this.#fail(job.error?.message ?? "语音生成失败");
			return;
		}
		if (job.status === "cancelled") {
			if (this.#state !== "stopped") this.#fail("朗读已取消");
			return;
		}
		if (job.status === "completed") {
			this.#jobCompleted = true;
			if (this.#state === "playing") this.#setState("draining");
			return;
		}
		this.#ensureStream();
	}

	#ensureStream(): void {
		if (this.#streamOpening || this.#reader || !this.#handle) return;
		const job = this.#handle.job;
		if (TERMINAL_STATUSES.has(job.status)) return;
		const operation = this.#operation;
		this.#streamOpening = true;
		this.#setState("buffering");
		const abort = new AbortController();
		this.#abort = abort;
		void this.#openStream({
			baseUrl: this.#baseUrl,
			streamPath: job.streamPath,
			token: this.#token,
			signal: abort.signal,
		})
			.then((stream) => {
				this.#streamOpening = false;
				if (operation !== this.#operation || this.#disposed) return;
				const format = validatePcmFormat(stream.format);
				this.#reader = stream.body.getReader();
				void this.#pump(format, operation);
			})
			.catch((error: unknown) => {
				this.#streamOpening = false;
				if (operation !== this.#operation || this.#disposed) return;
				this.#fail("语音服务不可用", error);
			});
	}

	async #pump(format: PcmFormat, operation: number): Promise<void> {
		const context = await this.#getContext(operation);
		if (!context || operation !== this.#operation || this.#disposed) return;
		this.#decoder = new PcmDecoder();
		const player = new AudioPlayer({
			context,
			format,
			firstBufferMs: this.#firstBufferMs,
			callbacks: {
				onStarted: () => {
					if (operation !== this.#operation) return;
					this.#setState("playing");
					this.#hooks.onPlaybackStart();
				},
				onBufferConsumed: () => this.#handleBufferConsumed(),
				onFinished: () => this.#handlePlaybackFinished(),
				onLevel: (level) => this.#hooks.onAudioLevel(level),
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
					await this.#waitForBufferBelow(player);
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
			this.#jobCompleted = true;
			if (this.#state === "playing") this.#setState("draining");
			player.endOfStream();
		} catch (error) {
			if (operation !== this.#operation || this.#disposed) return;
			this.#fail(error instanceof PcmStreamError ? error.message : "语音流中断", error);
		}
	}

	async #getContext(operation: number): Promise<AudioContextLike | undefined> {
		if (this.#context) return this.#context;
		const context = this.#createAudioContext();
		this.#context = context;
		try {
			await context.resume();
		} catch (error) {
			if (operation !== this.#operation) return undefined;
			this.#fail("浏览器阻止了自动播放", error);
			return undefined;
		}
		return context;
	}

	#waitForBufferBelow(player: AudioPlayer): Promise<void> {
		return new Promise((resolve) => {
			this.#drainWaiter = () => {
				if (player.bufferedDuration <= this.#targetBufferMs / 1000) {
					this.#drainWaiter = undefined;
					resolve();
				}
			};
		});
	}

	#handleBufferConsumed(): void {
		if (this.#jobCompleted && this.#state === "playing") this.#setState("draining");
		this.#drainWaiter?.();
	}

	#handlePlaybackFinished(): void {
		if (this.#state === "stopped" || this.#state === "error") return;
		this.#setState("ended");
		this.#hooks.onPlaybackEnd("completed");
		this.#releasePlaybackResources();
	}

	#teardownPlayback(options: { reason: PlaybackEndReason; notify: boolean }): void {
		const hadActivePlayback = this.#state !== "idle" && this.#state !== "ended" && this.#state !== "error";
		this.#abort?.abort();
		this.#abort = undefined;
		this.#reader = undefined;
		this.#streamOpening = false;
		this.#unsubscribeHandle?.();
		this.#unsubscribeHandle = undefined;
		const handle = this.#handle;
		this.#player?.stop();
		this.#player = undefined;
		this.#handle = undefined;
		// User stop or session change cancels the job; aborting the HTTP stream
		// would cancel it too, but the explicit command is the observable path.
		void handle?.cancel().catch(() => {});
		const waiter = this.#drainWaiter;
		this.#drainWaiter = undefined;
		waiter?.();
		if (hadActivePlayback && options.notify) this.#hooks.onPlaybackEnd(options.reason);
	}

	#releasePlaybackResources(): void {
		this.#reader = undefined;
		this.#abort = undefined;
		this.#streamOpening = false;
		this.#unsubscribeHandle?.();
		this.#unsubscribeHandle = undefined;
		this.#player = undefined;
		this.#handle = undefined;
		this.#drainWaiter = undefined;
	}

	#fail(message: string, cause?: unknown): void {
		void cause;
		this.#abort?.abort();
		this.#abort = undefined;
		this.#reader = undefined;
		this.#streamOpening = false;
		this.#unsubscribeHandle?.();
		this.#unsubscribeHandle = undefined;
		this.#player?.stop();
		this.#player = undefined;
		this.#handle = undefined;
		this.#drainWaiter = undefined;
		this.#error = message;
		this.#setState("error");
		this.#hooks.onPlaybackEnd("error");
	}

	#setState(state: PlaybackState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// Subscriber failures cannot corrupt playback state.
			}
		}
	}
}

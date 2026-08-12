/**
 * Web Audio scheduler for the Pi speech feature.
 *
 * The player turns decoded float32 PCM into sequentially scheduled
 * `AudioBufferSourceNode`s on an injected `AudioContext`. It owns no protocol
 * or network state; the `SpeechController` feeds it decoded samples, signals
 * end-of-stream, and polls {@link AudioPlayer.bufferedDuration} to apply
 * fetch/HTTP backpressure. AudioContext, the clock and animation frames are
 * injected so tests never touch a real sound card.
 */

import type { PcmFormat } from "./pcm-stream.ts";

/** Lead time before the first scheduled source becomes audible (spec §11.3, 80-150 ms). */
export const DEFAULT_FIRST_BUFFER_MS = 120;
/** Lead time re-established after an underrun so the timeline does not keep drifting. */
export const DEFAULT_SAFETY_LEAD_MS = 60;
/** Window (in samples) used for RMS level estimation, aligned with V4 `audio-level.ts`. */
export const LEVEL_WINDOW = 128;
/** Silence gate for level estimation; below this the level is exactly 0. */
export const LEVEL_NOISE_GATE = 0.004;
/** One-pole smoothing factor for level estimation. */
export const LEVEL_SMOOTHING_ALPHA = 0.3;

/** Structural subset of the DOM types, kept minimal so fakes are trivial to build. */
export interface AudioBufferLike {
	readonly duration: number;
	readonly length: number;
	readonly numberOfChannels: number;
	readonly sampleRate: number;
	getChannelData(channel: number): Float32Array;
}

export interface AudioSourceNodeLike {
	buffer: AudioBufferLike | null;
	/** Matches the real DOM signature; zero-arg handlers remain assignable. */
	onended: ((ev: Event) => void) | null;
	connect(destination: unknown): void;
	disconnect(): void;
	start(when?: number): void;
	stop(when?: number): void;
}

export interface AudioContextLike {
	readonly currentTime: number;
	readonly destination: unknown;
	createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
	createBufferSource(): AudioSourceNodeLike;
	resume(): Promise<void>;
}

export interface AudioPlayerCallbacks {
	/** Fired once when the first source is scheduled; the lead time has begun. */
	onStarted?: () => void;
	/** Fired each time a scheduled source finishes (buffered duration dropped). */
	onBufferConsumed?: () => void;
	/** Fired when end-of-stream was signaled and every scheduled source ended. */
	onFinished?: () => void;
	/** Pushed a smoothed 0..1 audio level once per animation frame while active. */
	onLevel?: (level: number) => void;
}

export interface AudioPlayerOptions {
	context: AudioContextLike;
	format: PcmFormat;
	firstBufferMs?: number;
	safetyLeadMs?: number;
	callbacks?: AudioPlayerCallbacks;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (id: number) => void;
}

/**
 * Schedules a continuous, gapless stream of float32 buffers. `completed` at the
 * service level is distinct from local playback finishing: generation EOF must
 * drain the already-scheduled queue before {@link AudioPlayerCallbacks.onFinished}.
 */
export class AudioPlayer {
	readonly #context: AudioContextLike;
	readonly #format: PcmFormat;
	readonly #firstBufferSec: number;
	readonly #safetyLeadSec: number;
	readonly #callbacks: Required<AudioPlayerCallbacks>;
	readonly #requestFrame: ((callback: () => void) => number) | undefined;
	readonly #cancelFrame: ((id: number) => void) | undefined;
	readonly #activeSources = new Set<AudioSourceNodeLike>();
	readonly #sourceDurations = new WeakMap<AudioSourceNodeLike, number>();
	#nextStartTime = -1;
	#queuedSeconds = 0;
	#started = false;
	#eofReached = false;
	#finished = false;
	#stopped = false;
	#disposed = false;
	#underrunCount = 0;
	#frameId: number | undefined;
	#lastSamples: Float32Array = new Float32Array(0);
	#level = 0;

	constructor(options: AudioPlayerOptions) {
		this.#context = options.context;
		this.#format = options.format;
		this.#firstBufferSec = (options.firstBufferMs ?? DEFAULT_FIRST_BUFFER_MS) / 1000;
		this.#safetyLeadSec = (options.safetyLeadMs ?? DEFAULT_SAFETY_LEAD_MS) / 1000;
		this.#callbacks = {
			onStarted: options.callbacks?.onStarted ?? (() => {}),
			onBufferConsumed: options.callbacks?.onBufferConsumed ?? (() => {}),
			onFinished: options.callbacks?.onFinished ?? (() => {}),
			onLevel: options.callbacks?.onLevel ?? (() => {}),
		};
		this.#requestFrame = options.requestFrame;
		this.#cancelFrame = options.cancelFrame;
	}

	/** Seconds of scheduled audio that has not finished playing yet. */
	get bufferedDuration(): number {
		return this.#queuedSeconds;
	}

	/** Number of times the timeline fell behind the context clock and a lead was rebuilt. */
	get underrunCount(): number {
		return this.#underrunCount;
	}

	/** True once at least one source has been scheduled. */
	get started(): boolean {
		return this.#started;
	}

	/** True after end-of-stream and every scheduled source has ended. */
	get finished(): boolean {
		return this.#finished;
	}

	/** True while scheduling is live and the stream has not ended or been stopped. */
	get active(): boolean {
		return this.#started && !this.#finished && !this.#stopped && !this.#disposed;
	}

	/**
	 * Schedules a decoded chunk. The first chunk establishes the initial buffer
	 * lead (`currentTime + firstBufferMs`); later chunks chain seamlessly from the
	 * last start time, rebuilding the safety lead only after an underrun.
	 */
	feed(samples: Float32Array): void {
		if (this.#stopped || this.#disposed || samples.length === 0) return;
		this.#lastSamples = samples;
		const now = this.#context.currentTime;
		if (!this.#started) {
			this.#started = true;
			this.#nextStartTime = now + this.#firstBufferSec;
			this.#callbacks.onStarted();
			this.#startLevelLoop();
		} else {
			if (this.#nextStartTime < now) this.#underrunCount += 1;
			this.#nextStartTime = Math.max(this.#nextStartTime, now + this.#safetyLeadSec);
		}
		this.#schedule(samples, this.#nextStartTime);
		this.#nextStartTime += samples.length / this.#format.sampleRate;
	}

	/** Signals generation EOF. Playback continues until the queued buffers drain. */
	endOfStream(): void {
		if (this.#stopped || this.#disposed) return;
		this.#eofReached = true;
		if (this.#activeSources.size === 0) this.#finish();
	}

	/**
	 * Idempotent stop: silences every active source, clears the queue and the
	 * level loop. Late `onended` callbacks are detached so they cannot fire after
	 * a stop.
	 */
	stop(): void {
		if (this.#stopped || this.#disposed) return;
		this.#stopped = true;
		this.#stopLevelLoop();
		this.#silenceSources();
	}

	/** Releases sources without stopping the caller-owned AudioContext. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopLevelLoop();
		this.#silenceSources();
	}

	#schedule(samples: Float32Array, when: number): void {
		const buffer = this.#context.createBuffer(1, samples.length, this.#format.sampleRate);
		buffer.getChannelData(0).set(samples);
		const source = this.#context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.#context.destination);
		source.onended = () => this.#handleSourceEnded(source);
		source.start(when);
		this.#activeSources.add(source);
		this.#sourceDurations.set(source, buffer.duration);
		this.#queuedSeconds += buffer.duration;
	}

	#handleSourceEnded(source: AudioSourceNodeLike): void {
		if (!this.#activeSources.has(source)) return;
		const duration = this.#sourceDurations.get(source) ?? 0;
		this.#sourceDurations.delete(source);
		this.#activeSources.delete(source);
		this.#queuedSeconds = Math.max(0, this.#queuedSeconds - duration);
		this.#callbacks.onBufferConsumed();
		if (this.#eofReached && this.#activeSources.size === 0) this.#finish();
	}

	#finish(): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#stopLevelLoop();
		this.#callbacks.onFinished();
	}

	#silenceSources(): void {
		for (const source of this.#activeSources) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// A source may already have stopped naturally; silencing is best-effort.
			}
			source.disconnect();
			this.#sourceDurations.delete(source);
		}
		this.#activeSources.clear();
		this.#queuedSeconds = 0;
	}

	#startLevelLoop(): void {
		const requestFrame = this.#requestFrame;
		if (!requestFrame) return;
		const frame = () => {
			if (this.#finished || this.#stopped || this.#disposed) return;
			this.#callbacks.onLevel(this.#computeLevel(this.#lastSamples));
			this.#frameId = requestFrame(frame);
		};
		this.#frameId = requestFrame(frame);
	}

	#stopLevelLoop(): void {
		if (this.#frameId === undefined) return;
		this.#cancelFrame?.(this.#frameId);
		this.#frameId = undefined;
	}

	/**
	 * Windowed RMS of the most recently scheduled chunk, noise-gated, smoothed and
	 * clamped to [0, 1]. Constants mirror V4 `audio-level.ts`; see the V3 handoff
	 * for the recommended unification during avatar integration.
	 */
	#computeLevel(samples: Float32Array): number {
		const start = Math.max(0, samples.length - LEVEL_WINDOW);
		let sum = 0;
		for (let index = start; index < samples.length; index++) {
			const sample = samples[index];
			const clamped = Number.isFinite(sample) ? (sample > 1 ? 1 : sample < -1 ? -1 : sample) : 0;
			sum += clamped * clamped;
		}
		const rms = Math.sqrt(sum / Math.max(1, samples.length - start));
		const gated = rms < LEVEL_NOISE_GATE ? 0 : rms;
		this.#level += LEVEL_SMOOTHING_ALPHA * (gated - this.#level);
		return this.#level > 1 ? 1 : this.#level < 0 ? 0 : this.#level;
	}
}

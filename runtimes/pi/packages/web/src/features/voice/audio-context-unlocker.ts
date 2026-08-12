/**
 * Phase 2 AudioContext unlock helper.
 *
 * The web audio player (V3 `SpeechController`) creates its `AudioContext`
 * lazily on the first `speak()` call from a user gesture. Phase 2 live朗读
 * requires the same gesture to unlock playback *before* the prompt is sent,
 * because the first utterance may arrive before the user can press anything
 * again. This helper owns a single, lazily-created `AudioContext` and exposes
 * a stable `resume()` that callers can invoke from inside a `click`/`keydown`
 * handler. When the browser refuses to unlock (Safari without gesture,
 * autoplay policy in headless, etc.) we surface a single recoverable hint —
 * the text prompt still ships without `speech`.
 *
 * The unlocker does **not** own any playback state. `LivePlaybackController`
 * consumes its `context()` lazily so the audio graph is shared across
 * manual and live playback (V9 §5.2: "复用一个页面级 AudioContext").
 */

import type { AudioContextLike } from "./audio-player.ts";

export type AudioContextUnlockResult =
	| { ok: true; context: AudioContextLike }
	| { ok: false; reason: AudioContextUnlockFailure };

export type AudioContextUnlockFailure = "no_user_gesture" | "create_failed" | "resume_rejected";

export interface AudioContextUnlockerOptions {
	create?: () => AudioContextLike;
	/**
	 * Returns true when the calling site has a real user gesture available.
	 * In tests, the gesture can be faked by returning true unconditionally.
	 */
	hasUserGesture?: () => boolean;
	/** Tests inject a fixed clock; production defaults to a one-shot. */
	clock?: () => number;
}

export class AudioContextUnlocker {
	readonly #create: () => AudioContextLike;
	readonly #hasUserGesture: () => boolean;
	#context: AudioContextLike | undefined;
	#lastUnlockOk = false;

	constructor(options: AudioContextUnlockerOptions = {}) {
		this.#create = options.create ?? (() => new AudioContext());
		this.#hasUserGesture = options.hasUserGesture ?? (() => true);
	}

	/** True once `resume()` has succeeded at least once. */
	get unlocked(): boolean {
		return this.#lastUnlockOk && this.#context !== undefined;
	}

	/** Current context if any; undefined before `resume()` is ever invoked. */
	context(): AudioContextLike | undefined {
		return this.#context;
	}

	/**
	 * Lazily create + `resume()` the shared context. Idempotent: a second call
	 * inside the gesture window is a no-op so multiple components (live + manual
	 * arbitration) can both attempt without re-creating the media graph.
	 */
	async resume(): Promise<AudioContextUnlockResult> {
		if (this.#context && this.#context.currentTime >= 0 && this.#lastUnlockOk) {
			return { ok: true, context: this.#context };
		}
		if (!this.#hasUserGesture()) return { ok: false, reason: "no_user_gesture" };
		let context: AudioContextLike;
		try {
			context = this.#create();
		} catch (error) {
			void error;
			return { ok: false, reason: "create_failed" };
		}
		this.#context = context;
		try {
			await context.resume();
		} catch (error) {
			void error;
			this.#lastUnlockOk = false;
			return { ok: false, reason: "resume_rejected" };
		}
		this.#lastUnlockOk = true;
		return { ok: true, context };
	}

	/**
	 * Drop the cached context reference. Callers invoke this from teardown
	 * paths (pagehide, unmount). The browser may keep the actual media graph
	 * alive on its own; this only releases the Web layer's strong reference.
	 */
	release(): void {
		this.#context = undefined;
		this.#lastUnlockOk = false;
	}
}

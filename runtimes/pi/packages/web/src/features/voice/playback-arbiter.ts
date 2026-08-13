/**
 * Phase 2 page-level playback arbiter.
 *
 * Manual (`SpeechController`) and live (`LivePlaybackController`) playback
 * share the page-level `AudioContext` (Spec §13 / V9 §5.2: "复用一个页面级
 * AudioContext"). The arbiter is the single owner of both controllers and
 * the unlocker; callers (App, hooks) only ever talk to the arbiter.
 *
 * Mutual exclusion:
 * - Starting a manual playback stops any active live playback and vice versa.
 * - The `startManual` and `startLive` paths both teardown the other before
 *   opening, ensuring the page only ever has audio from one source.
 * - `stop()` ends whichever is currently active; calling both is a no-op.
 *
 * Lifecycle glue:
 * - `handleSessionChanged()` / `handleDisconnected()` / `handlePageHide()` /
 *   `dispose()` route through every controller so timers / readers / Audio
 *   nodes / listeners are released regardless of which path was active.
 * - The arbiter exposes the underlying `live` and `manual` controllers for
 *   UIs that need to subscribe to one of them specifically (status row,
 *   manual button). The mutex guarantee only holds at the `startManual` /
 *   `startLive` boundary.
 */

import type { LiveSpeechJobHandle } from "@earendil-works/pi-client";
import { AudioContextUnlocker } from "./audio-context-unlocker.ts";
import type { AudioContextLike } from "./audio-player.ts";
import { LivePlaybackController } from "./live-playback-controller.ts";
import { SpeechController } from "./speech-controller.ts";
import type { SpeechControllerSource } from "./types.ts";

export interface PlaybackArbiterOptions {
	/** Minimal PiClient surface used by the manual controller. */
	source: SpeechControllerSource;
	/** HTTP origin of the pi-web backend that serves both manual and live PCM. */
	baseUrl: string;
	/** Web bearer token sent in `Authorization` for both routes. */
	token?: string;
	/** Injectable AudioContext factory for the unlocker (default: global AudioContext). */
	createAudioContext?: () => AudioContextLike;
	/** Injectable HTTP stream opener for live playback; defaults to pi-client helper. */
	openLiveStream?: (
		options: import("@earendil-works/pi-client").OpenLiveSpeechStreamOptions,
	) => Promise<import("@earendil-works/pi-client").LiveSpeechStreamResult>;
	/** Injectable HTTP stream opener for manual playback. */
	openManualStream?: (
		options: import("@earendil-works/pi-client").OpenSpeechStreamOptions,
	) => Promise<import("@earendil-works/pi-client").SpeechStream>;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (id: number) => void;
}

export class PlaybackArbiter {
	readonly #unlocker: AudioContextUnlocker;
	readonly #manual: SpeechController;
	readonly #live: LivePlaybackController;
	#activeKind: "manual" | "live" | undefined;

	constructor(options: PlaybackArbiterOptions) {
		this.#unlocker = new AudioContextUnlocker({
			create: (options.createAudioContext ?? (() => new AudioContext())) as () => AudioContextLike,
			hasUserGesture: () => true,
		});
		this.#manual = new SpeechController({
			source: options.source,
			baseUrl: options.baseUrl,
			token: options.token,
			// The unlocker is the sole AudioContext factory for the page. Manual
			// playback resumes it in startManual() before SpeechController asks for
			// it, so this never creates a second media graph.
			createAudioContext: () => {
				const context = this.#unlocker.context();
				if (!context) throw new Error("shared AudioContext has not been unlocked");
				return context;
			},
			openStream: options.openManualStream,
			requestFrame: options.requestFrame,
			cancelFrame: options.cancelFrame,
		});
		this.#live = new LivePlaybackController({
			unlocker: this.#unlocker,
			baseUrl: options.baseUrl,
			token: options.token,
			openStream: options.openLiveStream,
			requestFrame: options.requestFrame,
			cancelFrame: options.cancelFrame,
		});
	}

	get unlocker(): AudioContextUnlocker {
		return this.#unlocker;
	}

	get manual(): SpeechController {
		return this.#manual;
	}

	get live(): LivePlaybackController {
		return this.#live;
	}

	get activeKind(): "manual" | "live" | undefined {
		return this.#activeKind;
	}

	/** Resume the shared AudioContext. Used by the live prompt-unlock path. */
	resumeAudioContext(): ReturnType<AudioContextUnlocker["resume"]> {
		return this.#unlocker.resume();
	}

	/**
	 * Start manual playback for a completed assistant message. Stops any
	 * active live playback first so the page never has overlapping audio.
	 */
	async startManual(sessionId: string, messageId: string, voiceProfileId?: string): Promise<void> {
		this.#stopLiveOnly();
		const unlock = await this.#unlocker.resume();
		if (!unlock.ok) {
			throw new Error(`无法启用浏览器音频：${unlock.reason}`);
		}
		// SpeechController.speak() tears down any prior manual job internally.
		await this.#manual.speak(sessionId, messageId, voiceProfileId);
		this.#activeKind = "manual";
	}

	/**
	 * Bind a fresh live handle from a prompt result. Stops any active manual
	 * playback first so the page never has overlapping audio.
	 */
	startLive(handle: LiveSpeechJobHandle): void {
		this.#stopManualOnly();
		this.#live.attach(handle);
		this.#activeKind = "live";
	}

	/**
 Stop whichever controller is currently active. No-op when both are idle.
	 */
	stop(): void {
		this.#stopLiveOnly();
		this.#stopManualOnly();
		this.#activeKind = undefined;
	}

	handleSessionChanged(): void {
		this.#manual.handleSessionChanged();
		this.#live.handleSessionChanged();
		this.#activeKind = undefined;
	}

	handleDisconnected(): void {
		this.#manual.handleDisconnected();
		this.#live.handleDisconnected();
		this.#activeKind = undefined;
	}

	handlePageHide(): void {
		// pagehide behaves like a session change for the active playback: stop
		// without dispatching cancel (server cleanup will close the stream).
		this.#manual.handleSessionChanged();
		this.#live.handleSessionChanged();
		this.#activeKind = undefined;
	}

	dispose(): void {
		this.#manual.dispose();
		this.#live.dispose();
		this.#unlocker.release();
		this.#activeKind = undefined;
	}

	#stopLiveOnly(): void {
		const state = this.#live.state;
		if (state !== "idle" && state !== "ended" && state !== "stopped" && state !== "error") {
			this.#live.stop();
		}
	}

	#stopManualOnly(): void {
		const state = this.#manual.state;
		if (state !== "idle" && state !== "ended" && state !== "stopped" && state !== "error") {
			this.#manual.stop();
		}
	}
}

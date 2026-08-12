/**
 * Phase 2 live朗读 web hook.
 *
 * Layered on top of the page-level {@link PlaybackArbiter}: the arbiter owns
 * the unlocker, manual and live controllers, and the mutex between them.
 * This hook owns only what the React layer needs:
 *
 * - the persisted user opt-in (`live-settings`),
 * - the mirrored `playbackState` from `arbiter.live` for the status row,
 * - lifecycle glue for session change / disconnect / unmount / pagehide
 *   routed through the arbiter so manual + live both clean up.
 *
 * It does **not** render any UI; it returns the inputs and outputs the
 * composer / status row need. Avatar integration is intentionally absent
 * (V9 §5.3: "不接 Avatar").
 */

import type { LiveSpeechJobHandle } from "@earendil-works/pi-client";
import type { ServerSnapshot } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	isLiveAvailable,
	readLiveSpeechEnabled,
	shouldRequestLiveSpeech,
	writeLiveSpeechEnabled,
} from "./live-settings.ts";
import type { LivePlaybackState } from "./live-types.ts";
import type { PlaybackArbiter } from "./playback-arbiter.ts";

export interface UseLiveSpeechOptions {
	/** Reactive server snapshot — drives `available` derived state. */
	snapshot: ServerSnapshot | undefined;
	/** Active session id; changing it routes through the arbiter. */
	sessionId: string | undefined;
	/** Connection state; `disconnected` routes through the arbiter. */
	connectionState: "connected" | "connecting" | "disconnected";
	/** Page-level arbiter that owns the controllers + unlocker. */
	arbiter: PlaybackArbiter | undefined;
	/**
	 * Called once per session when the user accepts the unlock gesture but the
	 * browser refuses to resume the AudioContext. The caller is free to surface
	 * a transient toast. Receivers must not abort the prompt.
	 */
	onUnlockFailed?(reason: "create_failed" | "resume_rejected" | "no_user_gesture"): void;
}

export interface LiveSpeechPromptPreparation {
	/** `true` when the call should attach `speech:{mode:"live"}`. */
	attachSpeech: boolean;
	/** Reason the prep decided to drop the speech payload, if any. */
	droppedReason?: "voice_unavailable" | "user_disabled" | "unlock_failed";
}

export interface UseLiveSpeechResult {
	/** Whether the live朗读 toggle is currently enabled (persisted). */
	enabled: boolean;
	/** Whether the server currently advertises `voice.live === true`. */
	available: boolean;
	setEnabled(next: boolean): void;
	/** Decide whether the next prompt should attach a speech payload. */
	preparePrompt(): Promise<LiveSpeechPromptPreparation>;
	/**
	 * Wire the handle returned by `PromptResult.liveSpeech` into the arbiter.
	 * Idempotent: a second call with the same `job.id` is a no-op.
	 */
	bindHandle(handle: LiveSpeechJobHandle): void;
	/** Stop the active playback (mutes local sources + cancels the live job). */
	stop(): void;
	/** Live playback state — drives the {@link LiveStatusRow}. */
	playbackState: LivePlaybackState;
	/** Latest recoverable error message, if any. */
	error: string | undefined;
}

export function useLiveSpeech(options: UseLiveSpeechOptions): UseLiveSpeechResult {
	const { snapshot, sessionId, connectionState, arbiter, onUnlockFailed } = options;

	const [enabled, setEnabledState] = useState<boolean>(() => readLiveSpeechEnabled());
	const [playbackState, setPlaybackState] = useState<LivePlaybackState>("idle");
	const [error, setError] = useState<string | undefined>(undefined);

	const available = useMemo(() => isLiveAvailable(snapshot), [snapshot]);

	const attachedJobIdRef = useRef<string | undefined>(undefined);

	const lastSessionIdRef = useRef<string | undefined>(sessionId);
	if (lastSessionIdRef.current !== sessionId) {
		lastSessionIdRef.current = sessionId;
		attachedJobIdRef.current = undefined;
	}

	const setEnabled = useCallback((next: boolean) => {
		writeLiveSpeechEnabled(next);
		setEnabledState(next);
	}, []);

	const preparePrompt = useCallback(async (): Promise<LiveSpeechPromptPreparation> => {
		if (!shouldRequestLiveSpeech(enabled, snapshot) || !arbiter) {
			return { attachSpeech: false, droppedReason: enabled ? "voice_unavailable" : "user_disabled" };
		}
		arbiter.stop();
		const unlock = await arbiter.unlocker.resume();
		if (!unlock.ok) {
			onUnlockFailed?.(unlock.reason);
			return { attachSpeech: false, droppedReason: "unlock_failed" };
		}
		return { attachSpeech: true };
	}, [enabled, snapshot, arbiter, onUnlockFailed]);

	const bindHandle = useCallback(
		(next: LiveSpeechJobHandle) => {
			if (!arbiter) return;
			if (attachedJobIdRef.current === next.job.id) return;
			attachedJobIdRef.current = next.job.id;
			arbiter.startLive(next);
		},
		[arbiter],
	);

	const stopPlayback = useCallback(() => arbiter?.stop(), [arbiter]);

	// Mirror arbiter.live state into React render state.
	useEffect(() => {
		if (!arbiter) {
			setPlaybackState("idle");
			return undefined;
		}
		setPlaybackState(arbiter.live.state);
		return arbiter.live.subscribe(() => {
			setPlaybackState(arbiter.live.state);
		});
	}, [arbiter]);

	// Cross-cutting teardown paths route through the arbiter (which stops both
	// manual and live playback regardless of which is active).
	useEffect(() => {
		if (connectionState === "disconnected") arbiter?.handleDisconnected();
	}, [connectionState, arbiter]);

	useEffect(() => {
		if (typeof window === "undefined" || !arbiter) return undefined;
		const onPageHide = () => arbiter.handlePageHide();
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, [arbiter]);

	return {
		enabled,
		available,
		setEnabled,
		preparePrompt,
		bindHandle,
		stop: stopPlayback,
		playbackState,
		error,
	};
}
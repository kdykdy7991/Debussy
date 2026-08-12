import type { SpeechJobHandle, StartSpeechOptions } from "@earendil-works/pi-client";
import type { ServerSnapshot } from "@earendil-works/pi-protocol";

/**
 * Local playback state. The server `SpeechJob` terminal state is deliberately
 * separate: `draining` means the job `completed` but queued audio is still
 * playing, and only the last local `AudioBufferSourceNode` `ended` transitions
 * to `ended`.
 */
export type PlaybackState =
	| "idle"
	| "requesting"
	| "buffering"
	| "playing"
	| "draining"
	| "ended"
	| "stopped"
	| "error";

export type PlaybackEndReason = "completed" | "stopped" | "error";

/** Hooks for downstream consumers (V4 avatar linkage); never required for speech. */
export interface SpeechControllerHooks {
	onPlaybackStart?: () => void;
	onAudioLevel?: (level: number) => void;
	onPlaybackEnd?: (reason: PlaybackEndReason) => void;
}

/** Minimal surface the controller needs from the PiClient. */
export interface SpeechControllerSource {
	readonly snapshot?: ServerSnapshot | undefined;
	startSpeech(options: StartSpeechOptions): Promise<SpeechJobHandle>;
}

export type Unsubscribe = () => void;

/**
 * Phase 2 live朗读 playback state machine.
 *
 * The local states mirror the server `LiveSpeechJob.status` values that the
 * UI needs to communicate to the user (Spec §5.3 / V9 §5.3):
 *
 * ```text
 * idle ──attach()──► waiting_for_text ──► generating ──► streaming ──► draining ──► ended
 *                                                              │
 *                                                              └──── stop/error ──► stopped / error
 * ```
 *
 * `waiting_for_text` is shown while the server waits for the Agent's first
 * assistant delta; `generating` covers the time between the first delta and
 * the first PCM byte; `streaming` is audible playback; `draining` means the
 * server job `completed` but queued audio is still finishing locally.
 */

export type LivePlaybackState =
	| "idle"
	| "waiting_for_text"
	| "generating"
	| "streaming"
	| "draining"
	| "ended"
	| "stopped"
	| "error";

export type LivePlaybackEndReason = "completed" | "user_stop" | "session_changed" | "disconnected" | "error";

export interface LivePlaybackHooks {
	onStateChange?: (state: LivePlaybackState) => void;
	onError?: (message: string) => void;
	onPlaybackStart?: () => void;
	onPlaybackEnd?: (reason: LivePlaybackEndReason) => void;
}

export type Unsubscribe = () => void;

/**
 * Phase 2 live朗读 setting.
 *
 * The toggle is default-off and lives entirely in `localStorage`. The web
 * layer never connects to the avatar bridge, never persists per-session state,
 * and never reflects server capability loss into the toggle itself — instead
 * the prompt path consults `isLiveEnabled(snapshot)` and silently drops the
 * speech payload when `voice.live` is no longer advertised, while still
 * submitting the text prompt. This matches Spec §13 + V9 §5.1.
 */

export const LIVE_SPEECH_STORAGE_KEY = "pi-web-live-speech-enabled";

export interface LiveSpeechSettingSnapshot {
	/** Default false; user must opt in explicitly. */
	enabled: boolean;
	/** True when the server currently advertises `voice.live === true`. */
	available: boolean;
}

/**
 * Reads the persisted user choice. Falls back to `false` when storage is
 * unavailable (private mode, sandboxed iframe, etc.) so callers can treat the
 * returned value as authoritative without an `undefined` branch.
 */
export function readLiveSpeechEnabled(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(LIVE_SPEECH_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeLiveSpeechEnabled(enabled: boolean): void {
	if (typeof window === "undefined") return;
	try {
		if (enabled) window.localStorage.setItem(LIVE_SPEECH_STORAGE_KEY, "1");
		else window.localStorage.removeItem(LIVE_SPEECH_STORAGE_KEY);
	} catch {
		// Persistence is best-effort; the in-memory toggle still applies this session.
	}
}

export function isLiveAvailable(snapshot: { voice?: { live?: boolean } } | undefined): boolean {
	return snapshot?.voice?.live === true;
}

/**
 * Returns true when the user opt-in should produce a live speech request for
 * the current snapshot. Becomes false automatically when the server capability
 * disappears (V9 §5.1: "能力消失自动回退 off for current session"). The toggle
 * itself remains in storage so the next snapshot can opt back in.
 */
export function shouldRequestLiveSpeech(
	persistedEnabled: boolean,
	snapshot: { voice?: { live?: boolean } } | undefined,
): boolean {
	return persistedEnabled && isLiveAvailable(snapshot);
}

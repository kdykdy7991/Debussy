import { useSyncExternalStore } from "react";
import type { PlaybackState } from "./types.ts";

/** The smallest controller surface the button needs, so tests inject a fake. */
export interface SpeechButtonApi {
	readonly activeMessageId: string | undefined;
	subscribe(listener: () => void): () => void;
	getState(): PlaybackState;
	speak(sessionId: string, messageId: string, voiceProfileId?: string): Promise<void>;
	stop(): void;
}

export interface SpeechButtonProps {
	speech: SpeechButtonApi;
	sessionId: string;
	messageId: string;
}

/**
 * Read-aloud / stop toggle for one completed assistant message. The label follows
 * the local playback state: loading while requesting/buffering, "停止" while
 * playing/draining, "朗读" when idle.
 */
export function SpeechButton({ speech, sessionId, messageId }: SpeechButtonProps) {
	const state = useSyncExternalStore(speech.subscribe, speech.getState, speech.getState);
	const active = speech.activeMessageId === messageId;
	const busy = state === "requesting" || state === "buffering";
	const playing = state === "playing" || state === "draining";

	const label = active && playing ? "停止" : active && busy ? "加载中…" : "朗读";
	const className = ["speech-button", active && playing ? "speaking" : "", active && busy ? "loading" : ""]
		.filter(Boolean)
		.join(" ");

	const handleClick = () => {
		console.info("[voice] manual read-aloud click", { sessionId, messageId, state, active });
		if (active && (playing || busy)) {
			speech.stop();
		} else {
			void speech.speak(sessionId, messageId);
		}
	};

	return (
		<button
			className={className}
			type="button"
			onClick={handleClick}
			aria-pressed={active && playing}
			aria-label={active && playing ? "停止朗读" : active && busy ? "正在准备朗读" : "朗读此条消息"}
		>
			<span aria-hidden="true" className="speech-button-icon">
				{active && playing ? "■" : "▶"}
			</span>
			{label}
		</button>
	);
}

/**
 * Chat text/voice mode toggle.
 *
 * Segmented control mirroring the design's "文本模式 / 语音模式" chip. Renders
 * only when the caller has provided a `voiceEngine` prop; otherwise the
 * composer stays text-only. The actual transport/ASR/TTS lifecycle lives in
 * the caller — this component is a dumb switch.
 */

import type { VoiceAsrState } from "../../embed/voice-asr-session.ts";
import type { VoiceEngineStatus } from "../../embed/voice-engine-transport.ts";
import type { VoiceTtsPhase } from "../../embed/voice-tts-session.ts";

export interface VoiceModeToggleProps {
	readonly status: VoiceEngineStatus;
	readonly asr: VoiceAsrState;
	readonly enabled: boolean;
	readonly tts: VoiceTtsPhase;
	readonly disabled?: boolean;
	readonly onToggle: () => void;
}

export function VoiceModeToggle(props: VoiceModeToggleProps): React.ReactElement {
	const { enabled, onToggle, disabled } = props;
	const entryDisabled = disabled === true && !enabled;
	return (
		<fieldset className={`voice-mode-toggle ${enabled ? "is-voice" : "is-text"}`} aria-label="切换文本或语音模式">
			<button
				type="button"
				className="voice-mode-toggle__option"
				data-active={!enabled}
				aria-pressed={!enabled}
				disabled={entryDisabled}
				onClick={() => {
					if (!enabled) return;
					onToggle();
				}}
			>
				<span className="voice-mode-toggle__icon voice-mode-toggle__icon--text">
					<svg viewBox="0 0 16 16" width="12" height="12" focusable="false" aria-hidden="true">
						<title>文本模式</title>
						<rect
							x="3"
							y="3.5"
							width="10"
							height="9"
							rx="1.5"
							stroke="currentColor"
							strokeWidth="1.2"
							fill="none"
						/>
						<path d="M5.5 7.5h5M5.5 9.5h3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
					</svg>
				</span>
				<span>文本模式</span>
			</button>
			<button
				type="button"
				className="voice-mode-toggle__option"
				data-active={enabled}
				aria-pressed={enabled}
				disabled={entryDisabled}
				onClick={() => {
					if (enabled) return;
					onToggle();
				}}
			>
				<span className="voice-mode-toggle__icon voice-mode-toggle__icon--mic">
					<svg viewBox="0 0 16 16" width="12" height="12" focusable="false" aria-hidden="true">
						<title>语音模式</title>
						<rect
							x="6"
							y="2.5"
							width="4"
							height="7.5"
							rx="2"
							stroke="currentColor"
							strokeWidth="1.2"
							fill="none"
						/>
						<path
							d="M3.75 8a4.25 4.25 0 0 0 8.5 0M8 12.25v1.5"
							stroke="currentColor"
							strokeWidth="1.2"
							strokeLinecap="round"
							fill="none"
						/>
					</svg>
				</span>
				<span>语音模式</span>
			</button>
		</fieldset>
	);
}

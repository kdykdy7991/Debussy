export interface VoiceReplyToggleProps {
	readonly enabled: boolean;
	readonly disabled?: boolean;
	readonly onToggle: () => void;
}

/** Text Mode only: keep keyboard input while reading visible Agent replies aloud. */
export function VoiceReplyToggle(props: VoiceReplyToggleProps): React.ReactElement {
	return (
		<button
			type="button"
			className={`voice-reply-toggle ${props.enabled ? "is-enabled" : ""}`}
			aria-pressed={props.enabled}
			disabled={props.disabled}
			onClick={props.onToggle}
		>
			<span className="voice-reply-toggle__icon" aria-hidden="true">
				<svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
					<title>朗读回复</title>
					<path
						d="M2.5 6.25h2.25L8 3.5v9L4.75 9.75H2.5zM10.25 6a3 3 0 0 1 0 4M11.75 4.5a5 5 0 0 1 0 7"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</span>
			<span>朗读回复</span>
			<span className="voice-reply-toggle__state" aria-hidden="true">
				{props.enabled ? "✓" : "○"}
			</span>
		</button>
	);
}

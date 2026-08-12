import type { VoiceCapability } from "@earendil-works/pi-protocol";
import type { ChangeEvent } from "react";

/**
 * Phase 2 live朗读 user toggle.
 *
 * The toggle is rendered inside the SessionRail voice section. It is:
 * - default-off on first render (V9 §5.1: "默认 off, 用户显式开启后本地持久化")
 * - disabled when `voice.live !== true` (V9 §5.1: "仅 voice.live=true 可开启")
 * - persistent across reloads via `localStorage`; the controller wraps the
 *   store access and is the only code that writes the key.
 *
 * The component is intentionally dumb: it owns no audio resources. The parent
 * owns the persisted value and the snapshot.
 */
export interface LiveSpeechToggleProps {
	voice: VoiceCapability | undefined;
	enabled: boolean;
	onChange(next: boolean): void;
}

export function LiveSpeechToggle({ voice, enabled, onChange }: LiveSpeechToggleProps) {
	const available = voice?.live === true;
	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		if (!available) return;
		onChange(event.target.checked);
	};

	return (
		<label className="live-speech-toggle" data-available={available ? "true" : "false"}>
			<span>
				<strong>实时朗读</strong>
				<small>{available ? "首句形成后立即开始播放" : "服务端未启用 live 朗读能力"}</small>
			</span>
			<input
				type="checkbox"
				role="switch"
				checked={enabled}
				disabled={!available}
				onChange={handleChange}
				aria-checked={enabled}
				aria-label={available ? "启用实时朗读" : "实时朗读不可用（服务端未启用）"}
			/>
		</label>
	);
}

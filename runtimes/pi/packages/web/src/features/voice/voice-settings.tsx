import type { VoiceCapability } from "@earendil-works/pi-protocol";
import type { ChangeEvent } from "react";

/** The smallest controller surface settings needs, so tests inject a fake. */
export interface VoiceSettingsSpeech {
	readonly voiceProfileId: string | undefined;
	setVoiceProfile(id: string): void;
}

export interface VoiceSettingsProps {
	voice: VoiceCapability;
	speech: VoiceSettingsSpeech;
}

/**
 * Voice profile selector, shown in the session rail when the server advertises
 * more than the default profile. Profile ids are provider-neutral and never leak
 * speaker/instruct/model details into the client.
 */
export function VoiceSettings({ voice, speech }: VoiceSettingsProps) {
	const profiles = voice.profiles ?? [];
	const current = speech.voiceProfileId ?? voice.defaultProfile;

	if (profiles.length <= 1) {
		return (
			<div className="voice-settings muted">
				<span>朗读语音</span>
				<strong>{profiles[0]?.name ?? voice.defaultProfile}</strong>
			</div>
		);
	}

	const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
		speech.setVoiceProfile(event.target.value);
	};

	return (
		<label className="voice-settings">
			<span>朗读语音</span>
			<select defaultValue={current} onChange={handleChange}>
				{profiles.map((profile) => (
					<option key={profile.id} value={profile.id}>
						{profile.name ?? profile.id}
					</option>
				))}
			</select>
		</label>
	);
}

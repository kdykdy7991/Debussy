import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceSettings, type VoiceSettingsSpeech } from "../src/features/voice/voice-settings.tsx";

describe("VoiceSettings", () => {
	it("shows the default profile name when only one profile exists", () => {
		const voice = {
			available: true as const,
			live: false,
			defaultProfile: "default",
			profiles: [{ id: "default", name: "默认" }],
		};
		const speech: VoiceSettingsSpeech = { voiceProfileId: undefined, setVoiceProfile: () => {} };
		const markup = renderToStaticMarkup(<VoiceSettings voice={voice} speech={speech} />);
		expect(markup).toContain("voice-settings");
		expect(markup).toContain("默认");
		expect(markup).not.toContain("<select");
	});

	it("renders a profile selector when multiple profiles exist", () => {
		const voice = {
			available: true as const,
			live: false,
			defaultProfile: "default",
			profiles: [
				{ id: "default", name: "默认" },
				{ id: "vivian", name: "Vivian" },
			],
		};
		const speech: VoiceSettingsSpeech = { voiceProfileId: "vivian", setVoiceProfile: () => {} };
		const markup = renderToStaticMarkup(<VoiceSettings voice={voice} speech={speech} />);
		expect(markup).toContain("<select");
		expect(markup).toContain('value="default"');
		expect(markup).toContain('value="vivian"');
		expect(markup).toContain("Vivian");
	});

	it("falls back to the profile id when the name is absent", () => {
		const voice = {
			available: true as const,
			live: false,
			defaultProfile: "vivian",
			profiles: [{ id: "vivian" }],
		};
		const speech: VoiceSettingsSpeech = { voiceProfileId: undefined, setVoiceProfile: () => {} };
		const markup = renderToStaticMarkup(<VoiceSettings voice={voice} speech={speech} />);
		expect(markup).toContain("vivian");
	});
});

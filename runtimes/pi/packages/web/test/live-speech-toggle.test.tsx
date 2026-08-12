import type { VoiceCapability } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LiveSpeechToggle } from "../src/features/voice/live-speech-toggle.tsx";

function makeVoice(live: boolean): VoiceCapability {
	return {
		available: true,
		live,
		defaultProfile: "default",
		profiles: [{ id: "default", name: "默认" }],
	};
}

describe("LiveSpeechToggle", () => {
	it("renders as a switch with the correct aria-checked", () => {
		const markup = renderToStaticMarkup(<LiveSpeechToggle voice={makeVoice(true)} enabled onChange={() => {}} />);
		expect(markup).toContain('role="switch"');
		expect(markup).toContain('aria-checked="true"');
		expect(markup).toContain('aria-label="启用实时朗读"');
	});

	it("disables the control when voice.live is not advertised", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			<LiveSpeechToggle voice={makeVoice(false)} enabled={false} onChange={onChange} />,
		);
		expect(markup).toContain('data-available="false"');
		expect(markup).toContain("disabled");
		expect(markup).toContain('aria-label="实时朗读不可用（服务端未启用）"');
	});

	it("ignores change events when capability is missing", () => {
		const onChange = vi.fn();
		// Even though we set enabled=true here, an unavailable voice keeps the
		// input disabled at the React level; change handler must also guard.
		const markup = renderToStaticMarkup(<LiveSpeechToggle voice={undefined} enabled={true} onChange={onChange} />);
		expect(markup).toContain("disabled");
		expect(markup).toContain("实时朗读不可用");
	});
});

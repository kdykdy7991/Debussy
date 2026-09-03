import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceModePanel } from "../../src/features/voice/voice-mode-panel.tsx";
import { VoiceModeToggle } from "../../src/features/voice/voice-mode-toggle.tsx";
import { VoiceReplyToggle } from "../../src/features/voice/voice-reply-toggle.tsx";

describe("Voice Mode presentation", () => {
	it("blocks unavailable entry but never blocks an active mode exit", () => {
		const blockedEntry = renderToStaticMarkup(
			<VoiceModeToggle
				status="disconnected"
				asr={{ phase: "idle" }}
				enabled={false}
				tts="idle"
				disabled
				onToggle={() => {}}
			/>,
		);
		expect(blockedEntry).toContain("disabled");

		const availableExit = renderToStaticMarkup(
			<VoiceModeToggle
				status="closed"
				asr={{ phase: "error", error: "语音连接已断开" }}
				enabled
				tts="idle"
				disabled
				onToggle={() => {}}
			/>,
		);
		expect(availableExit).not.toContain("disabled");
		expect(availableExit).toContain('aria-pressed="true"');
	});

	it("shows playback ahead of the completed ASR phase", () => {
		const markup = renderToStaticMarkup(
			<VoiceModePanel
				status="connected"
				asr={{ phase: "final", finalText: "你好" }}
				mode="voice"
				tts="playing"
				onExit={() => {}}
			/>,
		);
		expect(markup).toContain("正在播放");
		expect(markup).not.toContain("识别已完成,等待 Agent 回复");
	});

	it("does not render the panel in Text Mode", () => {
		const markup = renderToStaticMarkup(
			<VoiceModePanel status="disconnected" asr={{ phase: "idle" }} mode="text" tts="idle" onExit={() => {}} />,
		);
		expect(markup).toBe("");
	});

	it("renders an explicit TTS-only reply switch without implying microphone input", () => {
		const off = renderToStaticMarkup(<VoiceReplyToggle enabled={false} onToggle={() => {}} />);
		expect(off).toContain("朗读回复");
		expect(off).toContain('aria-pressed="false"');

		const on = renderToStaticMarkup(<VoiceReplyToggle enabled onToggle={() => {}} />);
		expect(on).toContain("is-enabled");
		expect(on).toContain('aria-pressed="true"');
	});
});

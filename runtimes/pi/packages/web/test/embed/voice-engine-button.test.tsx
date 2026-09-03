import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceEngineButton } from "../../src/embed/voice-engine-button.tsx";

describe("VoiceEngineButton (release chat composer entry)", () => {
	const idle = { enabled: false, agentResponding: false, tts: "idle" as const };
	const active = { enabled: true, agentResponding: false, tts: "idle" as const };

	it("renders the disconnected label and SVG icon when status is disconnected", () => {
		const markup = renderToStaticMarkup(
			<VoiceEngineButton status="disconnected" asr={{ phase: "idle" }} {...idle} onToggle={() => {}} />,
		);
		expect(markup).toContain("语音模式");
		expect(markup).toContain('data-voice-mode="text"');
		expect(markup).toContain('data-status="disconnected"');
		expect(markup).toContain('aria-pressed="false"');
		expect(markup).toContain('aria-busy="false"');
		expect(markup).toContain("<rect");
	});

	it("marks the button as pressed and shows the connected label when status is connected", () => {
		const markup = renderToStaticMarkup(
			<VoiceEngineButton status="connected" asr={{ phase: "idle" }} {...active} onToggle={() => {}} />,
		);
		expect(markup).toContain("退出语音");
		expect(markup).toContain('data-voice-mode="voice"');
		expect(markup).toContain('data-status="connected"');
		expect(markup).toContain('aria-pressed="true"');
	});

	it("keeps the explicit exit available while connecting", () => {
		const markup = renderToStaticMarkup(
			<VoiceEngineButton status="connecting" asr={{ phase: "idle" }} {...active} onToggle={() => {}} />,
		);
		expect(markup).not.toContain("disabled");
		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain("连接中");
	});

	it("shows the closed label after a server-side or upstream failure", () => {
		const markup = renderToStaticMarkup(
			<VoiceEngineButton status="closed" asr={{ phase: "idle" }} {...active} onToggle={() => {}} />,
		);
		expect(markup).toContain("语音模式 · 错误");
		expect(markup).toContain('data-status="closed"');
		expect(markup).not.toContain("disabled");
	});

	it("shows listening, final transcript, and service errors in the debug state", () => {
		const listening = renderToStaticMarkup(
			<VoiceEngineButton status="connected" asr={{ phase: "listening" }} {...active} onToggle={() => {}} />,
		);
		expect(listening).toContain("正在聆听");
		expect(listening).toContain('aria-pressed="true"');
		const final = renderToStaticMarkup(
			<VoiceEngineButton
				status="connected"
				asr={{ phase: "final", finalText: "项目进度" }}
				{...active}
				onToggle={() => {}}
			/>,
		);
		expect(final).toContain("ASR final: 项目进度");
		const failed = renderToStaticMarkup(
			<VoiceEngineButton
				status="connected"
				asr={{ phase: "error", error: "识别失败" }}
				{...active}
				onToggle={() => {}}
			/>,
		);
		expect(failed).toContain("语音错误: 识别失败");
	});

	it("derives Agent and playback status without a second state machine", () => {
		const replying = renderToStaticMarkup(
			<VoiceEngineButton
				status="connected"
				asr={{ phase: "final" }}
				{...active}
				agentResponding
				onToggle={() => {}}
			/>,
		);
		expect(replying).toContain("Agent 回复中");
		const playing = renderToStaticMarkup(
			<VoiceEngineButton
				status="connected"
				asr={{ phase: "final" }}
				{...active}
				tts="playing"
				onToggle={() => {}}
			/>,
		);
		expect(playing).toContain("正在播放");
	});
});

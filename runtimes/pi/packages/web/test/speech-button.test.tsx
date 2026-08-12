import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SpeechButton, type SpeechButtonApi } from "../src/features/voice/speech-button.tsx";
import type { PlaybackState } from "../src/features/voice/types.ts";

function fakeSpeech(state: PlaybackState, activeMessageId: string | undefined): SpeechButtonApi {
	return {
		activeMessageId,
		subscribe: () => () => {},
		getState: () => state,
		speak: vi.fn(async () => {}),
		stop: vi.fn(),
	};
}

function render(state: PlaybackState, activeMessageId: string | undefined): string {
	return renderToStaticMarkup(
		<SpeechButton speech={fakeSpeech(state, activeMessageId)} sessionId="s" messageId="m" />,
	);
}

describe("SpeechButton", () => {
	it("shows 朗读 for an idle message", () => {
		const markup = render("idle", undefined);
		expect(markup).toContain("speech-button");
		expect(markup).toContain("朗读");
		expect(markup).not.toContain('aria-pressed="true"');
	});

	it("shows 加载中 while the same message is requesting", () => {
		const markup = render("requesting", "m");
		expect(markup).toContain("加载中");
		expect(markup).toContain("正在准备朗读");
	});

	it("shows 停止 while the same message is playing", () => {
		const markup = render("playing", "m");
		expect(markup).toContain("停止");
		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain("停止朗读");
	});

	it("shows 朗读 for a different message while another plays", () => {
		const markup = render("playing", "other-message");
		expect(markup).toContain("朗读");
		expect(markup).not.toContain("停止");
	});

	it("marks a stopped playback as 朗读 again", () => {
		const markup = render("stopped", "m");
		expect(markup).toContain("朗读");
	});
});

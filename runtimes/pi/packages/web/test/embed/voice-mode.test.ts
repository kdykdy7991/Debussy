import { describe, expect, it, vi } from "vitest";
import { allowsPublishedChatSubmit, cleanupVoiceMode } from "../../src/embed/voice-mode.ts";

describe("Published Chat Text / Voice mode", () => {
	it("allows only the active mode's submission source", () => {
		expect(allowsPublishedChatSubmit("text", "composer")).toBe(true);
		expect(allowsPublishedChatSubmit("text", "asr")).toBe(false);
		expect(allowsPublishedChatSubmit("voice", "composer")).toBe(false);
		expect(allowsPublishedChatSubmit("voice", "asr")).toBe(true);
	});

	it("cleans ASR, TTS/playback, and transport when leaving Voice Mode", async () => {
		const cancel = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const close = vi.fn();

		await cleanupVoiceMode({ asr: { cancel }, tts: { stop }, transport: { close } });

		expect(cancel).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});
});

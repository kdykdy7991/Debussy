import { describe, expect, it, vi } from "vitest";
import { submitAsrFinalOnce } from "../../src/embed/voice-asr-submit.ts";

describe("asr.final → existing conversation submit path", () => {
	it("passes ASR text unchanged to the same submit callback exactly once", () => {
		const submitted = new Set<string>();
		const existingSubmit = vi.fn(() => true);
		expect(submitAsrFinalOnce("asr-1", "  帮我查进度  ", submitted, existingSubmit)).toBe(true);
		expect(submitAsrFinalOnce("asr-1", "  帮我查进度  ", submitted, existingSubmit)).toBe(false);
		expect(existingSubmit).toHaveBeenCalledOnce();
		expect(existingSubmit).toHaveBeenCalledWith("  帮我查进度  ");
	});

	it("does not submit blank finals and retries when the existing path is temporarily busy", () => {
		const submitted = new Set<string>();
		const existingSubmit = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
		expect(submitAsrFinalOnce("blank", " \n\t ", submitted, existingSubmit)).toBe(false);
		expect(existingSubmit).not.toHaveBeenCalled();
		expect(submitAsrFinalOnce("asr-2", "继续", submitted, existingSubmit)).toBe(false);
		expect(submitAsrFinalOnce("asr-2", "继续", submitted, existingSubmit)).toBe(true);
		expect(existingSubmit).toHaveBeenCalledTimes(2);
	});

	it("keeps keyboard → voice → keyboard messages in the caller-owned conversation", () => {
		const conversationId = "current-conversation";
		const turns: Array<{ conversationId: string; text: string }> = [];
		const existingSubmit = (text: string): boolean => {
			turns.push({ conversationId, text });
			return true;
		};
		existingSubmit("键盘一");
		submitAsrFinalOnce("asr-3", "语音二", new Set(), existingSubmit);
		existingSubmit("键盘三");
		expect(turns).toEqual([
			{ conversationId, text: "键盘一" },
			{ conversationId, text: "语音二" },
			{ conversationId, text: "键盘三" },
		]);
	});
});

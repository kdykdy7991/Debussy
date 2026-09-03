import { describe, expect, it } from "vitest";
import { VoiceSentenceBuffer } from "../../src/embed/voice-sentence-buffer.ts";

describe("VoiceSentenceBuffer", () => {
	it("extracts only simple configured sentence endings across deltas", () => {
		const buffer = new VoiceSentenceBuffer();
		expect(buffer.push("第一句还")).toEqual([]);
		expect(buffer.push("没完。第二句！第三句?尾")).toEqual(["第一句还没完。", "第二句！", "第三句?"]);
		expect(buffer.flush()).toEqual(["尾"]);
	});

	it("drops whitespace tails and clears pending text", () => {
		const buffer = new VoiceSentenceBuffer();
		buffer.push("不会被朗读");
		buffer.clear();
		expect(buffer.flush()).toEqual([]);
		buffer.push("  \n");
		expect(buffer.flush()).toEqual([]);
	});
});

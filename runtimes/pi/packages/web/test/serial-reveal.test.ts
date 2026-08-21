import { describe, expect, it } from "vitest";
import {
	computeSerialRevealPlan,
	estimateAnimatedSegments,
	type RevealClock,
} from "../src/conversation/serial-reveal.ts";

const timing = { stagger: 40, duration: 240 };

function clock(): RevealClock {
	return { freeAt: 0 };
}

describe("estimateAnimatedSegments", () => {
	it("counts each non-whitespace char for plain prose (sep:char)", () => {
		expect(estimateAnimatedSegments("你好世界")).toBe(4);
		expect(estimateAnimatedSegments("第一段甲乙丙。")).toBe(7);
	});

	it("drops code / math / image constructs that the animate plugin skips", () => {
		expect(estimateAnimatedSegments("```js\nfoo()\n```")).toBe(0);
		expect(estimateAnimatedSegments("    const a = 1;")).toBe(0);
		expect(estimateAnimatedSegments("$$\nE=mc^2\n$$")).toBe(0);
		expect(estimateAnimatedSegments("![图](http://example.com/a.png)")).toBe(0);
		expect(estimateAnimatedSegments("前后`inline code`文字")).toBe(4);
	});

	it("keeps link text but drops the URL and markdown markers", () => {
		expect(estimateAnimatedSegments("[链接文字](http://example.com)")).toBe(4);
		expect(estimateAnimatedSegments("## 标题文字")).toBe(4);
		expect(estimateAnimatedSegments("- 列表项")).toBe(3);
	});
});

describe("computeSerialRevealPlan", () => {
	it("serializes paragraphs when a complete multi-block message mounts in one commit", () => {
		const plan = computeSerialRevealPlan("第一段甲乙丙。\n\n第二段子丑寅卯辰巳。", undefined, clock(), timing, 0);
		// blocks: ["第一段甲乙丙。", "\n\n", "第二段子丑寅卯辰巳。"]
		expect(plan.blocks).toEqual(["第一段甲乙丙。", "\n\n", "第二段子丑寅卯辰巳。"]);
		// 第一段 7 chars -> 6*40+240 = 480ms 后显影完成
		expect(plan.offsets[0]).toBe(0);
		expect(plan.ends[0]).toBe(6 * 40 + 240);
		// 分隔块不产生动画、不推进排队
		expect(plan.ends[1]).toBe(0);
		// 第二段必须等第一段显影结束才开始
		expect(plan.offsets[2]).toBe(plan.ends[0]);
		expect(plan.ends[2]).toBe(plan.offsets[2] + 9 * 40 + 240);
	});

	it("keeps the rolling wave while a single paragraph streams (offset stays 0)", () => {
		const c = clock();
		const step1 = computeSerialRevealPlan("第一段甲乙", undefined, c, timing, 0);
		expect(step1.mount).toBe(true);
		expect(step1.offsets[0]).toBe(0);
		const step2 = computeSerialRevealPlan("第一段甲乙丙丁戊", step1, c, timing, 90);
		expect(step2.mount).toBe(false);
		// 同一段新增内容不被自身上一次的尾部动画延迟
		expect(step2.offsets[0]).toBe(0);
		expect(step2.ends[0]).toBe(2 * 40 + 240);
	});

	it("gates a new paragraph behind the previous paragraph's still-running tail", () => {
		const c = clock();
		const step1 = computeSerialRevealPlan("第一段甲乙丙。", undefined, c, timing, 0);
		expect(step1.ends[0]).toBe(6 * 40 + 240); // 480ms
		const step2 = computeSerialRevealPlan("第一段甲乙丙。\n\n第二段子丑", step1, c, timing, 90);
		// 第一段仍有 480-90=390ms 尾部动画，第二段须排在其后
		expect(step2.offsets[2]).toBe(480 - 90);
		// 第一段未变化：offset 归零（不重排），end 结转为剩余时间
		expect(step2.offsets[0]).toBe(0);
		expect(step2.ends[0]).toBe(480 - 90);
	});

	it("serializes text parts of one message through the shared clock", () => {
		const c = clock();
		const part1 = computeSerialRevealPlan("工具调用前的说明段落。", undefined, c, timing, 0);
		expect(part1.offsets[0]).toBe(0);
		const part1End = part1.ends[0];
		// 同一次提交内挂载的第二个 text part：从第一个 part 显影结束处开始
		const part2 = computeSerialRevealPlan("工具调用后的总结段落。", undefined, c, timing, 0);
		expect(part2.offsets[0]).toBe(part1End);
		expect(c.freeAt).toBe(part2.ends[0]);
	});

	it("starts later parts immediately once earlier content has finished revealing", () => {
		const c = clock();
		const part1 = computeSerialRevealPlan("工具调用前的说明段落。", undefined, c, timing, 0);
		const part1End = part1.ends[0];
		// 5 秒后才出现的 part：无需等待
		const part2 = computeSerialRevealPlan("工具调用后的总结段落。", undefined, c, timing, part1End + 5000);
		expect(part2.offsets[0]).toBe(0);
	});

	it("never decreases the clock and tracks the latest reveal end", () => {
		const c = clock();
		const step1 = computeSerialRevealPlan("第一段甲乙。", undefined, c, timing, 0);
		const atStep1 = c.freeAt;
		expect(atStep1).toBe(step1.ends[0]);
		// 同 part 后续增长不回退时钟，只前进
		computeSerialRevealPlan("第一段甲乙丙丁。", step1, c, timing, 90);
		expect(c.freeAt).toBeGreaterThanOrEqual(atStep1);
	});

	it("skips code blocks in the serial queue (they animate nothing)", () => {
		const plan = computeSerialRevealPlan(
			"说明文字。\n\n```js\nfoo()\n```\n\n结尾文字。",
			undefined,
			clock(),
			timing,
			0,
		);
		// blocks: ["说明文字。", "\n\n", "```js\nfoo()\n```", "\n\n", "结尾文字。"]
		const proseEnd = plan.ends[0];
		expect(plan.ends[2]).toBe(0); // 代码块不推进排队
		// 结尾段紧随其后，不被代码块拖延
		expect(plan.offsets[4]).toBe(proseEnd);
	});

	it("returns an empty plan for empty text", () => {
		const plan = computeSerialRevealPlan("", undefined, clock(), timing, 0);
		expect(plan.blocks).toEqual([]);
		expect(plan.offsets).toEqual([]);
		expect(plan.ends).toEqual([]);
	});

	it("queues a paragraph appended in the same commit behind the paragraph's own new tail", () => {
		const c = clock();
		const step1 = computeSerialRevealPlan("第一段。", undefined, c, timing, 0);
		// 一次 flush 同时带来第一段结尾 + 新段落开头
		const step2 = computeSerialRevealPlan("第一段甲乙丙丁。\n\n第二段", step1, c, timing, 90);
		// 第一段新增"甲乙丙丁。"：offset 0（rolling wave），5 chars -> 4*40+240
		expect(step2.offsets[0]).toBe(0);
		expect(step2.ends[0]).toBe(4 * 40 + 240);
		// 第二段必须排第一段本次新增内容的显影结束之后
		expect(step2.offsets[2]).toBe(step2.ends[0]);
	});
});

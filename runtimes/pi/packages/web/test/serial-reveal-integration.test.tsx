import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { SOFT_REVEAL, SerialRevealContext, StableMarkdownBlock, softRevealOptions } from "../src/conversation/ai-message-flow.tsx";
import {
	computeSerialRevealPlan,
	estimateAnimatedSegments,
	type RevealClock,
	type SerialRevealPlan,
} from "../src/conversation/serial-reveal.ts";

const timing = { stagger: SOFT_REVEAL.stagger, duration: SOFT_REVEAL.duration };

interface AnimatedSpan {
	delay: number;
	duration: number;
}

/** 用真实的 StableMarkdownBlock（含挂载期 animatePlugin 包装）渲染整条消息。 */
function renderBlockSpans(text: string, plan: SerialRevealPlan): AnimatedSpan[][] {
	const html = renderToStaticMarkup(
		<SerialRevealContext.Provider value={plan}>
			<Streamdown
				className="ai-markdown"
				mode="streaming"
				isAnimating
				animated={softRevealOptions}
				BlockComponent={StableMarkdownBlock}
				skipHtml
			>
				{text}
			</Streamdown>
		</SerialRevealContext.Provider>,
	);
	const parts = html.split('<div class="ai-stream-markdown-block" data-stream-block="');
	parts.shift();
	return parts.map((part) =>
		[...part.matchAll(/<span data-sd-animate="true" style="([^"]*)"/g)].map((match) => {
			const style = match[1] ?? "";
			return {
				delay: Number(style.match(/--sd-delay:(\d+)ms/)?.[1] ?? 0),
				duration: Number(style.match(/--sd-duration:(\d+)ms/)?.[1] ?? 0),
			};
		}),
	);
}

describe("serial reveal against real Streamdown output (mount case)", () => {
	const text = "第一段甲乙丙。\n\n## 小节标题\n\n- 列表项甲\n- 列表项乙\n\n第二段子丑寅卯辰巳。";
	const clock: RevealClock = { freeAt: 0 };
	const plan = computeSerialRevealPlan(text, undefined, clock, timing, 0);
	const blocks = renderBlockSpans(text, plan);

	it("all blocks animate fully on mount (no prevContentLength bleed)", () => {
		expect(blocks.length).toBe(plan.blocks.length);
		for (let i = 0; i < blocks.length; i++) {
			const animating = (blocks[i] ?? []).filter((span) => span.duration > 0).length;
			expect(animating).toBe(estimateAnimatedSegments(plan.blocks[i] ?? ""));
		}
	});

	it("raw plugin output starts every block's timeline at delay 0 (the parallel bug)", () => {
		const contentBlocks = blocks.filter((spans) => spans.some((span) => span.duration > 0));
		expect(contentBlocks.length).toBeGreaterThanOrEqual(4);
		for (const spans of contentBlocks) {
			expect(spans[0]?.delay).toBe(0);
		}
	});

	it("applying the plan offsets makes block reveals strictly serial", () => {
		const contentIndices = blocks
			.map((spans, i) => i)
			.filter((i) => (blocks[i] ?? []).some((span) => span.duration > 0));
		for (let k = 0; k + 1 < contentIndices.length; k++) {
			const cur = blocks[contentIndices[k]] ?? [];
			const next = blocks[contentIndices[k + 1]] ?? [];
			const curOffset = plan.offsets[contentIndices[k]] ?? 0;
			const nextOffset = plan.offsets[contentIndices[k + 1]] ?? 0;
			expect(nextOffset).toBeGreaterThan(0);
			const curEnd = Math.max(...cur.map((span) => curOffset + span.delay + span.duration));
			const nextStart = Math.min(...next.map((span) => nextOffset + span.delay));
			expect(nextStart).toBeGreaterThanOrEqual(curEnd);
		}
	});

	it("leaves separator and code blocks without animated spans", () => {
		const codeText = "说明文字。\n\n```js\nfoo()\n```\n\n结尾文字。";
		const codePlan = computeSerialRevealPlan(codeText, undefined, { freeAt: 0 }, timing, 0);
		const codeBlocks = renderBlockSpans(codeText, codePlan);
		expect(codeBlocks.length).toBe(codePlan.blocks.length);
		const counts = codeBlocks.map((spans) => spans.filter((span) => span.duration > 0).length);
		// 正文块有动画，分隔块与代码块没有
		expect(counts).toEqual([5, 0, 0, 0, 5]);
	});
});

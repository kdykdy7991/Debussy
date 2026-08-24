import { describe, expect, test } from "vitest";
import { CHARS_PER_TOKEN, estimateContextSnapshot } from "../../src/agent-v2/context.ts";

describe("estimateContextSnapshot (M1 ContextUsageSnapshot estimator)", () => {
	test("usedTokens equals the breakdown sum and remaining derives from the window", () => {
		const s = estimateContextSnapshot({
			contextWindow: 400,
			systemPromptText: "a".repeat(40), // 10 tokens
			conversationMessagesText: "b".repeat(80), // 20 tokens
			toolDefinitionsText: "c".repeat(20), // 5 tokens
		});
		expect(s.measurement).toBe("estimated");
		// 校验具体语义字段
		expect(s.breakdown.systemPrompt).toBe(10);
		expect(s.breakdown.conversationMessages).toBe(20);
		expect(s.breakdown.toolDefinitions).toBe(5);
		const sum =
			s.breakdown.systemPrompt +
			s.breakdown.skillInstructions +
			s.breakdown.toolDefinitions +
			s.breakdown.conversationMessages +
			s.breakdown.toolResults +
			s.breakdown.retrievalContext +
			s.breakdown.attachments;
		expect(s.usedTokens).toBe(sum);
		expect(s.usedTokens).toBe(35);
		expect(s.contextWindow).toBe(400);
		expect(s.reservedOutputTokens).toBe(0);
		expect(s.remainingTokens).toBe(400 - 35);
		expect(s.usagePercent).toBe(Number(((35 / 400) * 100).toFixed(2)));
	});

	test("unestimated categories are honestly 0 when no source exists", () => {
		const s = estimateContextSnapshot({ contextWindow: 100, systemPromptText: "", conversationMessagesText: "" });
		expect(s.breakdown.skillInstructions).toBe(0);
		expect(s.breakdown.toolResults).toBe(0);
		expect(s.breakdown.retrievalContext).toBe(0);
		expect(s.breakdown.attachments).toBe(0);
		expect(s.breakdown.toolDefinitions).toBe(0);
		expect(s.usedTokens).toBe(0);
	});

	test("char heuristic and window clamping", () => {
		expect(CHARS_PER_TOKEN).toBe(4);
		expect(
			estimateContextSnapshot({ contextWindow: 0, systemPromptText: "abcd", conversationMessagesText: "" })
				.contextWindow,
		).toBe(1);
		expect(
			estimateContextSnapshot({ contextWindow: 1, systemPromptText: "abcdefgh", conversationMessagesText: "" })
				.remainingTokens,
		).toBe(0);
	});
});

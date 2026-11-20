import { describe, expect, test } from "vitest";
import {
	buildTurnMetrics,
	startTurnTiming,
	usageCountsFromTokenTotals,
	type TurnTimingBase,
} from "../../src/agent-v2/turn-metrics.ts";

const EPOCH = 1_700_000_000_000;
function base(): TurnTimingBase {
	// 单调基准 1000，epoch 基准 EPOCH ms。
	return { monotonicStartMs: 1000, epochStartMs: EPOCH };
}

describe("buildTurnMetrics (M1 runtime timing -> frozen TurnMetrics)", () => {
	test("derives ttft/generation/tokensPerSecond from monotonic events and emits display stamps", () => {
		const m = buildTurnMetrics({
			outcome: "success",
			base: base(),
			events: { providerStartAtMs: 1150, firstOutputAtMs: 1600, completedAtMs: 4200 },
			usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50 },
		});
		expect(m.ttftMs).toBe(600 - 150); // 450
		expect(m.generationMs).toBe(3200 - 600); // 2600
		expect(m.totalLatencyMs).toBe(3200);
		expect(m.outputTokensPerSecond).toBeCloseTo((200 / 2600) * 1000, 2);
		expect(m.stamps.requestStartedAt).toBe(new Date(EPOCH).toISOString());
		expect(m.stamps.providerStartedAt).toBe(new Date(EPOCH + 150).toISOString());
		expect(m.stamps.firstOutputAt).toBe(new Date(EPOCH + 600).toISOString());
		expect(m.stamps.completedAt).toBe(new Date(EPOCH + 3200).toISOString());
	});

	test("failed/cancelled outcome keeps derived timing null", () => {
		const m = buildTurnMetrics({
			outcome: "failed",
			base: base(),
			events: { providerStartAtMs: 1000, firstOutputAtMs: null, completedAtMs: 1400 },
			usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		expect(m.outcome).toBe("failed");
		expect(m.ttftMs).toBeNull();
		expect(m.generationMs).toBeNull();
		expect(m.outputTokensPerSecond).toBeNull();
		expect(m.totalLatencyMs).toBe(400);
	});

	test("non-streaming burst (firstOutput == completed) yields generation 0 and null tps", () => {
		const m = buildTurnMetrics({
			outcome: "success",
			base: base(),
			events: { providerStartAtMs: 1150, firstOutputAtMs: 4200, completedAtMs: 4200 },
			usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		expect(m.ttftMs).toBe(3200 - 150);
		expect(m.generationMs).toBe(0);
		expect(m.outputTokensPerSecond).toBeNull();
	});

	test("out-of-order monotonic input throws RangeError (no silent negatives)", () => {
		expect(() =>
			buildTurnMetrics({
				outcome: "success",
				base: base(),
				events: { providerStartAtMs: 1600, firstOutputAtMs: 1150, completedAtMs: 4200 },
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
			}),
		).toThrow(RangeError);
	});

	test("startTurnTiming with injected clocks captures both bases", () => {
		const t = startTurnTiming(
			() => 42,
			() => 123_456_789,
		);
		expect(t).toEqual({ monotonicStartMs: 42, epochStartMs: 123_456_789 });
	});

	test("tokenScope marks the caliber of the recorded tokens", () => {
		const whole = buildTurnMetrics({
			outcome: "success",
			base: base(),
			events: { providerStartAtMs: 1000, firstOutputAtMs: null, completedAtMs: 1400 },
			usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 0 },
			tokenScope: "turn",
		});
		expect(whole.tokenScope).toBe("turn");
		expect(whole.inputTokens).toBe(1500);
		expect(whole.outputTokens).toBe(300);
		expect(whole.cacheReadTokens).toBe(200);

		// 历史行没有该字段：按「只取最后一次调用」解释，绝不当成整轮累计。
		const legacy = buildTurnMetrics({
			outcome: "success",
			base: base(),
			events: { providerStartAtMs: 1000, firstOutputAtMs: null, completedAtMs: 1400 },
			usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		expect(legacy.tokenScope).toBeUndefined();
	});
});

describe("usageCountsFromTokenTotals (provider token 分项 -> 轮指标计数)", () => {
	test("maps the whole-turn totals of every model call", () => {
		expect(
			usageCountsFromTokenTotals({ input: 1500, output: 300, cacheRead: 200, cacheWrite: 50 }),
		).toEqual({ inputTokens: 1500, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 50 });
	});

	test("missing source counts as zero; missing fields default to zero", () => {
		expect(usageCountsFromTokenTotals(undefined)).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(usageCountsFromTokenTotals({ input: 7 })).toEqual({
			inputTokens: 7,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});
});

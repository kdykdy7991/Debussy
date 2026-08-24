import { describe, expect, test } from "vitest";
import { buildTurnMetrics, startTurnTiming, type TurnTimingBase } from "../../src/agent-v2/turn-metrics.ts";

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
});

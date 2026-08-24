import { describe, expect, test } from "vitest";
import {
	AGENT_V2_METRICS_ERROR_CODES,
	type ConversationTurnMetric,
	computeConversationMetricsStats,
	deriveTurnMetrics,
} from "../src/index.ts";

const BASE_TIMINGS = {
	inputTokens: 1200,
	outputTokens: 300,
	cacheReadTokens: 40,
	cacheWriteTokens: 10,
	requestStartedAt: 1_000_000,
	providerStartedAt: 1_000_050,
	firstOutputAt: null,
	completedAt: 1_000_900,
} as const;

function timings(overrides: Partial<Parameters<typeof deriveTurnMetrics>[0]> = {}) {
	return { ...BASE_TIMINGS, ...overrides };
}

function row(partial: Partial<ConversationTurnMetric> = {}): ConversationTurnMetric {
	return {
		turnId: "turn_1",
		sequence: 1,
		modelId: "qwen3.8",
		sessionEffort: null,
		metrics: deriveTurnMetrics(timings()),
		...partial,
	};
}

describe("deriveTurnMetrics (V2 §4.1 null semantics)", () => {
	test("computes latency fields from timestamps", () => {
		const m = deriveTurnMetrics(timings({ firstOutputAt: 1_000_200 }));
		expect(m.ttftMs).toBe(150); // firstOutput - providerStarted
		expect(m.generationMs).toBe(700); // completed - firstOutput
		expect(m.totalLatencyMs).toBe(900); // completed - requestStarted
		expect(m.outputTokensPerSecond).toBeCloseTo((300 / 700) * 1000, 5);
		expect(m.firstOutputAt).toBe(new Date(1_000_200).toISOString());
	});

	test("first output before provider start is ignored (not a valid token point)", () => {
		const m = deriveTurnMetrics(timings({ firstOutputAt: 1_000_000 }));
		expect(m.ttftMs).toBeNull();
		expect(m.generationMs).toBeNull();
		expect(m.outputTokensPerSecond).toBeNull();
	});

	test("no displayable output yields null derived fields, never 0", () => {
		const m = deriveTurnMetrics(timings({ firstOutputAt: null, outputTokens: 0 }));
		expect(m.ttftMs).toBeNull();
		expect(m.generationMs).toBeNull();
		expect(m.outputTokensPerSecond).toBeNull();
		// totalLatencyMs remains computable.
		expect(m.totalLatencyMs).toBe(900);
	});

	test("zero output tokens but present first output -> tokens/s is null", () => {
		const m = deriveTurnMetrics(timings({ firstOutputAt: 1_000_200, outputTokens: 0 }));
		expect(m.generationMs).toBe(700);
		expect(m.outputTokensPerSecond).toBeNull();
	});

	test("zero generationMs -> tokens/s null (no division by zero)", () => {
		const m = deriveTurnMetrics(
			timings({ firstOutputAt: 1_000_900, providerStartedAt: 1_000_800, completedAt: 1_000_900 }),
		);
		expect(m.outputTokensPerSecond).toBeNull();
	});
});

describe("computeConversationMetricsStats (V2 §4.1 mean only over valued rows)", () => {
	test("empty items -> unavailable and empty field semantics", () => {
		const s = computeConversationMetricsStats([]);
		expect(s.available).toBe(false);
		expect(s.turnCount).toBe(0);
		expect(s.sampleCount).toBe(0);
		expect(s.ttftMs.mean).toBeNull();
		expect(s.ttftMs.count).toBe(0);
		expect(s.ttftMs.p50).toBeNull();
	});

	test("nulls are excluded per field, not coerced to 0", () => {
		const withValue = deriveTurnMetrics(timings({ firstOutputAt: 1_000_200, outputTokens: 100 }));
		const withoutValue = deriveTurnMetrics(timings({ firstOutputAt: null, outputTokens: 0 }));
		const s = computeConversationMetricsStats([row({ metrics: withValue }), row({ metrics: withoutValue })]);
		expect(s.turnCount).toBe(2);
		expect(s.ttftMs.count).toBe(1);
		expect(s.ttftMs.mean).toBe(withValue.ttftMs);
		// tokens/s also only counts the valued row.
		expect(s.outputTokensPerSecond.count).toBe(1);
		// totalLatencyMs is always present, so both rows count here.
		expect(s.totalLatencyMs.count).toBe(2);
	});

	test("p50/p95 use nearest rank on valued samples", () => {
		const mk = (ttft: number) =>
			deriveTurnMetrics(
				timings({ providerStartedAt: 0, requestStartedAt: 0, firstOutputAt: ttft, completedAt: 1000 }),
			);
		const s = computeConversationMetricsStats(
			[100, 200, 300, 400, 500].map((sequential_ttft, i) => row({ sequence: i + 1, metrics: mk(sequential_ttft) })),
		);
		expect(s.ttftMs.count).toBe(5);
		expect(s.ttftMs.p50).toBe(300); // ceil(0.5*5)=3 -> index 2
		expect(s.ttftMs.p95).toBe(500); // ceil(0.95*5)=5 -> index 4
	});
});

describe("AGENT_V2_METRICS_ERROR_CODES", () => {
	test("freezes the metrics/context error code catalogue", () => {
		expect(AGENT_V2_METRICS_ERROR_CODES).toEqual([
			"METRICS_UNAVAILABLE",
			"CONTEXT_SNAPSHOT_UNAVAILABLE",
			"INVALID_METRICS_FILTER",
		]);
	});
});

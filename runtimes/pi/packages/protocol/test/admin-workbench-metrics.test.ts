import { describe, expect, test } from "vitest";
import {
	AGENT_V2_METRICS_ERROR_CODES,
	AGENT_V2_METRICS_ERRORS,
	type ConversationTurnMetric,
	computeConversationMetricsStats,
	deriveTurnMetrics,
	type TurnMetricsDerivationInput,
	turnOutcomeFromTerminalEvent,
} from "../src/index.ts";

function baseDerivation(overrides: Partial<TurnMetricsDerivationInput> = {}): TurnMetricsDerivationInput {
	return {
		outcome: "success",
		inputTokens: 1200,
		outputTokens: 300,
		cacheReadTokens: 40,
		cacheWriteTokens: 10,
		stamps: {
			requestStartedAt: "2026-08-24T09:30:01.000Z",
			providerStartedAt: "2026-08-24T09:30:01.350Z",
			firstOutputAt: "2026-08-24T09:30:01.650Z",
			completedAt: "2026-08-24T09:30:04.000Z",
		},
		monotonic: {
			providerStartDelayMs: 350,
			firstOutputDelayMs: 650,
			totalElapsedMs: 3000,
		},
		...overrides,
	};
}

function stamp0(): TurnMetricsDerivationInput["stamps"] {
	return {
		requestStartedAt: "2026-08-24T09:30:01.000Z",
		providerStartedAt: "2026-08-24T09:30:01.350Z",
		firstOutputAt: "2026-08-24T09:30:01.650Z",
		completedAt: "2026-08-24T09:30:04.000Z",
	};
}

function monotonic(overrides: Partial<TurnMetricsDerivationInput["monotonic"]> = {}) {
	return { providerStartDelayMs: 350, firstOutputDelayMs: 650, totalElapsedMs: 3000, ...overrides };
}

function row(partial: Partial<ConversationTurnMetric> = {}): ConversationTurnMetric {
	return {
		turnId: "turn_1",
		sequence: 1,
		modelId: "qwen3.8",
		sessionEffort: null,
		metrics: deriveTurnMetrics(baseDerivation()),
		...partial,
	};
}

describe("deriveTurnMetrics (V2 §4.1 null semantics, monotonic-based)", () => {
	test("computes latency fields from monotonic delays", () => {
		const m = deriveTurnMetrics(
			baseDerivation({ monotonic: monotonic({ firstOutputDelayMs: 500, totalElapsedMs: 1200 }) }),
		);
		expect(m.ttftMs).toBe(150); // first - provider
		expect(m.generationMs).toBe(700); // total - first
		expect(m.totalLatencyMs).toBe(1200); // total elapsed
		expect(m.outputTokensPerSecond).toBeCloseTo((300 / 700) * 1000, 5);
		expect(m.outcome).toBe("success");
	});

	test("failed/cancelled rounds never yield derived timing values", () => {
		for (const outcome of ["failed", "cancelled"] as const) {
			const m = deriveTurnMetrics(baseDerivation({ outcome }));
			expect(m.ttftMs).toBeNull();
			expect(m.generationMs).toBeNull();
			expect(m.outputTokensPerSecond).toBeNull();
			// totalElapsedMs is measured but is not part of a success mean.
			expect(m.totalLatencyMs).toBe(3000);
		}
	});

	test("success without displayable output yields null derived fields, never 0", () => {
		const m = deriveTurnMetrics(baseDerivation({ monotonic: monotonic({ firstOutputDelayMs: null }) }));
		expect(m.ttftMs).toBeNull();
		expect(m.generationMs).toBeNull();
		expect(m.outputTokensPerSecond).toBeNull();
	});

	test("first output that predates provider start is ignored", () => {
		const m = deriveTurnMetrics(
			baseDerivation({ monotonic: monotonic({ providerStartDelayMs: 600, firstOutputDelayMs: 500 }) }),
		);
		expect(m.ttftMs).toBeNull();
		expect(m.generationMs).toBeNull();
	});

	test("zero output tokens but present first output -> tokens/s null", () => {
		const m = deriveTurnMetrics(baseDerivation({ outputTokens: 0 }));
		expect(m.generationMs).toBe(3000 - 650);
		expect(m.outputTokensPerSecond).toBeNull();
	});

	test("zero generationMs (zero guards) -> tokens/s null", () => {
		const m = deriveTurnMetrics(
			baseDerivation({ monotonic: monotonic({ firstOutputDelayMs: 3000, totalElapsedMs: 3000 }) }),
		);
		expect(m.generationMs).toBe(0);
		expect(m.outputTokensPerSecond).toBeNull();
	});
});

describe("computeConversationMetricsStats (V2 §4.1 success-valued rows only)", () => {
	test("empty items -> unavailable and empty field semantics", () => {
		const s = computeConversationMetricsStats([]);
		expect(s.available).toBe(false);
		expect(s.turnCount).toBe(0);
		expect(s.sampleCount).toBe(0);
		expect(s.ttftMs.mean).toBeNull();
		expect(s.ttftMs.count).toBe(0);
		expect(s.ttftMs.p50).toBeNull();
	});

	test("sampleCount counts success rounds, not all rows", () => {
		const s = computeConversationMetricsStats([
			row({ metrics: deriveTurnMetrics(baseDerivation()) }),
			row({ metrics: deriveTurnMetrics(baseDerivation({ outcome: "cancelled" })) }),
			row({ metrics: deriveTurnMetrics(baseDerivation({ outcome: "failed" })) }),
		]);
		expect(s.turnCount).toBe(3);
		expect(s.sampleCount).toBe(1);
	});

	test("failed/cancelled rows are excluded from every field mean, including totalLatencyMs", () => {
		const ok = deriveTurnMetrics(baseDerivation({ monotonic: monotonic({ totalElapsedMs: 2000 }) }));
		const cancelled = deriveTurnMetrics(
			baseDerivation({ outcome: "cancelled", monotonic: monotonic({ totalElapsedMs: 40 }) }),
		);
		const s = computeConversationMetricsStats([row({ metrics: ok }), row({ metrics: cancelled })]);
		expect(s.totalLatencyMs.count).toBe(1);
		expect(s.totalLatencyMs.mean).toBe(2000);
		expect(s.turnCount).toBe(2);
	});

	test("null-valued derived fields are not coerced to 0", () => {
		const withOutput = deriveTurnMetrics(baseDerivation());
		const noOutput = deriveTurnMetrics(baseDerivation({ monotonic: monotonic({ firstOutputDelayMs: null }) }));
		const s = computeConversationMetricsStats([row({ metrics: withOutput }), row({ metrics: noOutput })]);
		expect(s.sampleCount).toBe(2); // both success
		expect(s.ttftMs.count).toBe(1);
		expect(s.outputTokensPerSecond.count).toBe(1);
	});

	test("p50/p95 use nearest rank on valued success samples", () => {
		const mk = (ttft: number) =>
			deriveTurnMetrics(
				baseDerivation({
					stamps: stamp0(),
					monotonic: monotonic({ providerStartDelayMs: 0, firstOutputDelayMs: ttft, totalElapsedMs: 1000 }),
				}),
			);
		const s = computeConversationMetricsStats(
			[100, 200, 300, 400, 500].map((sequential_ttft, i) => row({ sequence: i + 1, metrics: mk(sequential_ttft) })),
		);
		expect(s.ttftMs.count).toBe(5);
		expect(s.ttftMs.p50).toBe(300); // ceil(0.5*5)=3 -> index 2
		expect(s.ttftMs.p95).toBe(500); // ceil(0.95*5)=5 -> index 4
	});
});

describe("turnOutcomeFromTerminalEvent (legacy read boundary)", () => {
	for (const [eventType, expected] of [
		["turn/end", "success"],
		["turn/interrupted", "cancelled"],
		["turn/failed", "failed"],
		["turn.end", "success"],
		["turn.interrupted", "cancelled"],
		["turn.failed", "failed"],
	] as const) {
		test(`maps ${eventType} -> ${expected}`, () => {
			expect(turnOutcomeFromTerminalEvent(eventType)).toBe(expected);
		});
	}
	test("non-terminal events map to null", () => {
		expect(turnOutcomeFromTerminalEvent("turn/start")).toBeNull();
		expect(turnOutcomeFromTerminalEvent("user/message")).toBeNull();
	});
});

describe("AGENT_V2_METRICS_ERROR_CODES and mapping", () => {
	test("freezes the metrics/context error catalogue", () => {
		expect(AGENT_V2_METRICS_ERROR_CODES).toEqual([
			"METRICS_UNAVAILABLE",
			"CONTEXT_SNAPSHOT_UNAVAILABLE",
			"INVALID_METRICS_FILTER",
		]);
	});
	test("binds stable http status and retryability", () => {
		expect(AGENT_V2_METRICS_ERRORS.METRICS_UNAVAILABLE).toEqual({ httpStatus: 503, retryable: true });
		expect(AGENT_V2_METRICS_ERRORS.CONTEXT_SNAPSHOT_UNAVAILABLE).toEqual({ httpStatus: 503, retryable: true });
		expect(AGENT_V2_METRICS_ERRORS.INVALID_METRICS_FILTER).toEqual({ httpStatus: 422, retryable: false });
	});
});

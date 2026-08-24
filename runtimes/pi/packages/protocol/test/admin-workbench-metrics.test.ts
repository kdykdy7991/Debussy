import { describe, expect, test } from "vitest";
import {
	AGENT_V2_METRICS_ERROR_CODES,
	AGENT_V2_METRICS_ERRORS,
	AGENT_V2_REASONING_AUDIT_ACTION,
	AGENT_V2_REASONING_ERROR_CODES,
	AGENT_V2_REASONING_ERRORS,
	CONVERSATION_METRICS_DEFAULT_LIMIT,
	CONVERSATION_METRICS_MAX_LIMIT,
	type ConversationTurnMetric,
	computeConversationMetricsStats,
	deriveTurnMetrics,
	resolveMetricsPage,
	type TurnMetricsDerivationInput,
	turnOutcomeFromTerminalEvent,
	validateTurnMonotonicOrder,
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

	test("first output that predates provider start is rejected, not ignored", () => {
		expect(() =>
			deriveTurnMetrics(
				baseDerivation({ monotonic: monotonic({ providerStartDelayMs: 600, firstOutputDelayMs: 500 }) }),
			),
		).toThrow(RangeError);
	});

	test("monotonic out-of-order input throws RangeError (no silent negative values)", () => {
		expect(() =>
			deriveTurnMetrics(
				baseDerivation({ monotonic: monotonic({ firstOutputDelayMs: 4000, totalElapsedMs: 3000 }) }),
			),
		).toThrow(RangeError);
		expect(() =>
			deriveTurnMetrics(
				baseDerivation({ monotonic: monotonic({ providerStartDelayMs: 500, totalElapsedMs: 300 }) }),
			),
		).toThrow(RangeError);
	});

	test("validateTurnMonotonicOrder flags each ordering violation", () => {
		expect(validateTurnMonotonicOrder(monotonic())).toEqual([]);
		expect(validateTurnMonotonicOrder(monotonic({ firstOutputDelayMs: 4000, totalElapsedMs: 3000 }))).toHaveLength(1);
		// providerStart > totalElapsed, and firstOutput (650) also exceeds totalElapsed -> 2 errors.
		expect(validateTurnMonotonicOrder(monotonic({ providerStartDelayMs: 500, totalElapsedMs: 300 }))).toHaveLength(2);
		expect(validateTurnMonotonicOrder(monotonic({ providerStartDelayMs: -1 }))).not.toEqual([]);
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
			baseDerivation({
				outcome: "cancelled",
				monotonic: monotonic({ providerStartDelayMs: 10, firstOutputDelayMs: null, totalElapsedMs: 40 }),
			}),
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

describe("resolveMetricsPage (frozen pagination boundary)", () => {
	test("defaults: no args -> DEFAULT_LIMIT, afterSequential 0", () => {
		expect(CONVERSATION_METRICS_DEFAULT_LIMIT).toBe(50);
		expect(CONVERSATION_METRICS_MAX_LIMIT).toBe(200);
		const r = resolveMetricsPage({});
		expect(r).toEqual({ ok: true, afterSequence: 0, limit: 50 });
	});

	test("applies afterSequence and preserves in-bound limit", () => {
		expect(resolveMetricsPage({ afterSequence: 35, limit: 20 })).toEqual({
			ok: true,
			afterSequence: 35,
			limit: 20,
		});
	});

	test("clamps limit above MAX_LIMIT, never above 200", () => {
		expect(resolveMetricsPage({ limit: 500 })).toEqual({ ok: true, afterSequence: 0, limit: 200 });
	});

	test("rejects non-positive afterSequence and non-positive/non-integer limit", () => {
		expect(resolveMetricsPage({ afterSequence: 0 }).ok).toBe(false);
		expect(resolveMetricsPage({ afterSequence: -3 }).ok).toBe(false);
		expect(resolveMetricsPage({ afterSequence: 2.5 }).ok).toBe(false);
		expect(resolveMetricsPage({ limit: 0 }).ok).toBe(false);
		expect(resolveMetricsPage({ limit: -1 }).ok).toBe(false);
		expect(resolveMetricsPage({ limit: 10.5 }).ok).toBe(false);
	});

	test("returns the frozen INVALID_METRICS_FILTER code on violation", () => {
		const r = resolveMetricsPage({ afterSequence: 0 });
		expect(r).toEqual({ ok: false, error: "INVALID_METRICS_FILTER", message: expect.any(String) });
	});
});

describe("Agent V2 reasoning update contract", () => {
	test("freezes reasoning error catalogue and HTTP mapping", () => {
		expect(AGENT_V2_REASONING_ERROR_CODES).toEqual(["REASONING_INVALID_EFFORT", "REASONING_NOT_CONFIGURABLE"]);
		expect(AGENT_V2_REASONING_ERRORS.REASONING_INVALID_EFFORT).toEqual({ httpStatus: 422, retryable: false });
		expect(AGENT_V2_REASONING_ERRORS.REASONING_NOT_CONFIGURABLE).toEqual({ httpStatus: 403, retryable: false });
	});

	test("freezes the update audit action id", () => {
		expect(AGENT_V2_REASONING_AUDIT_ACTION).toBe("conversation.reasoning-updated");
	});
});

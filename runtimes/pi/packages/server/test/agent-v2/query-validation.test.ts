import { describe, expect, test } from "vitest";
import { readStoredContextSnapshot, readStoredTurnMetrics } from "../../src/agent-v2/query.ts";
import { buildTurnMetrics } from "../../src/agent-v2/turn-metrics.ts";

function validSuccess() {
	return buildTurnMetrics({
		outcome: "success",
		base: { monotonicStartMs: 1000, epochStartMs: 1_700_000_000_000 },
		events: { providerStartAtMs: 1150, firstOutputAtMs: 1600, completedAtMs: 4200 },
		usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50 },
	});
}

function validFailed() {
	return buildTurnMetrics({
		outcome: "failed",
		base: { monotonicStartMs: 1000, epochStartMs: 1_700_000_000_000 },
		events: { providerStartAtMs: 1000, firstOutputAtMs: null, completedAtMs: 1400 },
		usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
	});
}

describe("readStoredTurnMetrics (strict persisted-payload validation)", () => {
	test("accepts well-formed success metrics", () => {
		expect(readStoredTurnMetrics({ metrics: validSuccess() })).toMatchObject({ outcome: "success" });
	});

	test("accepts failed metrics with null ttft/generation/tps", () => {
		const m = readStoredTurnMetrics({ metrics: validFailed() });
		expect(m?.outcome).toBe("failed");
		expect(m?.ttftMs).toBeNull();
		expect(m?.generationMs).toBeNull();
		expect(m?.outputTokensPerSecond).toBeNull();
	});

	test("rejects non-success metrics that still carry a ttft value", () => {
		const m = { ...validFailed(), ttftMs: 5 };
		expect(readStoredTurnMetrics({ metrics: m })).toBeUndefined();
	});

	test("rejects NaN/non-number total latency", () => {
		const m = { ...validSuccess(), totalLatencyMs: Number.NaN };
		expect(readStoredTurnMetrics({ metrics: m })).toBeUndefined();
	});

	test("rejects missing usage counter / stamps", () => {
		const { inputTokens: _drop, ...missing } = validSuccess();
		expect(readStoredTurnMetrics({ metrics: missing })).toBeUndefined();
		const { stamps: _dropStamps, ...noStamps } = validSuccess();
		expect(readStoredTurnMetrics({ metrics: noStamps })).toBeUndefined();
	});

	test("rejects non-integer or negative usage", () => {
		expect(readStoredTurnMetrics({ metrics: { ...validSuccess(), outputTokens: 1.5 } })).toBeUndefined();
		expect(readStoredTurnMetrics({ metrics: { ...validSuccess(), inputTokens: -1 } })).toBeUndefined();
	});

	test("rejects negative derived latency", () => {
		expect(readStoredTurnMetrics({ metrics: { ...validSuccess(), totalLatencyMs: -3 } })).toBeUndefined();
		expect(readStoredTurnMetrics({ metrics: { ...validSuccess(), ttftMs: -1 } })).toBeUndefined();
	});

	test("rejects out-of-order or non-ISO stamps", () => {
		const base = validSuccess();
		expect(
			readStoredTurnMetrics({
				metrics: { ...base, stamps: { ...base.stamps, requestStartedAt: base.stamps.completedAt } },
			}),
		).toBeUndefined();
		expect(
			readStoredTurnMetrics({ metrics: { ...base, stamps: { ...base.stamps, completedAt: "not-a-date" } } }),
		).toBeUndefined();
	});

	test("rejects a first output recorded on a non-success outcome", () => {
		expect(readStoredTurnMetrics({ metrics: { ...validSuccess(), outcome: "failed" } })).toBeUndefined();
		expect(readStoredTurnMetrics({ metrics: { ...validSuccess(), outcome: "cancelled" } })).toBeUndefined();
	});
});

describe("readStoredContextSnapshot (strict persisted-snapshot validation)", () => {
	const snapshot = {
		usedTokens: 35,
		contextWindow: 400,
		remainingTokens: 365,
		reservedOutputTokens: 0,
		usagePercent: 8.75,
		measurement: "estimated",
		breakdown: {
			systemPrompt: 10,
			skillInstructions: 0,
			toolDefinitions: 5,
			conversationMessages: 20,
			toolResults: 0,
			retrievalContext: 0,
			attachments: 0,
		},
	};

	test("accepts a well-formed snapshot", () => {
		expect(readStoredContextSnapshot({ snapshot })).toMatchObject({ usedTokens: 35 });
	});

	test("rejects a snapshot missing the breakdown or numeric fields", () => {
		expect(readStoredContextSnapshot({ snapshot: { ...snapshot, breakdown: undefined } })).toBeUndefined();
		expect(readStoredContextSnapshot({ snapshot: { ...snapshot, usedTokens: "x" } })).toBeUndefined();
		expect(readStoredContextSnapshot({ snapshot: { ...snapshot, measurement: "exactish" } })).toBeUndefined();
	});

	test("rejects derivatively inconsistent snapshots", () => {
		// remainingTokens 与 contextWindow - used - reserved 不一致。
		expect(readStoredContextSnapshot({ snapshot: { ...snapshot, remainingTokens: 999 } })).toBeUndefined();
		// usagePercent 与 used/context 不一致。
		expect(readStoredContextSnapshot({ snapshot: { ...snapshot, usagePercent: 1 } })).toBeUndefined();
		// sum(breakdown) 与 usedTokens 不一致。
		const badBreakdown = { ...snapshot, breakdown: { ...snapshot.breakdown, systemPrompt: 99 } };
		expect(readStoredContextSnapshot({ snapshot: badBreakdown })).toBeUndefined();
		// 负值分类。
		const negative = { ...snapshot, breakdown: { ...snapshot.breakdown, conversationMessages: -1 } };
		expect(readStoredContextSnapshot({ snapshot: negative })).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import type { AdminUsageRunRow } from "../src/admin-workbench-usage.ts";
import { buildUsageViewStats, UNKNOWN_MODEL_LABEL, usageDayRange } from "../src/usage-view.ts";

const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-08-08T00:00:00.000Z";

function run(overrides: Partial<AdminUsageRunRow> = {}): AdminUsageRunRow {
	return {
		id: "run-1",
		groupId: "integration-1",
		groupName: "工单研判接入",
		state: "succeeded",
		createdAt: "2026-08-02T10:00:00.000Z",
		model: "Qwen3.8",
		versionId: null,
		tokenCoverage: "complete",
		accurateTokens: 17_470,
		partialTokens: 0,
		accurateLlmCallCount: 3,
		durationMs: 38_600,
		conversationId: "conv-1",
		cacheHitTokens: null,
		cacheMissTokens: null,
		cachePromptTokens: null,
		cacheHitRate: null,
		...overrides,
	};
}

describe("usage view aggregation", () => {
	it("counts only complete provider usage and keeps legacy partial tokens separate", () => {
		const stats = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [
				run(),
				run({
					id: "run-2",
					tokenCoverage: "partial",
					accurateTokens: null,
					accurateLlmCallCount: null,
					partialTokens: 500,
				}),
				run({
					id: "run-3",
					tokenCoverage: "none",
					accurateTokens: null,
					accurateLlmCallCount: null,
					partialTokens: 0,
					model: null,
					durationMs: null,
				}),
			],
		});
		expect(stats.coverage).toEqual({
			runCount: 3,
			completeCount: 1,
			partialCount: 1,
			noUsageCount: 1,
			accurateTokens: 17_470,
			partialTokens: 500,
			llmCallCount: 3,
			cacheReportedRuns: 0,
			cacheUnknownRuns: 1,
			cacheReportedCalls: 0,
			cacheUnknownCalls: 0,
			cacheHitTokens: 0,
			cachePromptTokens: 0,
			cacheMissTokens: 0,
			cacheHitRate: null,
		});
		expect(stats.byGroup[0]).toMatchObject({
			runCount: 3,
			completeCount: 1,
			accurateTokens: 17_470,
			llmCallCount: 3,
			partialTokens: 500,
			avgDurationMs: 38_600,
			maxDurationMs: 38_600,
		});
		expect(stats.byModel.map((row) => row.label).sort()).toEqual(["Qwen3.8", UNKNOWN_MODEL_LABEL]);
	});

	it("buckets tokens by UTC day and keeps zero-value days", () => {
		const stats = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [run(), run({ id: "run-2", createdAt: "2026-08-05T23:59:00.000Z" })],
		});
		expect(stats.byDay).toHaveLength(7);
		expect(stats.byDay[0]).toEqual({
			date: "2026-08-01",
			runCount: 0,
			accurateTokens: 0,
			partialTokens: 0,
			cacheHitTokens: 0,
			cachePromptTokens: 0,
			cacheHitRate: null,
			cacheReportedRuns: 0,
			cacheUnknownRuns: 0,
			cacheReportedCalls: 0,
			cacheUnknownCalls: 0,
		});
		expect(stats.byDay[1]).toMatchObject({ date: "2026-08-02", runCount: 1, accurateTokens: 17_470 });
		expect(stats.byDay[4]).toMatchObject({ date: "2026-08-05", runCount: 1 });
	});

	it("does not add an empty day when `to` is a whole UTC midnight", () => {
		expect(usageDayRange(FROM, TO)).toEqual([
			"2026-08-01",
			"2026-08-02",
			"2026-08-03",
			"2026-08-04",
			"2026-08-05",
			"2026-08-06",
			"2026-08-07",
		]);
		expect(usageDayRange(FROM, "2026-08-08T13:00:00.000Z")).toContain("2026-08-08");
	});

	it("keeps orchestration and Chat calibers disjoint", () => {
		const orchestration = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [run({ groupId: "orchestration", groupName: "编排接入" })],
		});
		const chat = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [run({ id: "turn-1", groupId: "agent-1", groupName: "客服 Agent", accurateTokens: 42 })],
		});
		expect(orchestration.coverage.accurateTokens).toBe(17_470);
		expect(chat.coverage.accurateTokens).toBe(42);
		expect(orchestration.byGroup[0]?.key).not.toBe(chat.byGroup[0]?.key);
		expect(buildUsageViewStats({ from: FROM, to: TO, runs: [] }).coverage).toEqual({
			runCount: 0,
			completeCount: 0,
			partialCount: 0,
			noUsageCount: 0,
			accurateTokens: 0,
			partialTokens: 0,
			llmCallCount: 0,
			cacheReportedRuns: 0,
			cacheUnknownRuns: 0,
			cacheReportedCalls: 0,
			cacheUnknownCalls: 0,
			cacheHitTokens: 0,
			cachePromptTokens: 0,
			cacheMissTokens: 0,
			cacheHitRate: null,
		});
	});

	it("weights cache hit rate by prompt tokens and excludes unknown cache rows", () => {
		const stats = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [
				run({
					id: "cache-hit",
					accurateTokens: 1_400,
					cacheHitTokens: 300,
					cacheMissTokens: 100,
					cachePromptTokens: 400,
					cacheHitRate: 0.75,
				}),
				run({
					id: "cache-zero",
					accurateTokens: 200,
					cacheHitTokens: 0,
					cacheMissTokens: 100,
					cachePromptTokens: 100,
					cacheHitRate: 0,
				}),
				run({ id: "cache-unknown" }),
				run({
					id: "cache-partial",
					tokenCoverage: "partial",
					accurateTokens: null,
					accurateLlmCallCount: null,
					partialTokens: 10,
					cacheHitTokens: null,
					cacheMissTokens: null,
					cachePromptTokens: null,
					cacheHitRate: null,
				}),
			],
		});
		expect(stats.coverage).toMatchObject({
			cacheReportedRuns: 2,
			cacheUnknownRuns: 1,
			cacheHitTokens: 300,
			cachePromptTokens: 500,
			cacheMissTokens: 200,
			// Weighted 300/500, not the arithmetic mean of 0.75 and 0.
			cacheHitRate: 0.6,
		});
		expect(stats.byDay[1]).toMatchObject({
			cacheReportedRuns: 2,
			cacheUnknownRuns: 1,
			cacheHitTokens: 300,
			cachePromptTokens: 500,
			cacheHitRate: 0.6,
		});
		expect(stats.byGroup[0]).toMatchObject({
			cacheReportedRuns: 2,
			cacheUnknownRuns: 1,
			cacheHitRate: 0.6,
		});
	});

	it("reports cache coverage per call so a partially reporting row is not discarded", () => {
		const stats = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [
				// Two of three calls reported their cache read: the reported calls
				// still contribute their hits and prompt tokens.
				run({
					id: "cache-mixed",
					accurateTokens: 1310,
					accurateLlmCallCount: 3,
					cacheHitTokens: 400,
					cacheMissTokens: 350,
					cachePromptTokens: 750,
					cacheHitRate: 400 / 750,
					cacheReportedCalls: 2,
					cacheUnknownCalls: 1,
				}),
				// A row without a single reported call stays unknown.
				run({
					id: "cache-none-reported",
					accurateTokens: 800,
					accurateLlmCallCount: 1,
					cacheReportedCalls: 0,
					cacheUnknownCalls: 1,
				}),
			],
		});
		expect(stats.coverage).toMatchObject({
			cacheReportedRuns: 1,
			cacheUnknownRuns: 1,
			cacheReportedCalls: 2,
			cacheUnknownCalls: 2,
			cacheHitTokens: 400,
			cachePromptTokens: 750,
			cacheMissTokens: 350,
			cacheHitRate: 400 / 750,
		});
		expect(stats.byGroup[0]).toMatchObject({
			cacheReportedCalls: 2,
			cacheUnknownCalls: 2,
			cacheHitTokens: 400,
			cachePromptTokens: 750,
			cacheHitRate: 400 / 750,
		});
		expect(stats.byModel[0]).toMatchObject({
			cacheReportedCalls: 2,
			cacheUnknownCalls: 2,
		});
		expect(stats.byDay[1]).toMatchObject({
			date: "2026-08-02",
			cacheReportedCalls: 2,
			cacheUnknownCalls: 2,
			cacheHitTokens: 400,
			cachePromptTokens: 750,
			cacheHitRate: 400 / 750,
		});
	});

	it("keeps an explicit zero hit rate distinct from unknown cache data", () => {
		const known = buildUsageViewStats({
			from: FROM,
			to: TO,
			runs: [
				run({
					cacheHitTokens: 0,
					cacheMissTokens: 400,
					cachePromptTokens: 400,
					cacheHitRate: 0,
				}),
			],
		});
		expect(known.coverage.cacheHitRate).toBe(0);
		expect(known.coverage.cacheReportedRuns).toBe(1);
		const unknown = buildUsageViewStats({ from: FROM, to: TO, runs: [run()] });
		expect(unknown.coverage.cacheHitRate).toBeNull();
		expect(unknown.coverage.cacheUnknownRuns).toBe(1);
	});
});

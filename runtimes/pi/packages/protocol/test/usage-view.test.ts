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
		expect(stats.byDay[0]).toEqual({ date: "2026-08-01", runCount: 0, accurateTokens: 0, partialTokens: 0 });
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
		});
	});
});

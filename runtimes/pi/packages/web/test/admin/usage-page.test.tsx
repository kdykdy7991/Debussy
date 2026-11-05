import type { AdminUsageRunRow, AdminUsageViewStats } from "@earendil-works/pi-protocol";
import { buildUsageViewStats } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAuthProvider } from "../../src/admin/auth/admin-auth-context.tsx";
import {
	EMPTY_FILTERS,
	filterUsageRuns,
	formatCompact,
	formatCoveragePercent,
	formatDuration,
	formatRunTime,
	sortUsageRuns,
	usageCsv,
} from "../../src/admin/pages/usage-format.ts";
import { AdminUsagePage } from "../../src/admin/pages/usage-page.tsx";
import {
	type OptionalColumn,
	UsageGroupTable,
	UsageMetrics,
	UsageRunsTable,
	UsageTabs,
	UsageTrend,
} from "../../src/admin/pages/usage-view.tsx";

const PERIOD = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" };

function run(overrides: Partial<AdminUsageRunRow> = {}): AdminUsageRunRow {
	return {
		id: "run_9f2c7e4b-0000-4000-8000-000000000001",
		groupId: "integration-1",
		groupName: "工单研判接入",
		state: "succeeded",
		createdAt: "2026-08-04T14:27:00.000Z",
		model: "Qwen3.8",
		versionId: null,
		tokenCoverage: "complete",
		accurateTokens: 17_470,
		partialTokens: 0,
		accurateLlmCallCount: 3,
		durationMs: 38_600,
		conversationId: "conv_00000000-0000-4000-8000-000000000001",
		...overrides,
	};
}

const RUNS: readonly AdminUsageRunRow[] = [
	run(),
	run({
		id: "run_c4a1d2e6",
		state: "cancelled",
		tokenCoverage: "partial",
		accurateTokens: null,
		accurateLlmCallCount: null,
		partialTokens: 500,
		durationMs: 62_000,
	}),
	run({
		id: "run_7a0b3f19",
		tokenCoverage: "none",
		accurateTokens: null,
		accurateLlmCallCount: null,
		partialTokens: 0,
		model: null,
		durationMs: null,
	}),
];

function stats(): AdminUsageViewStats {
	return buildUsageViewStats({ runs: RUNS, ...PERIOD });
}

describe("usage formatting and filtering", () => {
	it("formats metric values, execution elapsed and coverage", () => {
		expect(formatCompact(895_000_000)).toBe("895M");
		expect(formatCompact(12_860)).toBe("12,860");
		expect(formatDuration(38_600)).toBe("38.6 s");
		expect(formatDuration(62_000)).toBe("1 min 02 s");
		expect(formatDuration(null)).toBe("—");
		expect(formatCoveragePercent(5356, 5463)).toBe("98.0%");
		expect(formatCoveragePercent(0, 0)).toBe("—");
		expect(formatRunTime("2026-08-04T14:27:00.000Z")).toBe("08-04 14:27");
	});

	it("filters real rows by group, model, state and query", () => {
		expect(filterUsageRuns(RUNS, EMPTY_FILTERS)).toHaveLength(3);
		expect(filterUsageRuns(RUNS, { ...EMPTY_FILTERS, state: "cancelled" }).map((r) => r.id)).toEqual([
			"run_c4a1d2e6",
		]);
		expect(filterUsageRuns(RUNS, { ...EMPTY_FILTERS, model: "Qwen3.8" })).toHaveLength(2);
		expect(filterUsageRuns(RUNS, { ...EMPTY_FILTERS, model: "未记录模型" }).map((r) => r.id)).toEqual([
			"run_7a0b3f19",
		]);
		expect(filterUsageRuns(RUNS, { ...EMPTY_FILTERS, query: "c4a1" })).toHaveLength(1);
		expect(filterUsageRuns(RUNS, { ...EMPTY_FILTERS, group: "missing" })).toHaveLength(0);
	});

	it("keeps rows without accurate values at the bottom of both sort directions", () => {
		for (const direction of ["asc", "desc"] as const) {
			const sorted = sortUsageRuns(RUNS, { key: "accurateTokens", direction });
			expect(sorted.at(-2)?.accurateTokens).toBeNull();
			expect(sorted.at(-1)?.accurateTokens).toBeNull();
		}
		expect(sortUsageRuns(RUNS, { key: "accurateTokens", direction: "asc" })[0]?.accurateTokens).toBe(17_470);
	});

	it("exports real rows to CSV with empty cells for missing accurate values", () => {
		const view = stats();
		const csv = usageCsv("runs", view, RUNS);
		expect(csv.startsWith("\uFEFF")).toBe(true);
		expect(csv).toContain('"准确 Token"');
		expect(csv).toContain('"17470"');
		expect(csv).toContain('"500"');
		// Incomplete rows must be empty, never a fabricated zero.
		expect(csv).toContain('"历史不完整",""');
		expect(csv).not.toContain('"历史不完整","0"');
		const groups = usageCsv("groups", view, RUNS);
		expect(groups).toContain('"工单研判接入"');
		expect(groups).toContain('"3"');
	});
});

describe("usage page rendering", () => {
	it("renders the page shell with the two independent calibers and time ranges", () => {
		const html = renderToStaticMarkup(
			<AdminAuthProvider>
				<AdminUsagePage />
			</AdminAuthProvider>,
		);
		expect(html).toContain("用量统计");
		expect(html).toContain("Agent 编排");
		expect(html).toContain("Chat Agent");
		for (const label of ["最近 7 天", "最近 14 天", "最近 30 天", "最近 90 天"]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("全部接入");
		expect(html).toContain("全部模型");
		expect(html).toContain("全部状态");
		expect(html).toContain("刷新");
		expect(html).toContain("导出");
	});

	it("renders four compact metrics with the coverage badge and tooltips", () => {
		const coverage = stats().coverage;
		const html = renderToStaticMarkup(
			<UsageMetrics
				items={[
					{ id: "runs", label: "编排 Run 数", hint: "口径 A", value: "3", icon: "run" },
					{ id: "tokens", label: "准确 Token", hint: "口径 B", value: "17,470", icon: "token" },
					{ id: "calls", label: "LLM 调用次数", hint: "口径 C", value: "3", icon: "call" },
					{
						id: "complete",
						label: "完整记录 Run 数",
						hint: "口径 D",
						value: "1",
						badge: formatCoveragePercent(coverage.completeCount, coverage.runCount),
						icon: "check",
					},
				]}
			/>,
		);
		for (const label of ["编排 Run 数", "准确 Token", "LLM 调用次数", "完整记录 Run 数"]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("覆盖率 33.3%");
		expect(html).toContain("data-tip=");
	});

	it("renders a bar for every UTC day including zero-value days", () => {
		const html = renderToStaticMarkup(<UsageTrend days={stats().byDay} />);
		expect(html).toContain("Tokens · 趋势");
		expect(html.match(/role="img"/g) ?? []).toHaveLength(7);
		expect(html).toContain('data-empty="true"');
		expect(html).toContain("08/04");
	});

	it("shows an em dash instead of 0 for incomplete and missing usage", () => {
		const html = renderToStaticMarkup(
			<UsageRunsTable
				runs={RUNS}
				sort={{ key: "createdAt", direction: "desc" }}
				onSort={() => {}}
				visible={new Set<OptionalColumn>(["state", "model", "llm", "coverage"])}
				onOpenDetail={() => {}}
			/>,
		);
		expect(html).toContain("准确 Token");
		expect(html).toContain("历史部分 Token 500");
		expect(html).toContain("没有持久化的 provider usage");
		expect(html).toContain("—");
		expect(html).not.toContain(">0</span>");
		expect(html).toContain('aria-sort="descending"');
		expect(html).toContain("详情");
		expect(html).toContain("38.6 s");
		expect(html).toContain("1 min 02 s");
	});

	it("renders model aggregation and the three detail tabs", () => {
		const view = stats();
		const html = renderToStaticMarkup(<UsageGroupTable rows={view.byModel} label="模型" emptyText="无数据" />);
		expect(html).toContain("Qwen3.8");
		expect(html).toContain("历史部分 Token");
		const tabs = renderToStaticMarkup(<UsageTabs value="runs" onChange={() => {}} />);
		for (const label of ["运行记录", "按接入统计", "按模型统计"]) {
			expect(tabs).toContain(label);
		}
		expect(tabs).toContain('aria-selected="true"');
	});
});

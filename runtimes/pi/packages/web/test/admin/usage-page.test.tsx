import type { AdminUsageRunRow, AdminUsageSummary, AdminUsageViewStats } from "@earendil-works/pi-protocol";
import { buildUsageViewStats } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAuthProvider } from "../../src/admin/auth/admin-auth-context.tsx";
import { beijingBoundary, formatBeijing } from "../../src/admin/beijing-time.ts";
import {
	CACHE_UNKNOWN_TITLE,
	EMPTY_FILTERS,
	filterUsageRuns,
	formatCacheCoverage,
	formatCompact,
	formatCoveragePercent,
	formatDuration,
	formatPercent,
	formatRunTime,
	sortUsageRuns,
	usageCsv,
} from "../../src/admin/pages/usage-format.ts";
import {
	AdminUsagePage,
	buildBeijingUsageStats,
	DEFAULT_COLUMNS,
	executionUsageRows,
	metricItems,
} from "../../src/admin/pages/usage-page.tsx";
import {
	COLUMN_LABELS,
	OPTIONAL_COLUMNS,
	type OptionalColumn,
	UsageColumnsMenu,
	UsageGroupTable,
	UsageMetrics,
	UsageRunsTable,
	UsageTabs,
	UsageTrend,
} from "../../src/admin/pages/usage-view.tsx";

const PERIOD = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" };
const CACHE_HIT = 1600;
const CACHE_MISS = 2466;
const CACHE_PROMPT = CACHE_HIT + CACHE_MISS;

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
		cacheHitTokens: CACHE_HIT,
		cacheMissTokens: CACHE_MISS,
		cachePromptTokens: CACHE_PROMPT,
		cacheHitRate: CACHE_HIT / CACHE_PROMPT,
		// All three model calls of this record reported their cache read.
		cacheReportedCalls: 3,
		cacheUnknownCalls: 0,
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
		cacheHitTokens: null,
		cacheMissTokens: null,
		cachePromptTokens: null,
		cacheHitRate: null,
		durationMs: 62_000,
	}),
	run({
		id: "run_7a0b3f19",
		tokenCoverage: "none",
		accurateTokens: null,
		accurateLlmCallCount: null,
		partialTokens: 0,
		cacheHitTokens: null,
		cacheMissTokens: null,
		cachePromptTokens: null,
		cacheHitRate: null,
		model: null,
		durationMs: null,
	}),
];

/** One reported record with hits, one reported record with zero hits, one unreported record. */
const CACHE_RUNS: readonly AdminUsageRunRow[] = [
	run({ id: "run_cache_hit" }),
	run({
		id: "run_cache_zero",
		cacheHitTokens: 0,
		cacheMissTokens: 800,
		cachePromptTokens: 800,
		cacheHitRate: 0,
	}),
	run({
		id: "run_cache_unknown",
		cacheHitTokens: null,
		cacheMissTokens: null,
		cachePromptTokens: null,
		cacheHitRate: null,
		// None of its model calls reported cache fields: unknown, not a miss.
		cacheReportedCalls: 0,
		cacheUnknownCalls: 3,
	}),
];

function stats(runs: readonly AdminUsageRunRow[] = RUNS): AdminUsageViewStats {
	return buildUsageViewStats({ runs, ...PERIOD });
}

function csvLines(csv: string): string[] {
	return csv.replace(/^\uFEFF/, "").split("\r\n");
}

describe("usage formatting and filtering", () => {
	it("groups cross-midnight Usage in Beijing days without changing original timestamps", () => {
		const result = buildBeijingUsageStats({
			from: "2026-11-14T16:00:00.000Z",
			to: "2026-11-16T16:00:00.000Z",
			runs: [run({ createdAt: "2026-11-15T21:49:56.000Z" })],
		});
		expect(result.byDay.map((day) => [day.date, day.runCount])).toEqual([
			["2026-11-15", 0],
			["2026-11-16", 1],
		]);
		expect(result.runs[0]?.createdAt).toBe("2026-11-15T21:49:56.000Z");
	});
	it("formats metric values, execution elapsed and coverage", () => {
		expect(formatCompact(895_000_000)).toBe("895M");
		expect(formatCompact(12_860)).toBe("12,860");
		expect(formatDuration(38_600)).toBe("38.6 s");
		expect(formatDuration(62_000)).toBe("1 min 02 s");
		expect(formatDuration(null)).toBe("—");
		expect(formatCoveragePercent(5356, 5463)).toBe("98.0%");
		expect(formatCoveragePercent(0, 0)).toBe("—");
		expect(formatRunTime("2026-08-04T14:27:00.000Z")).toBe("08-04 22:27");
		expect(formatRunTime("2026-11-15T21:49:56.000Z")).toBe("11-16 05:49");
		expect(formatBeijing("2026-11-15T21:49:56.000Z")).toContain("2026/11/16 05:49:56");
		expect(beijingBoundary("2026-11-16")).toBe("2026-11-15T16:00:00.000Z");
		// Unknown cache data stays unknown, an explicit zero hit rate stays 0.0%.
		expect(formatPercent(null)).toBe("—");
		expect(formatPercent(0)).toBe("0.0%");
		expect(formatPercent(CACHE_HIT / CACHE_PROMPT)).toBe("39.4%");
		expect(formatCacheCoverage(1, 0)).toBe("100.0%");
		expect(formatCacheCoverage(1, 1)).toBe("50.0%");
		expect(formatCacheCoverage(0, 0)).toBe("—");
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
		expect(csv).toContain('"不完整",""');
		expect(csv).not.toContain('"不完整","0"');
		// Cache columns: reported row carries hit/miss/rate, unknown rows stay empty.
		expect(csv).toContain('"缓存命中 Token"');
		expect(csv).toContain('"非命中 Token"');
		expect(csv).toContain('"缓存命中率"');
		expect(csv).toContain('"17470","1600","2466","39.4%"');
		expect(csv).toContain('"不完整","","","","","500"');
		const groups = usageCsv("groups", view, RUNS);
		expect(groups).toContain('"工单研判接入"');
		// Group row: 准确 Token, 命中, 非命中, 命中率, 覆盖(按调用), 上报调用, 未知调用, 上报记录, 未知记录, 调用次数, 部分用量, 平均/最长耗时
		expect(groups).toContain('"17470","1600","2466","39.4%","100.0%","3","0","1","0","3","500","50300","62000"');
		const models = usageCsv("models", view, RUNS);
		expect(models).toContain('"缓存覆盖"');
		// A model group without a complete record has an unknown accurate total.
		expect(models).toContain('"未记录模型","1","0","0","1","","","","",""');
	});

	it("exports explicit zero cache hits as 0 and unknown cache data as empty", () => {
		const csv = usageCsv("runs", stats(CACHE_RUNS), CACHE_RUNS);
		const lines = csvLines(csv);
		const hitLine = lines.find((line) => line.includes('"run_cache_hit"'));
		expect(hitLine).toContain('"1600","2466","39.4%"');
		const zeroLine = lines.find((line) => line.includes('"run_cache_zero"'));
		expect(zeroLine).toContain('"0","800","0.0%"');
		const unknownLine = lines.find((line) => line.includes('"run_cache_unknown"'));
		expect(unknownLine).toContain('"完整","17470","","",""');
		expect(unknownLine).not.toContain('"0","0"');
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
		expect(html).toContain("Integration Run");
		expect(html).not.toContain(">旧 AaaS Run</span>");
		expect(html).toContain("Router");
		expect(html).toContain("Chat Agent");
		for (const label of ["最近 7 天", "最近 14 天", "最近 30 天", "最近 90 天"]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("全部归属");
		expect(html).toContain("全部模型");
		expect(html).toContain("全部状态");
		expect(html).toContain("刷新");
		expect(html).toContain("导出");
	});

	it("renders six compact metrics with cache values and the coverage badge", () => {
		const coverage = stats().coverage;
		const items = metricItems("integration", coverage);
		expect(items.map((item) => item.label)).toEqual([
			"Run数",
			"准确 Token",
			"已记录 LLM 调用次数",
			"完整记录Run数",
			"缓存命中 Token",
			"缓存命中率",
		]);
		expect(items[4]).toMatchObject({ value: "1,600", badge: "100.0%" });
		expect(items[5]).toMatchObject({ value: "39.4%", badge: "100.0%" });
		const html = renderToStaticMarkup(<UsageMetrics items={items} />);
		for (const label of [
			"Run数",
			"准确 Token",
			"已记录 LLM 调用次数",
			"完整记录Run数",
			"缓存命中 Token",
			"缓存命中率",
		]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("覆盖率 100.0%");
		expect(html).toContain("data-tip=");
	});

	it("combines one fact per source without adding legacy totals or Router Task totals", () => {
		const summary: AdminUsageSummary = {
			period: { ...PERIOD, timezone: "UTC" },
			totals: { totalTokens: 1000, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 4 },
			byAgent: [],
			bySource: [],
			generatedAt: PERIOD.to,
			chat: buildUsageViewStats({ ...PERIOD, runs: [run({ id: "chat", accurateTokens: 10 })] }),
			orchestration: {
				byIntegration: [],
				recentRuns: [],
				coverage: { completeRuns: 2, completeTokens: 50, partialRuns: 0, noUsageRuns: 0, partialTokens: 0, note: "" },
				view: buildUsageViewStats({ ...PERIOD, runs: [
					run({ id: "old-key", groupName: "aaas_key:Shared key", accurateTokens: 20 }),
					run({ id: "integration", accurateTokens: 30 }),
				] }),
			},
			router: buildUsageViewStats({ ...PERIOD, runs: [
				run({ id: "router-complete", source: "router", routerTaskId: "task-1", accurateTokens: 40 }),
				run({ id: "router-partial", source: "router", routerTaskId: "task-1", tokenCoverage: "partial", accurateTokens: null, partialTokens: 7 }),
			] }),
		};
		const rows = executionUsageRows(summary, "all") ?? [];
		expect(rows.map((row) => row.source)).toEqual(["chat", "aaas_key", "integration", "router", "router"]);
		expect(buildUsageViewStats({ ...PERIOD, runs: rows }).coverage)
			.toMatchObject({ runCount: 5, accurateTokens: 100, partialTokens: 7 });
		expect(executionUsageRows(summary, "aaas_key")?.map((row) => row.id)).toEqual(["old-key"]);
		expect(executionUsageRows(summary, "router")?.map((row) => row.id)).toEqual(["router-complete", "router-partial"]);
		expect(filterUsageRuns(rows, { ...EMPTY_FILTERS, query: "task-1" }).map((row) => row.id))
			.toEqual(["router-complete", "router-partial"]);
	});

	it("marks unknown cache coverage and hit rate as an em dash in metrics", () => {
		const empty = buildUsageViewStats({ runs: [], ...PERIOD }).coverage;
		const items = metricItems("chat", empty);
		expect(items[4]?.badge).toBe("—");
		expect(items[5]?.value).toBe("—");
		expect(items[5]?.badge).toBe("—");
		expect(items[4]?.hint).toContain("不当作 0");
		// Without a single complete record the accurate totals are unknown, not 0.
		expect(items[1]?.value).toBe("—");
		expect(items[2]?.value).toBe("—");
		expect(items[3]?.value).toBe("0");
	});

	it("keeps a real zero separate from an unknown accurate total", () => {
		// A complete record that really reported zero tokens stays "0".
		const zero = buildUsageViewStats({
			runs: [run({ id: "run_zero", accurateTokens: 0, accurateLlmCallCount: 1 })],
			...PERIOD,
		}).coverage;
		const items = metricItems("chat", zero);
		expect(items[1]?.value).toBe("0");
		expect(items[2]?.value).toBe("1");
	});

	it("stacks cache components within one total bar per day", () => {
		const [reported, unknown] = stats().byDay;
		const html = renderToStaticMarkup(<UsageTrend days={[
			{ ...reported!, accurateTokens: 100, cacheHitTokens: 25, cachePromptTokens: 70, cacheReportedRuns: 1 },
			{ ...unknown!, accurateTokens: 80, cacheHitTokens: 0, cachePromptTokens: 0, cacheReportedRuns: 0 },
			...stats().byDay.slice(2),
		]} />);
		expect(html).toContain("Tokens · 趋势");
		expect(html.match(/data-series="total"/g) ?? []).toHaveLength(7);
		expect(html).not.toContain('data-series="cache"');
		expect(html).toContain('data-segment="hit" style="flex-grow:25"');
		expect(html).toContain('data-segment="miss" style="flex-grow:45"');
		expect(html).toContain('data-segment="other" style="flex-grow:30"');
		expect(html).toContain('data-segment="other" style="flex-grow:80"');
		expect(html).toContain("总 Token 100");
		expect(html).toContain("总 Token 80，缓存命中 Token —，非命中 Token —");
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
		expect(html).toContain("部分用量 500");
		expect(html).toContain("没有持久化的 provider usage");
		expect(html).toContain("—");
		expect(html).not.toContain(">0</span>");
		expect(html).toContain('aria-sort="descending"');
		expect(html).toContain("详情");
		expect(html).toContain("38.6 s");
		expect(html).toContain("1 min 02 s");
	});

	it("shows cache hit / miss for known rows and an em dash for unknown rows", () => {
		const html = renderToStaticMarkup(
			<UsageRunsTable
				runs={CACHE_RUNS}
				sort={{ key: "createdAt", direction: "desc" }}
				onSort={() => {}}
				visible={new Set<OptionalColumn>(["cache"])}
				onOpenDetail={() => {}}
			/>,
		);
		expect(html).toContain("缓存命中");
		expect(html).toContain("1,600 / 2,466 (39.4%)");
		expect(html).toContain("0 / 800 (0.0%)");
		expect(html).toContain(CACHE_UNKNOWN_TITLE);
		// Unknown cache data is never rendered as an explicit 0 / 0 (0.0%) hit rate.
		expect(html).not.toContain("0 / 0 (0.0%)");
	});

	it("renders model aggregation with cache columns and the three detail tabs", () => {
		const view = stats();
		const html = renderToStaticMarkup(<UsageGroupTable rows={view.byModel} label="模型" emptyText="无数据" />);
		expect(html).toContain("Qwen3.8");
		expect(html).toContain("部分用量");
		expect(html).toContain("缓存命中 Token");
		expect(html).toContain("缓存命中率");
		expect(html).toContain("缓存覆盖");
		expect(html).toContain("1,600");
		expect(html).toContain("39.4%");
		expect(html).toContain("100.0%");
		expect(html).toContain("—");
		const tabs = renderToStaticMarkup(<UsageTabs value="runs" onChange={() => {}} />);
		for (const label of ["运行记录", "按接入统计", "按模型统计"]) {
			expect(tabs).toContain(label);
		}
		expect(tabs).toContain('aria-selected="true"');
	});

	it("exposes the cache column in the column menu and enables it by default", () => {
		expect(OPTIONAL_COLUMNS).toContain("cache");
		expect(COLUMN_LABELS.cache).toBe("缓存命中");
		expect(DEFAULT_COLUMNS).toContain("cache");
		const html = renderToStaticMarkup(
			<UsageColumnsMenu
				visible={new Set<OptionalColumn>(["cache"])}
				onToggle={() => {}}
				columns={OPTIONAL_COLUMNS}
			/>,
		);
		expect(html).toContain("缓存命中");
	});
});

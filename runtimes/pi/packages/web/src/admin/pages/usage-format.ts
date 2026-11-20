import {
	type AdminExecutionUsageSource,
	type AdminUsageDayRow,
	type AdminUsageGroupRow,
	type AdminUsageRunRow,
	type AdminUsageViewStats,
	UNKNOWN_MODEL_LABEL,
} from "@earendil-works/pi-protocol";
import { beijingDate, formatBeijing } from "../beijing-time.ts";

const INTEGER = new Intl.NumberFormat("zh-CN");

/**
 * 口径定义行：全局用量控制台与单会话 Usage 页共用同一套四个公式。
 * - Prompt Token = input + cacheRead + cacheWrite（provider prompt 规模，命中率的母）
 * - 缓存命中 Token = provider 上报的 cacheRead 之和（未上报缓存字段的调用既不计入分子也不计入分母）
 * - 非命中 Token = Prompt Token − 缓存命中 Token = input + cacheWrite（含 cacheWrite，不是纯 miss）
 * - Total Token 取 provider 上报值；OpenAI-Completions / Anthropic 由 runtime 计算
 */
export const USAGE_CALIBER_LINE =
	"Prompt Token = input + cacheRead + cacheWrite；缓存命中 Token = provider 上报的 cacheRead 之和（未上报缓存字段的调用不计入分子与分母）；非命中 Token = Prompt Token − 缓存命中 Token = input + cacheWrite；Total Token 取 provider 上报值（OpenAI-Completions / Anthropic 由 runtime 计算）。";

/**
 * Prompt Token 的定义（缓存命中率的母）。
 * cacheWrite 只在 provider 用受支持的字段上报时才计入；没有这类上报时缓存写入属未知（不等于 0），
 * Prompt Token 与非命中 Token 会继承这一限制。
 */
export const PROMPT_TOKEN_HINT =
	"Prompt Token = input + cacheRead + cacheWrite（provider prompt 规模），是缓存命中率的母；cacheWrite 仅在 provider 用受支持字段上报时计入，没有这类上报时属未知（不等于 0）。";

/** 缓存命中 Token 的定义：只累计 provider 明确上报的 cacheRead。 */
export const CACHE_HIT_HINT =
	"缓存命中 Token = provider 上报的 cacheRead 之和（按逐次 LLM 调用聚合）；未上报缓存字段的调用既不计入分子也不计入分母。";

/** 非命中 Token 的定义：Prompt Token 减去命中部分，因此包含 cacheWrite。 */
export const CACHE_MISS_HINT =
	"非命中 Token = Prompt Token − 缓存命中 Token = input + cacheWrite（含 cacheWrite，不是纯 miss）。";

/** Total Token 的来源随 provider 不同。 */
export const TOTAL_TOKEN_HINT =
	"Total Token：OpenAI-Responses / Google / Bedrock 取 provider 上报值；OpenAI-Completions 与 Anthropic 由 runtime 按 input + output + cacheRead + cacheWrite 计算。";

export function formatInteger(value: number): string {
	return INTEGER.format(value);
}

/** Source labels for the unified orchestration Usage view. */
export function usageSourceLabel(groupName: string): string {
	if (groupName.startsWith("aaas_key:")) return `AaaS Key · ${groupName.slice("aaas_key:".length)}`;
	return groupName;
}

export const usageExecutionSourceLabel: Record<AdminExecutionUsageSource, string> = {
	chat: "Chat Agent",
	aaas_key: "旧 AaaS Run",
	integration: "Integration Run",
	router: "Router",
};

/** Large metric values stay compact; counts below one million keep full precision. */
export function formatCompact(value: number): string {
	if (!Number.isFinite(value)) return "—";
	if (value < 1_000_000) return INTEGER.format(value);
	const units: readonly [number, string][] = [
		[1_000_000_000_000, "T"],
		[1_000_000_000, "B"],
		[1_000_000, "M"],
	];
	for (const [scale, suffix] of units) {
		if (value >= scale) {
			const scaled = value / scale;
			return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${suffix}`;
		}
	}
	return INTEGER.format(value);
}

/**
 * 时长格式化：`null`/缺才是未知（—）；真实的 0 是一次真实测量，渲染为 "0 ms"。
 * 调用方负责把「没有记录」转换成 `null`，不要用 0 代替缺失。
 */
export function formatDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

export function formatCoveragePercent(complete: number, total: number): string {
	return total === 0 ? "—" : `${((complete / total) * 100).toFixed(1)}%`;
}

/** Unknown cache data (`null`) renders as an em dash; an explicit 0 hit rate stays `0.0%`. */
export function formatPercent(rate: number | null): string {
	if (rate === null || !Number.isFinite(rate)) return "—";
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Cache coverage over the LLM calls that reported cache fields vs the calls that
 * did not; no denominator → em dash.
 *
 * Coverage is counted per CALL, not per record: one record may contain several
 * model calls and only some of them may report cache fields.
 */
export function formatCacheCoverage(reported: number, unknown: number): string {
	return formatCoveragePercent(reported, reported + unknown);
}

/** Shared explanation for records whose provider usage did not report cache fields. */
export const CACHE_UNKNOWN_TITLE = "该请求未上报缓存字段（历史或代理未透传），不计入命中率分母";

/**
 * 某一天的缓存命中 Token：当天没有任何记录上报缓存字段时，命中数是未知的，
 * 必须渲染成「—」，不能显示 0（与按接入/按模型分组表的口径一致）。
 */
export function formatDayCacheHitTokens(day: Pick<AdminUsageDayRow, "cacheHitTokens" | "cacheReportedRuns">): string {
	return day.cacheReportedRuns === 0 ? "—" : formatInteger(day.cacheHitTokens);
}

/** `hit / miss (weighted rate)` for one record; `null` when either token count is unknown. */
export function formatCacheHitMiss(
	run: Pick<AdminUsageRunRow, "cacheHitTokens" | "cacheMissTokens" | "cacheHitRate">,
): string | null {
	if (run.cacheHitTokens === null || run.cacheMissTokens === null) return null;
	return `${formatInteger(run.cacheHitTokens)} / ${formatInteger(run.cacheMissTokens)} (${formatPercent(run.cacheHitRate)})`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Display timestamps in Beijing time regardless of the browser's time zone. */
export function formatRunTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const local = beijingDate(date);
	return `${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

export function formatDayLabel(day: string): string {
	return day.length >= 10 ? day.slice(5).replace("-", "/") : day;
}

export function coverageLabel(coverage: AdminUsageRunRow["tokenCoverage"]): string {
	return coverage === "complete" ? "完整" : coverage === "partial" ? "不完整" : "无 usage";
}

export function shortId(id: string): string {
	return id.length <= 18 ? id : `${id.slice(0, 18)}…`;
}

export interface UsageFilters {
	readonly group: string;
	readonly model: string;
	readonly state: string;
	readonly query: string;
}

export const EMPTY_FILTERS: UsageFilters = { group: "", model: "", state: "", query: "" };

/** Client-side narrowing of server-provided real rows; never fabricates values. */
export function filterUsageRuns(runs: readonly AdminUsageRunRow[], filters: UsageFilters): readonly AdminUsageRunRow[] {
	const query = filters.query.trim().toLowerCase();
	return runs.filter((run) => {
		if (filters.group !== "" && run.groupId !== filters.group) return false;
		if (filters.model !== "" && (run.model ?? UNKNOWN_MODEL_LABEL) !== filters.model) return false;
		if (filters.state !== "" && (run.state ?? "") !== filters.state) return false;
		if (query === "") return true;
		return [run.id, run.groupName, run.model, run.conversationId, run.routerTaskId, run.routerKeyId].some((value) =>
			value?.toLowerCase().includes(query),
		);
	});
}

export type UsageTab = "runs" | "groups" | "models";
export type UsageSortKey = "createdAt" | "accurateTokens" | "accurateLlmCallCount" | "durationMs";
export interface UsageSort {
	readonly key: UsageSortKey;
	readonly direction: "asc" | "desc";
}

export function sortUsageRuns(runs: readonly AdminUsageRunRow[], sort: UsageSort): readonly AdminUsageRunRow[] {
	const factor = sort.direction === "asc" ? 1 : -1;
	return [...runs].sort((left, right) => {
		if (sort.key === "createdAt") {
			return factor * (Date.parse(left.createdAt) - Date.parse(right.createdAt));
		}
		// Null means "no accurate value"; keep those rows at the bottom in both directions.
		const a = left[sort.key];
		const b = right[sort.key];
		if (a === null && b === null) return 0;
		if (a === null) return 1;
		if (b === null) return -1;
		return factor * (a - b) || Date.parse(right.createdAt) - Date.parse(left.createdAt);
	});
}

function csvCell(value: string | number | null): string {
	const text = value === null ? "" : String(value);
	return `"${text.replaceAll('"', '""')}"`;
}

export function usageCsv(tab: UsageTab, stats: AdminUsageViewStats, runs: readonly AdminUsageRunRow[]): string {
	const lines: (readonly (string | number | null)[])[] = [];
	if (tab === "runs") {
		lines.push([
			"时间 (北京时间)",
			"ID",
			"接入",
			"状态",
			"模型",
			"Token 覆盖",
			"准确 Token",
			"缓存命中 Token",
			"非命中 Token",
			"缓存命中率",
			"部分用量",
			"LLM 调用次数",
			"执行耗时 (ms)",
		]);
		for (const run of runs) {
			lines.push([
				formatBeijing(run.createdAt),
				run.id,
				usageSourceLabel(run.groupName),
				run.state ?? "",
				run.model ?? "",
				coverageLabel(run.tokenCoverage),
				run.accurateTokens,
				run.cacheHitTokens,
				run.cacheMissTokens,
				run.cacheHitRate === null ? null : formatPercent(run.cacheHitRate),
				run.tokenCoverage === "partial" ? run.partialTokens : null,
				run.accurateLlmCallCount,
				run.durationMs,
			]);
		}
	} else {
		const rows: readonly AdminUsageGroupRow[] = tab === "groups" ? stats.byGroup : stats.byModel;
		lines.push([
			tab === "groups" ? "接入" : "模型",
			"数量",
			"完整记录",
			"历史不完整",
			"无 usage",
			"准确 Token",
			"缓存命中 Token",
			"非命中 Token",
			"缓存命中率",
			"缓存覆盖",
			"缓存上报调用",
			"缓存未知调用",
			"缓存上报记录",
			"缓存未知记录",
			"LLM 调用次数",
			"部分用量",
			"平均执行耗时 (ms)",
			"最长执行耗时 (ms)",
		]);
		for (const row of rows) {
			const cacheReported = row.cacheReportedRuns > 0;
			// No complete record → the accurate total is unknown, not zero.
			const complete = row.completeCount > 0;
			lines.push([
				tab === "groups" ? usageSourceLabel(row.label) : row.label,
				row.runCount,
				row.completeCount,
				row.partialCount,
				row.noUsageCount,
				complete ? row.accurateTokens : null,
				cacheReported ? row.cacheHitTokens : null,
				cacheReported ? row.cachePromptTokens - row.cacheHitTokens : null,
				row.cacheHitRate === null ? null : formatPercent(row.cacheHitRate),
				cacheReported ? formatCacheCoverage(row.cacheReportedCalls, row.cacheUnknownCalls) : null,
				row.cacheReportedCalls,
				row.cacheUnknownCalls,
				row.cacheReportedRuns,
				row.cacheUnknownRuns,
				complete ? row.llmCallCount : null,
				row.partialTokens,
				row.avgDurationMs,
				row.maxDurationMs,
			]);
		}
	}
	return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function downloadCsv(filename: string, content: string): void {
	if (typeof document === "undefined") return;
	const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

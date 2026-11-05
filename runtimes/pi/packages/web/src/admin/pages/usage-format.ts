import {
	type AdminUsageGroupRow,
	type AdminUsageRunRow,
	type AdminUsageViewStats,
	UNKNOWN_MODEL_LABEL,
} from "@earendil-works/pi-protocol";

const INTEGER = new Intl.NumberFormat("zh-CN");

export function formatInteger(value: number): string {
	return INTEGER.format(value);
}

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

export function formatDuration(ms: number | null): string {
	if (ms === null || ms <= 0) return "—";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

export function formatCoveragePercent(complete: number, total: number): string {
	return total === 0 ? "—" : `${((complete / total) * 100).toFixed(1)}%`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Display matches the API's UTC caliber; the time-zone is explained in a tooltip. */
export function formatRunTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return `${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

export function formatDayLabel(day: string): string {
	return day.length >= 10 ? day.slice(5).replace("-", "/") : day;
}

export function coverageLabel(coverage: AdminUsageRunRow["tokenCoverage"]): string {
	return coverage === "complete" ? "完整" : coverage === "partial" ? "历史不完整" : "无 usage";
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
		return [run.id, run.groupName, run.model ?? "", run.conversationId ?? ""].some((value) =>
			value.toLowerCase().includes(query),
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
			"时间 (UTC)",
			"ID",
			"接入",
			"状态",
			"模型",
			"Token 覆盖",
			"准确 Token",
			"历史部分 Token",
			"LLM 调用次数",
			"执行耗时 (ms)",
		]);
		for (const run of runs) {
			lines.push([
				run.createdAt,
				run.id,
				run.groupName,
				run.state ?? "",
				run.model ?? "",
				coverageLabel(run.tokenCoverage),
				run.accurateTokens,
				run.partialTokens,
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
			"LLM 调用次数",
			"历史部分 Token",
			"平均执行耗时 (ms)",
			"最长执行耗时 (ms)",
		]);
		for (const row of rows) {
			lines.push([
				row.label,
				row.runCount,
				row.completeCount,
				row.partialCount,
				row.noUsageCount,
				row.accurateTokens,
				row.llmCallCount,
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

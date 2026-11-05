/**
 * Shared, dependency-free aggregation for the admin Usage views.
 *
 * Both the control service and the admin console call `buildUsageViewStats`,
 * so server totals and client-side re-aggregation after filtering always use
 * the same caliber:
 *
 * - `accurateTokens` / `accurateLlmCallCount` count only rows with complete
 *   provider usage. Incomplete rows contribute `null` (rendered as `—`).
 * - `partialTokens` is legacy single-call usage, kept visible for inspection
 *   but never folded into `accurateTokens`.
 * - Chat and orchestration runs live in separate arrays and are never merged.
 */
import type {
	AdminUsageDayRow,
	AdminUsageGroupRow,
	AdminUsageRunRow,
	AdminUsageViewStats,
} from "./admin-workbench-usage.ts";

export const UNKNOWN_MODEL_LABEL = "未记录模型";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Guard against an unbounded loop if a caller ever passes a wide period. */
const MAX_DAYS = 366;

/** UTC calendar day of an ISO timestamp (`YYYY-MM-DD`). */
export function usageDayKey(iso: string): string {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return iso.slice(0, 10);
	return new Date(parsed).toISOString().slice(0, 10);
}

function dayStartMs(day: string): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

/** Inclusive UTC day list covered by the half-open `[from, to)` period. */
export function usageDayRange(from: string, to: string): readonly string[] {
	const first = dayStartMs(usageDayKey(from));
	const toMs = Date.parse(to);
	const toDay = dayStartMs(usageDayKey(to));
	// `to` is exclusive; a whole-midnight bound must not add an empty day.
	const last = Number.isFinite(toMs) && toMs === toDay ? toDay : toDay + DAY_MS;
	if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return [];
	const days: string[] = [];
	for (let at = first; at < last && days.length < MAX_DAYS; at += DAY_MS) {
		days.push(new Date(at).toISOString().slice(0, 10));
	}
	return days;
}

interface MutableGroup {
	readonly key: string;
	readonly label: string;
	runCount: number;
	completeCount: number;
	partialCount: number;
	noUsageCount: number;
	accurateTokens: number;
	partialTokens: number;
	llmCallCount: number;
	readonly durations: number[];
}

function emptyGroup(key: string, label: string): MutableGroup {
	return {
		key,
		label,
		runCount: 0,
		completeCount: 0,
		partialCount: 0,
		noUsageCount: 0,
		accurateTokens: 0,
		partialTokens: 0,
		llmCallCount: 0,
		durations: [],
	};
}

function addRun(group: MutableGroup, run: AdminUsageRunRow): void {
	group.runCount += 1;
	if (run.tokenCoverage === "complete") group.completeCount += 1;
	else if (run.tokenCoverage === "partial") group.partialCount += 1;
	else group.noUsageCount += 1;
	group.accurateTokens += run.accurateTokens ?? 0;
	group.partialTokens += run.partialTokens;
	group.llmCallCount += run.accurateLlmCallCount ?? 0;
	if (run.durationMs !== null) group.durations.push(run.durationMs);
}

function finishGroup(group: MutableGroup): AdminUsageGroupRow {
	const total = group.durations.reduce((sum, value) => sum + value, 0);
	return {
		key: group.key,
		label: group.label,
		runCount: group.runCount,
		completeCount: group.completeCount,
		partialCount: group.partialCount,
		noUsageCount: group.noUsageCount,
		accurateTokens: group.accurateTokens,
		partialTokens: group.partialTokens,
		llmCallCount: group.llmCallCount,
		avgDurationMs: group.durations.length ? Math.round(total / group.durations.length) : 0,
		maxDurationMs: group.durations.length ? Math.max(...group.durations) : 0,
	};
}

function byTokensThenCount(left: AdminUsageGroupRow, right: AdminUsageGroupRow): number {
	return (
		right.accurateTokens - left.accurateTokens ||
		right.runCount - left.runCount ||
		left.label.localeCompare(right.label)
	);
}

/** Aggregate real run rows into coverage, per-group, per-model and per-day views. */
export function buildUsageViewStats(input: {
	readonly runs: readonly AdminUsageRunRow[];
	readonly from: string;
	readonly to: string;
}): AdminUsageViewStats {
	const runs = input.runs;
	const coverage = {
		runCount: runs.length,
		completeCount: 0,
		partialCount: 0,
		noUsageCount: 0,
		accurateTokens: 0,
		partialTokens: 0,
		llmCallCount: 0,
	};
	const groups = new Map<string, MutableGroup>();
	const models = new Map<string, MutableGroup>();
	const days = new Map<string, { runCount: number; accurateTokens: number; partialTokens: number }>();
	for (const day of usageDayRange(input.from, input.to)) {
		days.set(day, { runCount: 0, accurateTokens: 0, partialTokens: 0 });
	}
	for (const run of runs) {
		if (run.tokenCoverage === "complete") coverage.completeCount += 1;
		else if (run.tokenCoverage === "partial") coverage.partialCount += 1;
		else coverage.noUsageCount += 1;
		coverage.accurateTokens += run.accurateTokens ?? 0;
		coverage.partialTokens += run.partialTokens;
		coverage.llmCallCount += run.accurateLlmCallCount ?? 0;

		const groupKey = run.groupId;
		let group = groups.get(groupKey);
		if (group === undefined) {
			group = emptyGroup(groupKey, run.groupName);
			groups.set(groupKey, group);
		}
		addRun(group, run);

		const modelKey = run.model ?? UNKNOWN_MODEL_LABEL;
		let model = models.get(modelKey);
		if (model === undefined) {
			model = emptyGroup(modelKey, modelKey);
			models.set(modelKey, model);
		}
		addRun(model, run);

		const day = days.get(usageDayKey(run.createdAt));
		if (day !== undefined) {
			day.runCount += 1;
			day.accurateTokens += run.accurateTokens ?? 0;
			day.partialTokens += run.partialTokens;
		}
	}
	const byDay: AdminUsageDayRow[] = [...days.entries()].map(([date, value]) => ({ date, ...value }));
	return {
		runs,
		byGroup: [...groups.values()].map(finishGroup).sort(byTokensThenCount),
		byModel: [...models.values()].map(finishGroup).sort(byTokensThenCount),
		byDay,
		coverage,
	};
}

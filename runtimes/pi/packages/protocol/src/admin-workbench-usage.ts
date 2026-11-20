/** Admin Usage aggregation contract. Token counts always come from provider usage. */

export type AdminUsageSource = "embed" | "admin_debug";

export interface AdminUsageTotals {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly requestCount: number;
}

export interface AdminUsageAgentRow extends AdminUsageTotals {
	readonly agentId: string;
	readonly agentName: string;
	readonly source: AdminUsageSource;
}

export interface AdminUsageSourceRow extends AdminUsageTotals {
	readonly source: AdminUsageSource;
}

/** Token totals for orchestration runs whose every LLM call has persisted provider usage. */
export interface AdminUsageTokenTotals {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
}

/** Source of an orchestration Usage row: legacy Integration or Key-owned AaaS Run. */
export type AdminOrchestrationUsageSource = "legacy" | "aaas_key";
export type AdminExecutionUsageSource = "chat" | "integration" | "aaas_key" | "router";

/** Row grouped by AaaS Integration or logical Key. Tokens are accurate totals only; partial values are separate. */
export interface AdminOrchestrationUsageRow {
	readonly integrationId: string;
	readonly integrationName: string;
	readonly source: AdminOrchestrationUsageSource;
	readonly runCount: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly cancelled: number;
	readonly queued: number;
	readonly running: number;
	readonly avgDurationMs: number;
	readonly maxDurationMs: number;
	readonly tokens: AdminUsageTokenTotals;
	readonly llmCallCount: number;
	readonly completeRuns: number;
	readonly partialRuns: number;
	readonly noUsageRuns: number;
	/** Legacy single-call provider usage, excluded from accurate token totals. */
	readonly partialTokens: number;
	readonly models: readonly string[];
	readonly versionIds: readonly string[];
}

export type AdminOrchestrationTokenCoverage = "complete" | "partial" | "none";

export interface AdminOrchestrationRunRow {
	readonly runId: string;
	readonly integrationId: string;
	readonly state: string;
	readonly createdAt: string;
	readonly model: string | null;
	readonly versionId: string | null;
	readonly tokenCoverage: AdminOrchestrationTokenCoverage;
	readonly totalTokens: number;
	readonly llmCallCount: number;
	readonly durationMs: number | null;
}

export interface AdminOrchestrationUsage {
	readonly byIntegration: readonly AdminOrchestrationUsageRow[];
	readonly recentRuns: readonly AdminOrchestrationRunRow[];
	readonly coverage: {
		readonly completeRuns: number;
		readonly partialRuns: number;
		readonly noUsageRuns: number;
		readonly completeTokens: number;
		readonly partialTokens: number;
		readonly note: string;
	};
	/** Full-period detail view built from the same run rows; absent on legacy services. */
	readonly view?: AdminUsageViewStats;
}

/**
 * One fact row of a usage view. `accurateTokens` / `accurateLlmCallCount` are `null`
 * when provider usage is incomplete or absent; consumers must render `—` and
 * must never coerce them to zero.
 */
export interface AdminUsageRunRow {
	readonly id: string;
	readonly source?: AdminExecutionUsageSource;
	readonly routerTaskId?: string;
	readonly routerKeyId?: string;
	readonly groupId: string;
	readonly groupName: string;
	/** Orchestration work-item state; null for Chat requests. */
	readonly state: string | null;
	readonly createdAt: string;
	readonly model: string | null;
	readonly versionId: string | null;
	readonly tokenCoverage: AdminOrchestrationTokenCoverage;
	readonly accurateTokens: number | null;
	/** Known consumption on incomplete records, excluded from accurate totals. */
	readonly partialTokens: number;
	readonly accurateLlmCallCount: number | null;
	/**
	 * Prompt-cache read tokens reported by the provider, or `null` when the
	 * request did not report cache fields (unknown, never coerced to zero).
	 */
	readonly cacheHitTokens: number | null;
	/** Provider prompt tokens minus cache-hit tokens (`null` when cache data is unknown). */
	readonly cacheMissTokens: number | null;
	/** Prompt-token denominator used for the hit rate (`null` when cache data is unknown). */
	readonly cachePromptTokens: number | null;
	/** `cacheHitTokens / cachePromptTokens` as a 0..1 fraction; `null` when unknown or prompt is 0. */
	readonly cacheHitRate: number | null;
	/**
	 * LLM calls of this row that explicitly reported prompt-cache read tokens.
	 * Cache numbers are aggregated over those calls only; `undefined` on legacy
	 * producers that do not report per-call cache coverage.
	 */
	readonly cacheReportedCalls?: number;
	/**
	 * LLM calls of this row without cache telemetry (the provider never
	 * reported cache fields for that call). Unknown is not a miss: these calls
	 * are excluded from both the hit and the prompt denominator.
	 */
	readonly cacheUnknownCalls?: number;
	/** Orchestration execution elapsed (assignment start → end), excluding queue time; null for Chat. */
	readonly durationMs: number | null;
	readonly conversationId: string | null;
}

export interface AdminUsageGroupRow {
	readonly key: string;
	readonly label: string;
	readonly runCount: number;
	readonly completeCount: number;
	readonly partialCount: number;
	readonly noUsageCount: number;
	readonly accurateTokens: number;
	readonly partialTokens: number;
	readonly llmCallCount: number;
	readonly avgDurationMs: number;
	readonly maxDurationMs: number;
	/** Cache counters aggregated only over token-complete rows that reported cache data. */
	readonly cacheHitTokens: number;
	readonly cachePromptTokens: number;
	/** Weighted hit rate over the rows with reported cache data; `null` when none. */
	readonly cacheHitRate: number | null;
	readonly cacheReportedRuns: number;
	readonly cacheUnknownRuns: number;
	/** LLM calls that explicitly reported prompt-cache read tokens. */
	readonly cacheReportedCalls: number;
	/** LLM calls without cache telemetry; never counted as cache misses. */
	readonly cacheUnknownCalls: number;
}

export interface AdminUsageDayRow {
	/** UTC calendar day, `YYYY-MM-DD`. */
	readonly date: string;
	readonly runCount: number;
	readonly accurateTokens: number;
	readonly partialTokens: number;
	readonly cacheHitTokens: number;
	readonly cachePromptTokens: number;
	/** Weighted hit rate of the day; `null` when no row reported cache data. */
	readonly cacheHitRate: number | null;
	readonly cacheReportedRuns: number;
	readonly cacheUnknownRuns: number;
	/** LLM calls of the day that explicitly reported prompt-cache read tokens. */
	readonly cacheReportedCalls: number;
	/** LLM calls of the day without cache telemetry; never counted as cache misses. */
	readonly cacheUnknownCalls: number;
}

export interface AdminUsageCoverage {
	readonly runCount: number;
	readonly completeCount: number;
	readonly partialCount: number;
	readonly noUsageCount: number;
	readonly accurateTokens: number;
	readonly partialTokens: number;
	readonly llmCallCount: number;
	/** Token-complete rows that explicitly reported cache fields (hit rate denominator set). */
	readonly cacheReportedRuns: number;
	/** Token-complete rows that did not report cache fields; excluded from the hit rate. */
	readonly cacheUnknownRuns: number;
	/** LLM calls that explicitly reported prompt-cache read tokens. */
	readonly cacheReportedCalls: number;
	/** LLM calls without cache telemetry; excluded from the hit rate. */
	readonly cacheUnknownCalls: number;
	readonly cacheHitTokens: number;
	readonly cachePromptTokens: number;
	readonly cacheMissTokens: number;
	/** Weighted `cacheHitTokens / cachePromptTokens`; `null` when no reported prompt tokens. */
	readonly cacheHitRate: number | null;
}

/**
 * A usage view computed from disjoint source facts under one coverage rule.
 */
export interface AdminUsageViewStats {
	readonly runs: readonly AdminUsageRunRow[];
	readonly byGroup: readonly AdminUsageGroupRow[];
	readonly byModel: readonly AdminUsageGroupRow[];
	readonly byDay: readonly AdminUsageDayRow[];
	readonly coverage: AdminUsageCoverage;
}

export interface AdminUsageSummary {
	readonly period: {
		readonly from: string;
		readonly to: string;
		readonly timezone: "UTC";
	};
	readonly totals: AdminUsageTotals;
	readonly byAgent: readonly AdminUsageAgentRow[];
	readonly bySource: readonly AdminUsageSourceRow[];
	/** Optional for compatibility with services that do not yet expose orchestration aggregation. */
	readonly orchestration?: AdminOrchestrationUsage;
	/** Chat Agent view, computed from Chat-only turn/end events. Optional for legacy services. */
	readonly chat?: AdminUsageViewStats;
	/** One row per Router Operation, using its committed usage for the selected period. */
	readonly router?: AdminUsageViewStats;
	readonly generatedAt: string;
}

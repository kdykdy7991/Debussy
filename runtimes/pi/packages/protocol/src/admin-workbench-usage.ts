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

/** Row grouped by AaaS Integration. Tokens are accurate totals only; partial values are separate. */
export interface AdminOrchestrationUsageRow {
	readonly integrationId: string;
	readonly integrationName: string;
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
 * One fact row of an independent usage view (either Agent orchestration runs
 * or Chat Agent requests). `accurateTokens` / `accurateLlmCallCount` are `null`
 * when provider usage is incomplete or absent; consumers must render `—` and
 * must never coerce them to zero.
 */
export interface AdminUsageRunRow {
	readonly id: string;
	readonly groupId: string;
	readonly groupName: string;
	/** Orchestration work-item state; null for Chat requests. */
	readonly state: string | null;
	readonly createdAt: string;
	readonly model: string | null;
	readonly versionId: string | null;
	readonly tokenCoverage: AdminOrchestrationTokenCoverage;
	readonly accurateTokens: number | null;
	/** Legacy single-call provider usage, kept for inspection but never summed into accurate totals. */
	readonly partialTokens: number;
	readonly accurateLlmCallCount: number | null;
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
}

export interface AdminUsageDayRow {
	/** UTC calendar day, `YYYY-MM-DD`. */
	readonly date: string;
	readonly runCount: number;
	readonly accurateTokens: number;
	readonly partialTokens: number;
}

export interface AdminUsageCoverage {
	readonly runCount: number;
	readonly completeCount: number;
	readonly partialCount: number;
	readonly noUsageCount: number;
	readonly accurateTokens: number;
	readonly partialTokens: number;
	readonly llmCallCount: number;
}

/**
 * A self-contained, single-caliber usage view. Orchestration and Chat views
 * are built from disjoint event sets and must never be merged into one number.
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
	readonly generatedAt: string;
}

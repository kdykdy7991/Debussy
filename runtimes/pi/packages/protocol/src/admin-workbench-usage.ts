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
	readonly generatedAt: string;
}

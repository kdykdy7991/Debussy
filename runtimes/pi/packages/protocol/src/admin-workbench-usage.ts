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

export interface AdminUsageSummary {
	readonly period: {
		readonly from: string;
		readonly to: string;
		readonly timezone: "UTC";
	};
	readonly totals: AdminUsageTotals;
	readonly byAgent: readonly AdminUsageAgentRow[];
	readonly bySource: readonly AdminUsageSourceRow[];
	readonly generatedAt: string;
}

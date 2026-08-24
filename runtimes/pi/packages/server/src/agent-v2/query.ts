/**
 * Agent 平台 V2 M1：查询侧读取 + 运行时校验。
 *
 * 控制面查询从持久化事件（turn/end、turn/failed、context/snapshot）读取本服务写入的
 * `payload.metrics` / snapshot。数据来自持久化存储，虽由本仓库写入，仍做保守的形状
 * 校验：缺失或异常时不抛错、按“无数据”处理，绝不把无关 payload 当指标。
 */
import {
	type ContextUsageSnapshot,
	type ConversationTurnMetric,
	type TurnMetrics,
	type TurnOutcome,
	turnOutcomeFromTerminalEvent,
} from "@earendil-works/pi-protocol";

const OUTCOMES: ReadonlySet<TurnOutcome> = new Set<TurnOutcome>(["success", "failed", "cancelled"]);

/** 事件是否为终态轮事件（权威判定来自 protocol `turnOutcomeFromTerminalEvent`）。 */
export function isTerminalTurnEvent(eventType: string): boolean {
	return turnOutcomeFromTerminalEvent(eventType) !== null;
}

/** turn/start（含 legacy dotted 别名）——用于关联该轮 `model`。 */
export function isTurnStartEvent(eventType: string): boolean {
	return eventType === "turn/start" || eventType === "turn.start";
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

const METRIC_COUNT_KEYS: readonly (keyof TurnMetrics)[] = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
];
const METRIC_OPTIONAL_KEYS: readonly (keyof TurnMetrics)[] = ["ttftMs", "generationMs", "outputTokensPerSecond"];

const BREAKDOWN_KEYS: readonly string[] = [
	"systemPrompt",
	"skillInstructions",
	"toolDefinitions",
	"conversationMessages",
	"toolResults",
	"retrievalContext",
	"attachments",
];

function isValidStoredStamps(v: unknown): boolean {
	if (!isObject(v)) return false;
	for (const key of ["requestStartedAt", "providerStartedAt", "completedAt"]) {
		if (typeof v[key] !== "string") return false;
	}
	return v.firstOutputAt === null || typeof v.firstOutputAt === "string";
}

/**
 * 严格校验存储的 `TurnMetrics`（`turn/end`/`turn/failed` 的 `payload.metrics`）。
 * 任一必需字段缺失/非有限数、或者非 success 仍带 TTFT 派生值，一律视为不存在
 * （绝不把可能产生 NaN 或缺字段的异常数据当指标）。
 */
export function readStoredTurnMetrics(payload: unknown): TurnMetrics | undefined {
	if (!isObject(payload)) return undefined;
	const metrics = payload.metrics;
	if (!isObject(metrics)) return undefined;
	const outcome = metrics.outcome;
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome as TurnOutcome)) return undefined;
	for (const key of METRIC_COUNT_KEYS) {
		if (!isFiniteNumber(metrics[key])) return undefined;
	}
	if (!isFiniteNumber(metrics.totalLatencyMs)) return undefined;
	for (const key of METRIC_OPTIONAL_KEYS) {
		const value = metrics[key];
		if (value === null) continue;
		if (!isFiniteNumber(value)) return undefined;
		// 只有 success 的 ttft/generation/tps 才可能有值。
		if (outcome !== "success") return undefined;
	}
	if (!isValidStoredStamps(metrics.stamps)) return undefined;
	return metrics as unknown as TurnMetrics;
}

/** 严格校验存储的 `ContextUsageSnapshot`（`context/snapshot` 的 `payload.snapshot`）。 */
export function readStoredContextSnapshot(payload: unknown): ContextUsageSnapshot | undefined {
	if (!isObject(payload)) return undefined;
	const snapshot = payload.snapshot;
	if (!isObject(snapshot)) return undefined;
	for (const key of ["usedTokens", "contextWindow", "remainingTokens", "reservedOutputTokens", "usagePercent"]) {
		if (!isFiniteNumber(snapshot[key])) return undefined;
	}
	if (snapshot.measurement !== "exact" && snapshot.measurement !== "estimated") return undefined;
	const breakdown = snapshot.breakdown;
	if (!isObject(breakdown)) return undefined;
	for (const key of BREAKDOWN_KEYS) {
		if (!isFiniteNumber(breakdown[key])) return undefined;
	}
	return snapshot as unknown as ContextUsageSnapshot;
}

/** 组装单轮明细（`turnId` 为公开 `turn_*` id；`sessionEffort` 恒 null，reasoning 不在本里程碑）。 */
export function toConversationTurnMetric(row: {
	readonly turnId: string;
	readonly sequence: number;
	readonly modelId: string;
	readonly metrics: TurnMetrics;
}): ConversationTurnMetric {
	return {
		turnId: row.turnId,
		sequence: row.sequence,
		modelId: row.modelId,
		sessionEffort: null,
		metrics: row.metrics,
	};
}

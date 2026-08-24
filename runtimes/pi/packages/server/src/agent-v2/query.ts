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

/** 非负有限数。 */
function isNonNegativeFinite(v: unknown): v is number {
	return isFiniteNumber(v) && v >= 0;
}

/** 非负整数。 */
function isNonNegativeInt(v: unknown): v is number {
	return Number.isInteger(v) && (v as number) >= 0;
}

/** 严格 ISO-8601 UTC 判定：写端统一用 `toISOString()`，故经 `Date` 往返必须逐字一致。 */
function isValidIso(v: unknown): v is string {
	if (typeof v !== "string" || v.length === 0) return false;
	const parsed = Date.parse(v);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === v;
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

/**
 * 严格校验存储的 `TurnMetrics`（`turn/end`/`turn/failed` 的 `payload.metrics`）。
 * 任一违规即视为不存在（绝不把可能产生 NaN 或缺字段的异常数据当指标）：
 * - outcome 合法；
 * - usage 各字段为非负整数；
 * - totalLatencyMs 为非负有限数；
 * - ttft/generation/TPS 为 null 或非负有限数；
 * - stamps 为有效 ISO 且顺序合法（request<=provider<=completed；first 存在时
 *   provider<=first<=completed）；
 * - `firstOutputAt === null` 时 ttft/generation/TPS 必须全部为 null；
 * - 有 first output 时 outcome 必须为 success。
 */
export function readStoredTurnMetrics(payload: unknown): TurnMetrics | undefined {
	if (!isObject(payload)) return undefined;
	const m = payload.metrics;
	if (!isObject(m)) return undefined;
	const outcome = m.outcome;
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome as TurnOutcome)) return undefined;
	for (const key of METRIC_COUNT_KEYS) {
		if (!isNonNegativeInt(m[key])) return undefined;
	}
	if (!isNonNegativeFinite(m.totalLatencyMs)) return undefined;
	for (const key of METRIC_OPTIONAL_KEYS) {
		const value = m[key];
		if (value !== null && !isNonNegativeFinite(value)) return undefined;
	}
	const stamps = m.stamps;
	if (!isObject(stamps)) return undefined;
	const first = stamps.firstOutputAt;
	if (first !== null && !isValidIso(first)) return undefined;
	for (const key of ["requestStartedAt", "providerStartedAt", "completedAt"]) {
		if (!isValidIso(stamps[key])) return undefined;
	}
	const req = Date.parse(stamps.requestStartedAt as string);
	const prov = Date.parse(stamps.providerStartedAt as string);
	const comp = Date.parse(stamps.completedAt as string);
	if (req > prov || prov > comp) return undefined;
	if (first !== null) {
		const f = Date.parse(first as string);
		if (prov > f || f > comp) return undefined;
	}
	// 无 first output → 派生时序必须全为 null。
	if (first === null) {
		for (const key of METRIC_OPTIONAL_KEYS) {
			if (m[key] !== null) return undefined;
		}
	} else if (outcome !== "success") {
		// 有 first output 只允许 success。
		return undefined;
	}
	return m as unknown as TurnMetrics;
}

/**
 * 严格校验存储的 `ContextUsageSnapshot`（`context/snapshot` 的 `payload.snapshot`）：
 * 数值全部为非负、`contextWindow > 0`、`sum(breakdown) === usedTokens`，且
 * `remainingTokens`/`usagePercent` 与派生一致。任一违规视为不存在。
 */
export function readStoredContextSnapshot(payload: unknown): ContextUsageSnapshot | undefined {
	if (!isObject(payload)) return undefined;
	const s = payload.snapshot;
	if (!isObject(s)) return undefined;
	const used = s.usedTokens;
	const window = s.contextWindow;
	const remaining = s.remainingTokens;
	const reserved = s.reservedOutputTokens;
	const percent = s.usagePercent;
	if (!isNonNegativeInt(used) || !isNonNegativeInt(window) || window < 1) return undefined;
	if (!isNonNegativeInt(remaining) || !isNonNegativeInt(reserved)) return undefined;
	if (!isNonNegativeFinite(percent)) return undefined;
	if (s.measurement !== "exact" && s.measurement !== "estimated") return undefined;
	const breakdown = s.breakdown;
	if (!isObject(breakdown)) return undefined;
	let sum = 0;
	for (const key of BREAKDOWN_KEYS) {
		const value = breakdown[key];
		if (!isNonNegativeInt(value)) return undefined;
		sum += value;
	}
	if (sum !== used) return undefined;
	if (remaining !== Math.max(0, window - used - reserved)) return undefined;
	const expectedPercent = Number(((used / window) * 100).toFixed(2));
	if (Math.abs(percent - expectedPercent) > 1e-6) return undefined;
	return s as unknown as ContextUsageSnapshot;
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

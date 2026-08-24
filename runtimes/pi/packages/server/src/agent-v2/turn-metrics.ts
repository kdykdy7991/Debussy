/**
 * Agent 平台 V2 M1：运行时时序 → 冻结 `TurnMetrics` 的桥接模块。
 *
 * 只依赖 protocol 的 `deriveTurnMetrics`（admin-workbench-metrics，M0-A 已冻结），
 * 不做落库/查询。采集端（embed sync / realtime 执行路径）在 turn 开始处取一次单调基准，
 * 记录 provider 开始 / 首个可展示文本 / 终态三个单调时点与权威 Usage，经本模块产出
 * `TurnMetrics` 写入 `turn/end` payload。
 *
 * 墙上时间戳仅用于展示/追溯：由 epoch 基准 + 单调偏移推算，免疫 NTP 跳变；延迟推导
 * 完全由单调时点完成。乱序单调输入由 `deriveTurnMetrics` 抛 `RangeError`，不会静默
 * 产生负值。开关由 `PI_AGENT_V2_METRICS` 控制（见 `feature-flag.ts`）。
 */
import {
	deriveTurnMetrics,
	type TurnMetrics,
	type TurnMetricsDerivationInput,
	type TurnOutcome,
	type TurnWallClockStamps,
	type Usage,
} from "@earendil-works/pi-protocol";

/** turn 开始时捕获的一次性时间基准（单写）。 */
export interface TurnTimingBase {
	/** 单调时钟基准（ms，相对进程启动）。 */
	readonly monotonicStartMs: number;
	/** 墙上时钟基准（epoch ms）。 */
	readonly epochStartMs: number;
}

/** 用单调/墙上各取当前时点建立基准；便于注入时钟做确定测试。 */
export function startTurnTiming(
	monotonicNow: () => number = () => performance.now(),
	epochNow: () => number = () => Date.now(),
): TurnTimingBase {
	return { monotonicStartMs: monotonicNow(), epochStartMs: epochNow() };
}

/** turn 内三个单调时点（相对任一单调基准，如 startTurnTiming 的基准进程起点）。 */
export interface TurnTimingEvents {
	/** Provider 请求开始。 */
	readonly providerStartAtMs: number;
	/** 首个可展示文本增量；无输出为 `null`。 */
	readonly firstOutputAtMs: number | null;
	/** 终态（结束/失败/取消）。 */
	readonly completedAtMs: number;
}

/** 权威 token 计数（来自 Provider Usage）。 */
export interface TurnUsageCounts {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}

/** `buildTurnMetrics` 输入：终局 + 基准 + 单调时点 + 权威 Usage。 */
export interface BuildTurnMetricsInput {
	readonly outcome: TurnOutcome;
	readonly base: TurnTimingBase;
	readonly events: TurnTimingEvents;
	readonly usage: TurnUsageCounts;
}

function isoAt(epochStartMs: number, monotonicOffsetMs: number): string {
	return new Date(epochStartMs + Math.max(0, monotonicOffsetMs)).toISOString();
}

/** 把 Provider 的权威 `Usage` 映射为 `TurnUsageCounts`；缺省用 0。 */
export function usageCountsFromProtocolUsage(usage: Usage | undefined): TurnUsageCounts {
	if (usage === undefined) {
		return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	}
	return {
		inputTokens: usage.input ?? 0,
		outputTokens: usage.output ?? 0,
		cacheReadTokens: usage.cacheRead ?? 0,
		cacheWriteTokens: usage.cacheWrite ?? 0,
	};
}

/**
 * 由基准与时点推导 `TurnMetrics`。墙上时间戳 = epoch 基准 + 单调偏移（仅展示/追溯）；
 * 延迟=单调时点差。调用 `deriveTurnMetrics`，乱序输入抛 `RangeError`。
 */
export function buildTurnMetrics(input: BuildTurnMetricsInput): TurnMetrics {
	const base = input.base;
	const offset = (at: number) => at - base.monotonicStartMs;
	const firstOutputDelayMs = input.events.firstOutputAtMs === null ? null : offset(input.events.firstOutputAtMs);
	const stamps: TurnWallClockStamps = {
		requestStartedAt: new Date(base.epochStartMs).toISOString(),
		providerStartedAt: isoAt(base.epochStartMs, offset(input.events.providerStartAtMs)),
		firstOutputAt: input.events.firstOutputAtMs === null ? null : isoAt(base.epochStartMs, firstOutputDelayMs ?? 0),
		completedAt: isoAt(base.epochStartMs, offset(input.events.completedAtMs)),
	};
	const derivation: TurnMetricsDerivationInput = {
		outcome: input.outcome,
		...input.usage,
		stamps,
		monotonic: {
			providerStartDelayMs: offset(input.events.providerStartAtMs),
			firstOutputDelayMs,
			totalElapsedMs: offset(input.events.completedAtMs),
		},
	};
	return deriveTurnMetrics(derivation);
}

/**
 * Agent 平台 V2：单会话统计与上下文快照契约（V2-README §4）。
 *
 * M0 只冻结共享 DTO、事件顺序/空值语义、错误码与纯函数推导规则；不包含
 * 采集或查询实现（M1）。冻结后前端可基于本模块建立 mock 并行开发。
 *
 * 冻结口径（不可在实现中静默漂移）：
 *
 * - Provider Usage 是 input/output/cache Token 的权威值；估算只用于上下文
 *   分项，不覆盖权威 Usage。
 * - 时间测量必须使用单调时钟（monotonic），与墙上时间（wall-clock，仅用于
 *   展示/追溯的 ISO 时间戳）显式分离，避免 NTP 跳变污染延迟推导。见
 *   {@link TurnMonotonicDelays} 与 {@link TurnWallClockStamps}。
 * - `ttftMs` 只算首个可展示文本增量（thinking/心跳/Tool 事件不算首 Token）。
 * - 非 success 回合（failed/cancelled）以 `outcome` 标记，其
 *   `ttftMs`/`generationMs`/`outputTokensPerSecond` 为 `null`，不得写成 0 混入
 *   平均值。
 * - 会话均值只统计 `outcome === "success"` 的有值轮次，同时返回样本数
 *   （`sampleCount`）。failed/cancelled 不参与任何均值，包括 `totalLatencyMs`。
 * - 上下文快照在最终模型请求组装完成、发送之前生成；`breakdown` 分项之和
 *   必须能解释 `usedTokens`；无法使用精确 tokenizer 时标为 `estimated`。
 *
 * 事件顺序（M0 冻结）：`turn/start` → `context/snapshot` → `user/message` →
 * `assistant/start` → 首个可展示文本增量 → … → `turn/end`（携带 `TurnMetrics`）。
 * `context/snapshot` 必须在最终请求发送前持久化，查询端不得重新猜测历史值。
 *
 * 终态事件边界（M0 冻结）：`turn/end` → success；`turn/interrupted` →
 * cancelled；legacy 命名（`turn.end`/`turn.interrupted`）仅只读兼容映射。失败
 * 回合当前以 `turn/interrupted` 表达，无副作用终态事件时视为 cancelled。详见
 * {@link turnOutcomeFromTerminalEvent}。
 */
import type { ConversationPublicId } from "./admin-workbench.ts";

/** 上下文快照的计量精度。无法使用模型精确 tokenizer 时必为 `estimated`。 */
export type ContextUsageMeasurement = "exact" | "estimated";

/**
 * 上下文分项。全部为数值，缺省用 0；所有分项之和必须能解释
 * `ContextUsageSnapshot.usedTokens`。不可归类的内容必须新增明确字段，
 * 不得塞入 `conversationMessages` 隐藏差异。
 */
export interface ContextUsageBreakdown {
	readonly systemPrompt: number;
	readonly skillInstructions: number;
	readonly toolDefinitions: number;
	readonly conversationMessages: number;
	readonly toolResults: number;
	readonly retrievalContext: number;
	readonly attachments: number;
}

/** 一次最终模型请求发送前的上下文快照（V2-README §4.2）。 */
export interface ContextUsageSnapshot {
	readonly usedTokens: number;
	readonly contextWindow: number;
	readonly remainingTokens: number;
	readonly reservedOutputTokens: number;
	readonly usagePercent: number;
	readonly measurement: ContextUsageMeasurement;
	readonly breakdown: ContextUsageBreakdown;
}

/** 回合终局结果。只有 `success` 的派生时序字段才可能有值。 */
export type TurnOutcome = "success" | "failed" | "cancelled";

/**
 * 墙上时间戳（ISO 8601 / UTC），仅用于展示与追溯。延迟推导一律使用
 * {@link TurnMonotonicDelays}，不得用这些墙上时间戳做减法。
 */
export interface TurnWallClockStamps {
	readonly requestStartedAt: string;
	readonly providerStartedAt: string;
	readonly firstOutputAt: string | null;
	readonly completedAt: string;
}

/**
 * 单调时钟延迟（毫秒，相对一次请求开始时捕获的单一单调时间基准）。
 * 与墙上时间分离，免疫 NTP 跳变；所有 `*Ms` 派生值仅由这些延迟计算。
 */
export interface TurnMonotonicDelays {
	/** 从请求开始到 Provider 请求开始的单调延迟。 */
	readonly providerStartDelayMs: number;
	/** 从请求开始到首个可展示文本增量的单调延迟；无输出时为 `null`。 */
	readonly firstOutputDelayMs: number | null;
	/** 从请求开始到终态点（结束/失败/取消）的单调总耗时。恒有值。 */
	readonly totalElapsedMs: number;
}

/**
 * 每轮性能度量（V2-README §4.1）。`outcome` 显式标记成功/失败/取消；
 * 派生时序字段仅 `success` 时可能有值，失败/取消一律 `null`（不得写 0）。
 */
export interface TurnMetrics {
	readonly outcome: TurnOutcome;
	readonly stamps: TurnWallClockStamps;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly ttftMs: number | null;
	readonly generationMs: number | null;
	readonly totalLatencyMs: number;
	readonly outputTokensPerSecond: number | null;
}

/** `deriveTurnMetrics` 输入：终局 + 权威 Token + 墙上/单调两套时间。 */
export interface TurnMetricsDerivationInput {
	readonly outcome: TurnOutcome;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly stamps: TurnWallClockStamps;
	readonly monotonic: TurnMonotonicDelays;
}

/**
 * 从单调延迟推导 `TurnMetrics`。纯函数、无副作用，供后端测试与前端 mock 共用
 * 同一公式；M1 采集在持久化前调用并以结果写 `turn/end` payload。
 *
 * 推导规则（与 V2-README §4.1 一致，全部基于单调时钟）：
 * - `ttftMs = firstOutputDelayMs - providerStartDelayMs`（仅 success 且首 Token
 *   存在且不早于 provider 开始）；
 * - `generationMs = totalElapsedMs - firstOutputDelayMs`（同上，仅 success）；
 * - `totalLatencyMs = totalElapsedMs`（恒有值，但不用于 failed/cancelled 的均值）；
 * - `outputTokensPerSecond = outputTokens / generationMs * 1000`（仅 success 且
 *   generationMs>0 且 outputTokens>0，否则 `null`）。
 */
export function deriveTurnMetrics(input: TurnMetricsDerivationInput): TurnMetrics {
	const { outcome, monotonic } = input;
	const successful = outcome === "success";
	const hasFirstOutput =
		successful &&
		monotonic.firstOutputDelayMs !== null &&
		monotonic.firstOutputDelayMs >= monotonic.providerStartDelayMs;
	const ttftMs = hasFirstOutput ? monotonic.firstOutputDelayMs! - monotonic.providerStartDelayMs : null;
	const generationMs = hasFirstOutput ? monotonic.totalElapsedMs - monotonic.firstOutputDelayMs! : null;
	const outputTokensPerSecond =
		hasFirstOutput && generationMs! > 0 && input.outputTokens > 0
			? (input.outputTokens / generationMs!) * 1000
			: null;
	return {
		outcome,
		stamps: input.stamps,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		cacheReadTokens: input.cacheReadTokens,
		cacheWriteTokens: input.cacheWriteTokens,
		ttftMs,
		generationMs,
		totalLatencyMs: monotonic.totalElapsedMs,
		outputTokensPerSecond,
	};
}

/**
 * 终态事件到 `TurnOutcome` 的映射，冻结 legacy 只读兼容边界。
 * 返回 `null` 表示传入的不是终态事件（如 `turn/start`）。
 */
const TERMINAL_EVENT_TO_OUTCOME: Readonly<Record<string, TurnOutcome>> = {
	"turn/end": "success",
	"turn.end": "success",
	"turn.failed": "failed",
	"turn/failed": "failed",
	"turn.interrupted": "cancelled",
	"turn/interrupted": "cancelled",
} as const;

/** 终态事件到 `TurnOutcome` 的映射（含 legacy 只读别名）；非终态返回 `null`。 */
export function turnOutcomeFromTerminalEvent(eventType: string): TurnOutcome | null {
	return TERMINAL_EVENT_TO_OUTCOME[eventType] ?? null;
}

/**
 * `conversation_events` 中 `turn/end` 事件 payload 的兼容结构。
 *
 * 既有字段（`ok`、`usage`）保持不变，`payload->'usage'` 仍是用量聚合的唯一权威
 * 读取点（migration 0005/0010 与 conversation-events 聚合均依赖它）。V2 在顶层
 * 追加 `metrics`，对 pre-V2 转向后兼容：缺省为不写该键，聚合不受影响。
 */
export interface TurnEndPayload {
	/** 既有：本轮是否成功。保留以兼容现有写入方。 */
	readonly ok?: boolean;
	/** 既有：Provider 报告的用量对象。保留原有形状与读取路径。 */
	readonly usage?: Readonly<Record<string, unknown>>;
	/** V2 扩展：本轮性能度量。pre-V2 转向不写；failed/cancelled 亦可写（派生时序为 null）。 */
	readonly metrics?: TurnMetrics;
}

/** `GET /api/control/v1/conversations/:id/metrics` 单轮明细行。 */
export interface ConversationTurnMetric {
	/** 持久事件 turn id（`turn_*`）。 */
	readonly turnId: string;
	/** 该轮 `turn/end` 事件的序列号；分页游标按此推进。 */
	readonly sequence: number;
	readonly modelId: string;
	/** 该轮生效的会话思考覆盖（仅 reasoning；未覆盖/无则为 `null`）。 */
	readonly sessionEffort: string | null;
	readonly metrics: TurnMetrics;
}

/** 单个数值字段在“有值成功样本”上的聚合。 */
export interface TurnMetricFieldStat {
	/** 有值成功样本上的算术均值；无样本时为 `null`。 */
	readonly mean: number | null;
	/** 参与均值/分位的有值成功样本数。 */
	readonly count: number;
	/** 有值成功样本上的分位数；样本不足或无数值时无法计算则为 `null`。 */
	readonly p50: number | null;
	readonly p95: number | null;
}

/** 单会话指标汇总。均值/分位只统计 `outcome === "success"` 且有值的轮次。 */
export interface ConversationMetricsStats {
	/** 至少存在一条查询返回的轮记录。 */
	readonly available: boolean;
	/** 当前页返回的总轮数（任意 outcome）。 */
	readonly turnCount: number;
	/** `outcome === "success"` 的轮数；是均值/分位的有效样本上界。 */
	readonly sampleCount: number;
	readonly ttftMs: TurnMetricFieldStat;
	readonly generationMs: TurnMetricFieldStat;
	readonly totalLatencyMs: TurnMetricFieldStat;
	readonly outputTokensPerSecond: TurnMetricFieldStat;
}

/**
 * `GET /api/control/v1/conversations/:id/metrics` 响应。
 *
 * 空态：会话存在但无指标数据时返回 HTTP 200 且 `stats.available=false`、`items=[]`
 * （这不是错误）。需要游标翻页时看 `nextAfterSequence`。
 */
export interface ConversationMetricsResponse {
	readonly conversationId: ConversationPublicId;
	readonly stats: ConversationMetricsStats;
	/** 逐轮明细（按 sequence 升序；返回本页最后一轮 sequence 的游标）。 */
	readonly items: readonly ConversationTurnMetric[];
	/** 下一页起始 sequence 游标；无更多数据时为 `null`。 */
	readonly nextAfterSequence: number | null;
}

/** `GET /api/control/v1/conversations/:id/context` 响应（返回最新一帧快照）。 */
export interface ConversationContextResponse {
	readonly conversationId: ConversationPublicId;
	/** 会话存在（即使无快照）即非错误；无快照时也返回 200。 */
	readonly available: boolean;
	/** 旧会话无快照时为 `null`（不伪造 0）。 */
	readonly latest: ContextUsageSnapshot | null;
	/** 快照对应的 `context/snapshot` 事件序列号；无快照时为 `null`。 */
	readonly atSequence: number | null;
}

/**
 * 从逐轮明细计算单会话统计。均值与分位只统计 `outcome === "success"` 且有值的
 * 轮次；failed/cancelled 一律不参与（包括 `totalLatencyMs`）。
 */
export function computeConversationMetricsStats(items: readonly ConversationTurnMetric[]): ConversationMetricsStats {
	const successRows = items.filter((item) => item.metrics.outcome === "success");
	const collect = (pick: (m: TurnMetrics) => number | null): number[] => {
		const values: number[] = [];
		for (const item of successRows) {
			const v = pick(item.metrics);
			if (v !== null) values.push(v);
		}
		return values;
	};
	const field = (values: number[]): TurnMetricFieldStat => {
		if (values.length === 0) return { mean: null, count: 0, p50: null, p95: null };
		const sorted = [...values].sort((a, b) => a - b);
		return {
			mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
			count: sorted.length,
			p50: percentile(sorted, 50),
			p95: percentile(sorted, 95),
		};
	};
	return {
		available: items.length > 0,
		turnCount: items.length,
		sampleCount: successRows.length,
		ttftMs: field(collect((m) => m.ttftMs)),
		generationMs: field(collect((m) => m.generationMs)),
		totalLatencyMs: field(collect((m) => m.totalLatencyMs)),
		outputTokensPerSecond: field(collect((m) => m.outputTokensPerSecond)),
	};
}

/** Nearest-rank percentile; caller must pass a non-empty sorted array. */
function percentile(sorted: readonly number[], p: number): number {
	const rank = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
}

/** 本里程碑数据集 / 上下文查询的稳定错误码（控制面错误信封 `ControlErrorEnvelope`）。 */
export const AGENT_V2_METRICS_ERROR_CODES = [
	// 指标子系统暂不可用（特性关闭/服务不可达）→ 503 可重试；与“空态”区分开。
	"METRICS_UNAVAILABLE",
	// 上下文快照子系统暂不可用 → 503 可重试。
	"CONTEXT_SNAPSHOT_UNAVAILABLE",
	// 查询参数非法（非本会话 id、无效 sequence/时间过滤）→ 422。
	"INVALID_METRICS_FILTER",
] as const;
export type AgentV2MetricsErrorCode = (typeof AGENT_V2_METRICS_ERROR_CODES)[number];

/** 错误码到 HTTP 状态与重试性的稳定映射（与 embed 错误表同构）。 */
export const AGENT_V2_METRICS_ERRORS: Readonly<
	Record<AgentV2MetricsErrorCode, { readonly httpStatus: number; readonly retryable: boolean }>
> = {
	METRICS_UNAVAILABLE: { httpStatus: 503, retryable: true },
	CONTEXT_SNAPSHOT_UNAVAILABLE: { httpStatus: 503, retryable: true },
	INVALID_METRICS_FILTER: { httpStatus: 422, retryable: false },
} as const;

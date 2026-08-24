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
 * - `ttftMs` 只算首个可展示文本增量（thinking/心跳/Tool 事件不算首 Token）；
 *   thinking 心跳摘要在 `admin-workbench-agents.ts` 的 reasoning 契约中处理，
 *   本模块只负责 `TurnMetrics` 度量与空值语义。
 * - 无文本输出、失败或取消时，`ttftMs`/`generationMs`/`outputTokensPerSecond`
 *   为 `null`，不得写成 0 混入平均值。
 * - 会话均值只统计“有值的成功轮次”，同时返回参与统计的样本数。
 * - 上下文快照在最终模型请求组装完成、发送之前生成；`breakdown` 分项之和
 *   必须能解释 `usedTokens`；无法使用精确 tokenizer 时标为 `estimated`。
 *
 * 事件顺序（M0 冻结）：`turn/start` → `context/snapshot` → `user/message` →
 * `assistant/start` → 首个可展示文本增量 → … → `turn/end`（携带 `TurnMetrics`）。
 * `context/snapshot` 必须在最终请求发送前持久化，查询端不得重新猜测历史值。
 */
import type { ConversationPublicId } from "./admin-workbench.ts";
import type { ReasoningEffort } from "./admin-workbench-agents.ts";

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

/**
 * 每轮性能度量（V2-README §4.1）。时间点为 IS08601/UTC 字符串；`*At` 为
 * 单调时钟打点后的 wall-clock 时间戳。派生字段的推导规则见
 * {@link deriveTurnMetrics}，请求端只约定与派生字段一致的空值语义。
 *
 * `totalLatencyMs` 为必填（`completed - requestStarted`）；其余派生字段在无
 * 文本输出/失败/取消时为 `null`。
 */
export interface TurnMetrics {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly requestStartedAt: string;
	readonly providerStartedAt: string;
	readonly firstOutputAt: string | null;
	readonly completedAt: string;
	readonly ttftMs: number | null;
	readonly generationMs: number | null;
	readonly totalLatencyMs: number;
	readonly outputTokensPerSecond: number | null;
}

/** `deriveTurnMetrics` 的输入：与持久事件一致的时间点 + Provider 权威 Token 数。 */
export interface TurnMetricTimings {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** 请求发起（表单提交/指令入口）。epoch ms。 */
	readonly requestStartedAt: number;
	/** Provider 请求开始。epoch ms。 */
	readonly providerStartedAt: number;
	/** 首个可展示文本增量。epoch ms；无则 `null`。 */
	readonly firstOutputAt: number | null;
	/** 结束/失败/取消打点。epoch ms。 */
	readonly completedAt: number;
}

/**
 * 从打点时间戳推导 `TurnMetrics`。纯函数、无副作用，供 M0 后端测试与前端
 * mock 共用同一公式；M1 采集在持久化前调用并以结果写 `turn/end` payload。
 *
 * 推导规则（与 V2-README §4.1 一致）：
 * - `ttftMs = firstOutputAt - providerStartedAt`，`firstOutputAt` 不存在则 `null`；
 * - `generationMs = completedAt - firstOutputAt`，`firstOutputAt` 不存在则 `null`；
 * - `totalLatencyMs = completedAt - requestStartedAt`（恒有值）；
 * - `outputTokensPerSecond = outputTokens / generationMs * 1000`，无输出或
 *   `generationMs` 不可用时为 `null`（不得写成 0）。
 */
export function deriveTurnMetrics(t: TurnMetricTimings): TurnMetrics {
	const totalLatencyMs = t.completedAt - t.requestStartedAt;
	const hasFirstOutput = t.firstOutputAt !== null && t.firstOutputAt >= t.providerStartedAt;
	const ttftMs = hasFirstOutput ? t.firstOutputAt! - t.providerStartedAt : null;
	const generationMs = hasFirstOutput ? t.completedAt - t.firstOutputAt! : null;
	const outputTokensPerSecond =
		hasFirstOutput && generationMs !== null && generationMs > 0 && t.outputTokens > 0
			? (t.outputTokens / generationMs) * 1000
			: null;
	return {
		inputTokens: t.inputTokens,
		outputTokens: t.outputTokens,
		cacheReadTokens: t.cacheReadTokens,
		cacheWriteTokens: t.cacheWriteTokens,
		requestStartedAt: new Date(t.requestStartedAt).toISOString(),
		providerStartedAt: new Date(t.providerStartedAt).toISOString(),
		firstOutputAt: t.firstOutputAt === null ? null : new Date(t.firstOutputAt).toISOString(),
		completedAt: new Date(t.completedAt).toISOString(),
		ttftMs,
		generationMs,
		totalLatencyMs,
		outputTokensPerSecond,
	};
}

/** `GET /api/control/v1/conversations/:id/metrics` 单轮明细行。 */
export interface ConversationTurnMetric {
	/** 持久事件 turn id（`turn_*`）。 */
	readonly turnId: string;
	/** 该轮 `turn/end` 事件的序列号；用于排序与分页。 */
	readonly sequence: number;
	readonly modelId: string;
	/** 该轮生效的会话思考覆盖（仅 reasoning；未覆盖/无则为 `null`）。 */
	readonly sessionEffort: ReasoningEffort | null;
	readonly metrics: TurnMetrics;
}

/** 单个数值字段在“有值样本”上的聚合（至少展示需保持该语义）。 */
export interface TurnMetricFieldStat {
	/** 有值样本上的算术均值；无数值样本时为 `null`。 */
	readonly mean: number | null;
	/** 参与均值/分位的有值样本数。 */
	readonly count: number;
	/** 有值样本上的分位数；样本不足或无数值时无法计算则为 `null`。 */
	readonly p50: number | null;
	readonly p95: number | null;
}

/** 单会话指标汇总。均值/分位只统计有值成功轮次，不把 null 写成 0 混入。 */
export interface ConversationMetricsStats {
	readonly available: boolean;
	/** 参与聚合的总轮数（含无值轮）。 */
	readonly turnCount: number;
	/** 有值、可用于均值的成功轮样本数。 */
	readonly sampleCount: number;
	readonly ttftMs: TurnMetricFieldStat;
	readonly generationMs: TurnMetricFieldStat;
	readonly totalLatencyMs: TurnMetricFieldStat;
	readonly outputTokensPerSecond: TurnMetricFieldStat;
}

/** `GET /api/control/v1/conversations/:id/metrics` 响应。 */
export interface ConversationMetricsResponse {
	readonly conversationId: ConversationPublicId;
	readonly stats: ConversationMetricsStats;
	/** 逐轮明细（按 sequence 升序；旧会话无指标时为 `[]`）。 */
	readonly items: readonly ConversationTurnMetric[];
}

/** `GET /api/control/v1/conversations/:id/context` 响应（返回最新一帧快照）。 */
export interface ConversationContextResponse {
	readonly conversationId: ConversationPublicId;
	readonly available: boolean;
	/** 旧会话无快照时为 `null`（不伪造 0）。 */
	readonly latest: ContextUsageSnapshot | null;
	/** 快照对应的 `context/snapshot` 事件序列号；无快照时为 `null`。 */
	readonly atSequence: number | null;
}

/**
 * 从逐轮明细计算单会话统计。任一字段按“有值样本”单独聚合；均值与分位只在
 * 该字段有值时计入。无任何有值样本的字段 `mean/count` 等返回空语义，整体
 * `available=false`。
 */
export function computeConversationMetricsStats(items: readonly ConversationTurnMetric[]): ConversationMetricsStats {
	const collect = (pick: (m: TurnMetrics) => number | null): number[] => {
		const values: number[] = [];
		for (const item of items) {
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
		sampleCount: items.filter((i) => i.metrics.totalLatencyMs !== null).length,
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

/**
 * 本里程碑数据集 / 上下文查询的稳定错误码（控制面错误信封
 * `ControlErrorEnvelope.error` 中的 `code`，见 `publishing/control-http.ts`）。
 * 跨租户/越权统一走既有 404 语义，不暴露资源归属。
 */
export const AGENT_V2_METRICS_ERROR_CODES = [
	// 会话从未采集到指标（旧会话 / 功能关闭），无数据可返回。
	"METRICS_UNAVAILABLE",
	// 会话从未生成上下文快照，无数据可返回。
	"CONTEXT_SNAPSHOT_UNAVAILABLE",
	// 查询参数非法（如非本会话 id、无效 sequence/时间过滤）。
	"INVALID_METRICS_FILTER",
] as const;
export type AgentV2MetricsErrorCode = (typeof AGENT_V2_METRICS_ERROR_CODES)[number];

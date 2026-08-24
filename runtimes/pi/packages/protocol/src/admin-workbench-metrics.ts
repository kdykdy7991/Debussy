/**
 * Agent 平台 V2：单会话统计、上下文快照与 reasoning 会话状态契约（V2-README §4）。
 *
 * 本模块是 M0 契约候选（待总架构师冻结），只定义共享 DTO、事件顺序/空值语义、
 * 错误码与纯函数推导规则；不包含采集或查询实现（M1）。冻结后前端可基于本模块
 * 建立 mock 并行开发。
 *
 * 契约口径（候选，不可在实现中静默漂移）：
 *
 * - Provider Usage 是 input/output/cache Token 的权威值；估算只用于上下文分项，
 *   不覆盖权威 Usage。
 * - 时间测量必须使用单调时钟（monotonic），与墙上时间（wall-clock，仅用于
 *   展示/追溯的 ISO 时间戳）显式分离，避免 NTP 跳变污染延迟推导。见
 *   {@link TurnMonotonicDelays} 与 {@link TurnWallClockStamps}。
 * - 单调时序必须满足 `providerStartDelayMs <= firstOutputDelayMs <= totalElapsedMs`
 *   （firstOutput 缺席除外）；乱序输入由 {@link validateTurnMonotonicOrder} 拒绝，
 *   `deriveTurnMetrics` 会抛错，而非静默忽略。
 * - `ttftMs` 只算首个可展示文本增量（thinking/心跳/Tool 事件不算首 Token）。
 * - 非 success 回合（failed/cancelled）以 `outcome` 标记，其
 *   `ttftMs`/`generationMs`/`outputTokensPerSecond` 为 `null`，不得写成 0 混入平均值。
 * - 会话均值只统计 `outcome === "success"` 的有值轮次，同时返回样本数
 *   （`sampleCount`）。failed/cancelled 不参与任何均值，包括 `totalLatencyMs`。
 * - 上下文快照在最终模型请求组装完成、发送之前生成；`breakdown` 分项之和必须
 *   能解释 `usedTokens`；无法使用精确 tokenizer 时标为 `estimated`。
 *
 * 事件顺序（候选）：`turn/start` → `context/snapshot` → `user/message` →
 * `assistant/start` → 首个可展示文本增量 → … → 终态事件。终态事件（写权威枚举）：
 * `turn/end` → success、`turn/failed` → failed、`turn/interrupted` → cancelled；
 * legacy 命名（`turn.end`/`turn.failed`/`turn.interrupted`）仅只读兼容映射。见
 * {@link turnOutcomeFromTerminalEvent} 与 `session-events.ts` 的 `SESSION_EVENT_TYPES`。
 */
import type { ConversationPublicId } from "./admin-workbench.ts";
import type { ReasoningEffort } from "./admin-workbench-agents.ts";
import type { Usage } from "./schemas.ts";

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

/** 单会话生效的 reasoning 会话状态（V2-README §4.3：会话 effort 持久化可恢复）。 */
export interface ConversationReasoningState {
	readonly conversationId: ConversationPublicId;
	/** 会话级思考强度覆盖；`null` = 使用 Agent Revision 默认值。 */
	readonly effort: ReasoningEffort | null;
	/** 最近一次覆盖的时间（ISO 8601 / UTC）。 */
	readonly updatedAt: string;
}

/**
 * `PUT /api/control/v1/conversations/:id/reasoning`（写权限边界见 doc 注释与 §5）。
 * `PATCH` 语义：设置单个 `effort`；请求体即本对象。
 */
export interface ReasoningUpdateRequest {
	/**
	 * 会话思考强度覆盖，取值须为当前模型能力目录声明的档位之一；
	 * `null` = 清除会话覆盖，回到 Agent Revision 默认值。
	 */
	readonly effort: ReasoningEffort | null;
}

/**
 * reasoning 更新端点稳定错误码（控制面 `ControlErrorEnvelope`）。
 */
export const AGENT_V2_REASONING_ERROR_CODES = [
	// 档位非法（不在模型能力目录声明档位内）。
	"REASONING_INVALID_EFFORT",
	// 调用方无权调整该会话的思考强度（权限边界见 §5）。
	"REASONING_NOT_CONFIGURABLE",
] as const;
export type AgentV2ReasoningErrorCode = (typeof AGENT_V2_REASONING_ERROR_CODES)[number];

/** reasoning 错误码到 HTTP 状态与重试性的稳定映射。 */
export const AGENT_V2_REASONING_ERRORS: Readonly<
	Record<AgentV2ReasoningErrorCode, { readonly httpStatus: number; readonly retryable: boolean }>
> = {
	REASONING_INVALID_EFFORT: { httpStatus: 422, retryable: false },
	REASONING_NOT_CONFIGURABLE: { httpStatus: 403, retryable: false },
} as const;

/**
 * 每次 reasoning 会话覆盖写入的审计动作。审计需记录 `before`/`after` 与最终生效
 * 快照（V2-README §4.3 审计要求），但不重复记录每个 Token 事件。
 */
export const AGENT_V2_REASONING_AUDIT_ACTION = "conversation.reasoning-updated" as const;
export type AgentV2ReasoningAuditAction = typeof AGENT_V2_REASONING_AUDIT_ACTION;

/**
 * reasoning 更新权限与审计边界（候选）：
 * - 管理员调试会话（admin-debug）：由控制面 Admin Token 授权更新；
 * - 已发布应用的企业会话：由会话属主（终端用户/Embed 会话）调整自己的会话；
 *   跨属主/无权限 → 403 `REASONING_NOT_CONFIGURABLE`；
 * - 每次更新写 `conversation.reasoning-updated` 审计事件（before/after + 生效快照）；
 * - 档位须在模型能力目录声明的支持档位内（`REASONING_INVALID_EFFORT` 422）；
 * - 会话 effort 可恢复、可审计，但不得改写 Agent Revision 或其它采样参数。
 */

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
 *
 * 有序约束：`0 <= providerStartDelayMs <= totalElapsedMs`；
 * `firstOutputDelayMs` 存在时须满足 `providerStartDelayMs <= firstOutputDelayMs
 * <= totalElapsedMs`。违反则由 {@link validateTurnMonotonicOrder} 拒绝。
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
 * 校验单调时序的有序性。返回错误列表；`deriveTurnMetrics` 依赖此函数拒绝乱序输入。
 * 合法顺序：`0 <= providerStartDelayMs <= totalElapsedMs`，且 `firstOutputDelayMs`
 * 存在时 `providerStartDelayMs <= firstOutputDelayMs <= totalElapsedMs`。
 */
export function validateTurnMonotonicOrder(monotonic: TurnMonotonicDelays): readonly string[] {
	const errors: string[] = [];
	if (!Number.isFinite(monotonic.providerStartDelayMs) || monotonic.providerStartDelayMs < 0) {
		errors.push("providerStartDelayMs must be a non-negative finite number");
	}
	if (!Number.isFinite(monotonic.totalElapsedMs) || monotonic.totalElapsedMs < monotonic.providerStartDelayMs) {
		errors.push("totalElapsedMs must be a finite number >= providerStartDelayMs");
	}
	if (monotonic.firstOutputDelayMs !== null) {
		if (!Number.isFinite(monotonic.firstOutputDelayMs)) {
			errors.push("firstOutputDelayMs must be null or a finite number");
		} else {
			if (monotonic.firstOutputDelayMs < monotonic.providerStartDelayMs) {
				errors.push("firstOutputDelayMs must be >= providerStartDelayMs");
			}
			if (monotonic.firstOutputDelayMs > monotonic.totalElapsedMs) {
				errors.push("firstOutputDelayMs must be <= totalElapsedMs");
			}
		}
	}
	return errors;
}

/**
 * 从单调延迟推导 `TurnMetrics`。纯函数、无副作用；乱序单调输入抛 `RangeError`，
 * 不会静默产生负值或 null。M1 采集在持久化前调用并以结果写 `turn/end` payload。
 *
 * 推导规则（与 V2-README §4.1 一致，全部基于单调时钟）：
 * - `ttftMs = firstOutputDelayMs - providerStartDelayMs`（仅 success 且首 Token 存在）；
 * - `generationMs = totalElapsedMs - firstOutputDelayMs`（同上，仅 success）；
 * - `totalLatencyMs = totalElapsedMs`（恒有值，但不用于 failed/cancelled 的均值）；
 * - `outputTokensPerSecond = outputTokens / generationMs * 1000`（仅 success 且
 *   generationMs>0 且 outputTokens>0，否则 `null`）。
 */
export function deriveTurnMetrics(input: TurnMetricsDerivationInput): TurnMetrics {
	const orderingErrors = validateTurnMonotonicOrder(input.monotonic);
	if (orderingErrors.length > 0) {
		throw new RangeError(`invalid monotonic turn timing: ${orderingErrors.join("; ")}`);
	}
	const successful = input.outcome === "success";
	const hasFirstOutput = successful && input.monotonic.firstOutputDelayMs !== null;
	const firstOutput = input.monotonic.firstOutputDelayMs;
	const ttftMs = hasFirstOutput ? (firstOutput as number) - input.monotonic.providerStartDelayMs : null;
	const generationMs = hasFirstOutput ? input.monotonic.totalElapsedMs - (firstOutput as number) : null;
	const outputTokensPerSecond =
		hasFirstOutput && generationMs !== null && generationMs > 0 && input.outputTokens > 0
			? (input.outputTokens / generationMs) * 1000
			: null;
	return {
		outcome: input.outcome,
		stamps: input.stamps,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		cacheReadTokens: input.cacheReadTokens,
		cacheWriteTokens: input.cacheWriteTokens,
		ttftMs,
		generationMs,
		totalLatencyMs: input.monotonic.totalElapsedMs,
		outputTokensPerSecond,
	};
}

/**
 * 终态事件到 `TurnOutcome` 的映射，冻结 legacy 只读兼容边界。
 * 权威关键为 `turn/end`、`turn/failed`、`turn/interrupted`；`turn.end`/`turn.failed`/
 * `turn.interrupted` 仅为存量只读别名。非终态事件返回 `null`。
 */
const TERMINAL_EVENT_TO_OUTCOME: Readonly<Record<string, TurnOutcome>> = {
	"turn/end": "success",
	"turn/failed": "failed",
	"turn/interrupted": "cancelled",
	"turn.end": "success",
	"turn.failed": "failed",
	"turn.interrupted": "cancelled",
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
	/** 既有：Provider 报告的用量对象（protocol `Usage`）。保留原有形状与读取路径。 */
	readonly usage?: Usage;
	/** V2 扩展：本轮性能度量。pre-V2 转向不写；failed/cancelled 亦可写（派生时序为 null）。 */
	readonly metrics?: TurnMetrics;
}

/** `GET /api/control/v1/conversations/:id/metrics` 查询参数（分页）。 */
export interface ConversationMetricsQuery {
	readonly conversationId: ConversationPublicId;
	/**
	 * 分页游标：返回 `sequence > afterSequence` 的轮；首页省略。
	 * 必须为不小于 1 的整数；非法值 → 422 `INVALID_METRICS_FILTER`。
	 */
	readonly afterSequence?: number;
	/**
	 * 每页上限：整数 `1..CONVERSATION_METRICS_MAX_LIMIT`，超上限钳制到 MAX；
	 * 缺省为 `CONVERSATION_METRICS_DEFAULT_LIMIT`。非正整数 → 422 `INVALID_METRICS_FILTER`。
	 */
	readonly limit?: number;
}

/** metrics 分页默认与上限（冻结；非法参数规则见 {@link resolveMetricsPage}）。 */
export const CONVERSATION_METRICS_DEFAULT_LIMIT = 50 as const;
export const CONVERSATION_METRICS_MAX_LIMIT = 200 as const;

/** `resolveMetricsPage` 结果：`error` 为冻结错误码（`INVALID_METRICS_FILTER`）。 */
export type MetricsPageResolve =
	| { readonly ok: true; readonly afterSequence: number; readonly limit: number }
	| { readonly ok: false; readonly error: "INVALID_METRICS_FILTER"; readonly message: string };

/**
 * 解析 metrics 分页参数并施以冻结规则（纯函数）：
 * - `afterSequence` 缺省为 0；提供时必须是正整数；
 * - `limit` 缺省为 `DEFAULT_LIMIT(50)`，提供时必须是正整数并钳制到 `MAX_LIMIT(200)`；
 * - 违反任一规则返回 `INVALID_METRICS_FILTER`。
 */
export function resolveMetricsPage(input: {
	readonly afterSequence?: number | undefined;
	readonly limit?: number | undefined;
}): MetricsPageResolve {
	if (input.afterSequence !== undefined && (!Number.isInteger(input.afterSequence) || input.afterSequence < 1)) {
		return { ok: false, error: "INVALID_METRICS_FILTER", message: "afterSequence must be a positive integer" };
	}
	if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
		return { ok: false, error: "INVALID_METRICS_FILTER", message: "limit must be a positive integer" };
	}
	const limit =
		input.limit === undefined
			? CONVERSATION_METRICS_DEFAULT_LIMIT
			: Math.min(input.limit, CONVERSATION_METRICS_MAX_LIMIT);
	return { ok: true, afterSequence: input.afterSequence ?? 0, limit };
}

/** `GET /api/control/v1/conversations/:id/metrics` 单轮明细行。 */
export interface ConversationTurnMetric {
	/** 持久事件 turn id（`turn_*`）。 */
	readonly turnId: string;
	/** 该轮终态事件的序列号；分页游标按此推进。 */
	readonly sequence: number;
	readonly modelId: string;
	/** 该轮生效的会话思考覆盖（仅 reasoning；未覆盖/无则为 `null`）。 */
	readonly sessionEffort: ReasoningEffort | null;
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

/**
 * 会话级指标汇总。均值/分位只统计 `outcome === "success"` 且有值的轮次，且必须在
 * **整个会话**的轮记录上计算，与当前返回页（`items`）无关。
 */
export interface ConversationMetricsStats {
	/** 会话至少存在一条轮记录。 */
	readonly available: boolean;
	/** 整个会话的总轮数（任意 outcome）。 */
	readonly turnCount: number;
	/** 整个会话 `outcome === "success"` 的轮数；是均值/分位的有效样本上界。 */
	readonly sampleCount: number;
	readonly ttftMs: TurnMetricFieldStat;
	readonly generationMs: TurnMetricFieldStat;
	readonly totalLatencyMs: TurnMetricFieldStat;
	readonly outputTokensPerSecond: TurnMetricFieldStat;
}

/**
 * `GET /api/control/v1/conversations/:id/metrics` 响应。
 *
 * 分页与统计分离：`items` 仅当前页（升序，`sequence in (afterSequence, nextAfterSequence]`）；
 * `stats` 是**整个会话**的聚合，服务端在完整轮记录上计算，**不得**从当前页
 * `items` 推导。
 *
 * 风格约定：请求带 `ConversationMetricsQuery`，响应的 `nextAfterSequence` 就是本页
 * 最后一轮的 `sequence`；请求下一页把 `afterSequence` 设为其值。`nextAfterSequence`
 * 为 `null` 表示没有更多轮。
 *
 * 空态：会话存在但无指标数据时返回 HTTP 200 且 `stats.available=false`、`items=[]`
 * （这不是错误）。
 */
export interface ConversationMetricsResponse {
	readonly conversationId: ConversationPublicId;
	readonly stats: ConversationMetricsStats;
	/** 当前页逐轮明细（升序）。 */
	readonly items: readonly ConversationTurnMetric[];
	/** 下一页游标（本页最后一轮 sequence）；无更多数据时为 `null`。 */
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
 * 从完整轮记录聚合会话统计（服务端在全会话上调用，不依赖分页）。均值与分位只统计
 * `outcome === "success"` 且有值的轮次；failed/cancelled 一律不参与（包括
 * `totalLatencyMs`）。
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

/** 本里程碑数据集 / 上下文路线的稳定错误码（控制面错误信封 `ControlErrorEnvelope`）。 */
export const AGENT_V2_METRICS_ERROR_CODES = [
	// 指标子系统暂不可用（特性关闭/服务不可达）→ 503 可重试；与“空态”（200 available=false）区分。
	"METRICS_UNAVAILABLE",
	// 上下文快照子系统暂不可用 → 503 可重试。
	"CONTEXT_SNAPSHOT_UNAVAILABLE",
	// 查询参数非法（非本会话 id、无效 sequence）→ 422。
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

/**
 * 空态与 unavailable 的分界（候选）：
 * - 会话存在但无指标/快照数据 → HTTP 200 `available=false`（非错误）；
 * - 指标/上下文子系统暂不可用 → HTTP 503 `METRICS_UNAVAILABLE`/`CONTEXT_SNAPSHOT_UNAVAILABLE`；
 * - 会话不存在或跨租户越权 → HTTP 404 `CONVERSATION_NOT_FOUND`（既有语义，不暴露归属）。
 */

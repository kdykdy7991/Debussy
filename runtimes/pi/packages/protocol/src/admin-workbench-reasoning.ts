/**
 * Agent 平台 V2：会话 reasoning effort 契约（V2-README §4.3）。候选，待总架构师冻结。
 *
 * **独立于 Metrics/Context 契约**（Admin-Workbench Metrics M0-A 已冻结）；本模块只定义
 * 会话级思考强度覆盖：状态读取、更新、错误码、审计与事实源。无采集实现（M1）。
 *
 * ## 两个入口，共享同一服务语义（第 4 轮裁定）
 *
 * 会话 effort 可由两类主体调整，两个 Http 入口不同但落到同一个服务操作
 * （`setConversationSessionEffort`），仅授权门不同，避免把 Control Admin 与 Embed
 * 会话权限混在一个路由里：
 *
 * - **控制面管理员**：`GET + PUT /api/control/v1/conversations/:conversationId/reasoning`
 *   （Admin Token；用于 admin-debug/管理员调试会话）。
 * - **Embed 属主**：`GET + PUT /api/embed/v1/conversations/:conversationId/reasoning`
 *   （会话属主 Embed principal 读取或调整自己的会话；GET 与 Control 面复用
 *   {@link ConversationReasoningState}）。
 *
 * 两者请求体都是 {@link ReasoningUpdateRequest}，返回 {@link ConversationReasoningState}
 * （PUT 幂等；请求体即 `ReasoningUpdateRequest`）。
 *
 * ## capability 数据源（契约已冻结）
 *
 * capability 与 `effort` **同 DTO 原子返回**——`GET /reasoning` 的响应里嵌
 * `pinnedCapability: { publishedAppVersionId, modelId, reasoning }`，由会话
 * 创建时一次性写入 `Published App Version`，**不**查实时 LLM catalog。
 * 不提供独立 `GET /conversations/{id}/capability` 端点。
 *
 * ## 授权与 404/403 语义
 *
 * - **跨租户 / 跨属主**（会话不属于调用方可访问的范围）→ 统一 **404
 *   `CONVERSATION_NOT_FOUND`**，不暴露会话归属/存在性；
 * - **403 `REASONING_NOT_CONFIGURABLE`** 仅用于：会话属主（或具访问权的调用方）是
 *   合法主体，但**策略禁止其调整**（如租户/企业策略对该会话关闭了 reasoning 调整）。
 *
 * ## 事实源与审计分离（第 4 轮裁定）
 *
 * - **事实源（恢复/查询读这里）**：专用持久状态 `conversation_reasoning_state`
 *   （`conversationId → effort/updatedAt/updatedBy`），更新即写，读取/会话恢复与
 *   `GET .../reasoning` 都从它读。它不是 `conversation_events`。
 * - **审计日志**：`conversation.reasoning-updated` 是**独立只追加审计日志**（audit
 *   store），记录 `before/after` + 最终生效快照 + principal，用于问责。它**不是
 *   `conversation_events` 事件类型**、不进 `SESSION_EVENT_TYPES`、不推进事件序列号、
 *   不参与 turn 回放。commit（写事实源）与 audit（追加日志）在服务层同一事务内完成。
 */
import type { ConversationPublicId, PublishedAppVersionPublicId } from "./admin-workbench.ts";
import type { ReasoningEffort } from "./admin-workbench-agents.ts";
import type { ModelParameterCapabilities } from "./admin-workbench-llm.ts";

/** 会话 effort 的两个授权平面。 */
export type ReasoningPrincipalType = "admin" | "embed-owner";

/** 谁发起的更新（进入审计）。 */
export interface ReasoningPrincipal {
	readonly type: ReasoningPrincipalType;
	readonly id: string;
}

/** 两个更新入口（第 4 轮拆分；共享服务语义）。 */
export const AGENT_V2_REASONING_UPDATE_PATHS: Readonly<{
	readonly control: string;
	readonly embed: string;
}> = {
	control: "/api/control/v1/conversations/:conversationId/reasoning",
	embed: "/api/embed/v1/conversations/:conversationId/reasoning",
} as const;
export type AgentV2ReasoningUpdatePath =
	(typeof AGENT_V2_REASONING_UPDATE_PATHS)[keyof typeof AGENT_V2_REASONING_UPDATE_PATHS];

/** 当前生效 effort 的事实源（恢复/查询读这里；非事件日志）。 */
export const AGENT_V2_REASONING_FACT_STORE = "conversation_reasoning_state" as const;

/** 单会话生效的 reasoning 会话状态（V2-README §4.3：会话 effort 持久化可恢复）。 */
export interface ConversationReasoningState {
	readonly conversationId: ConversationPublicId;
	/** 会话级思考强度覆盖；`null` = 使用 Agent Revision 默认值。 */
	readonly effort: ReasoningEffort | null;
	/** 最近一次覆盖的时间（ISO 8601 / UTC）。 */
	readonly updatedAt: string;
	/**
	 * 会话是否允许覆盖（`pinnedCapability !== null`）。`false` 时
	 * capability 永远 unavailable，UI 禁用编辑入口；前端不引入额外
	 * 状态分支（与协议冻结状态一致）。
	 */
	readonly configurable: boolean;
	/**
	 * Capability 快照，发布时一次性写入 Published App Version；
	 * **不**查实时 LLM catalog。`null` 即"该版本没沉淀 capability"，
	 * 与 `configurable:false` 等价触发 unavailable（legacy 分支）。
	 */
	readonly pinnedCapability: {
		readonly publishedAppVersionId: PublishedAppVersionPublicId;
		readonly modelId: string;
		readonly reasoning: ModelParameterCapabilities["reasoning"];
	} | null;
}

/**
 * 更新请求体（两个入口共用）。PUT 语义（幂等）：设置单个 `effort`；请求体即本对象。
 */
export interface ReasoningUpdateRequest {
	/**
	 * 会话思考强度覆盖，取值须为当前模型能力目录声明的档位之一；
	 * `null` = 清除会话覆盖，回到 Agent Revision 默认值。
	 */
	readonly effort: ReasoningEffort | null;
}

/**
 * 每次覆盖写入的审计日志条目（append-only audit store）。`before` 为写入前持久状态值，
 * `after` 为写入后值；最终生效快照即 `after`（或清除后回落到 Revision 默认）。
 */
export interface ReasoningEffortAuditRecord {
	readonly action: typeof AGENT_V2_REASONING_AUDIT_ACTION;
	readonly conversationId: ConversationPublicId;
	readonly principal: ReasoningPrincipal;
	readonly before: ReasoningEffort | null;
	readonly after: ReasoningEffort | null;
	readonly requestedAt: string;
	readonly auditEventId: string;
}

/**
 * reasoning 更新端点稳定错误码（控制面 `ControlErrorEnvelope`）。
 */
export const AGENT_V2_REASONING_ERROR_CODES = [
	// 档位非法（不在模型能力目录声明档位内）。
	"REASONING_INVALID_EFFORT",
	// 合法属主/具访问权，但策略禁止其调整该会话思考强度。
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

/** 覆盖审计动作标识；是**审计日志**动作，不是 `conversation_events` 事件类型。 */
export const AGENT_V2_REASONING_AUDIT_ACTION = "conversation.reasoning-updated" as const;
export type AgentV2ReasoningAuditAction = typeof AGENT_V2_REASONING_AUDIT_ACTION;

/**
 * 更新边界（候选）：
 * - 跨租户 / 跨属主 → 统一 **404 `CONVERSATION_NOT_FOUND`**（不暴露归属）；
 * - **403 `REASONING_NOT_CONFIGURABLE`** 仅表示合法属主但策略禁止调整；
 * - 控制面管理员：Admin Token 授权（debug/管理员调试会话）；
 * - Embed 属主：会话属主调整自己的会话；策略禁止 → 403 `REASONING_NOT_CONFIGURABLE`；
 * - 档位须在模型能力目录声明支持档位内（`REASONING_INVALID_EFFORT` 422）；
 * - 写事实源（`conversation_reasoning_state`）与追加审计在同一 **PostgreSQL 事务**；
 *   审计不参与 turn 回放；
 * - 会话 effort 可写入/恢复/审计，但不得改写 Agent Revision 或其它采样参数。
 */

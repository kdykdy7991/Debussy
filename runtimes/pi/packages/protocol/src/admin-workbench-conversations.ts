/**
 * Admin Workbench 用户会话控制台契约（WB-006 / SPEC §5.4）。
 *
 * 与持久化实体 `ConversationRecord` 的关系（WB-000 §3.1）：
 *
 *     UI ConversationAdminSummary = ConversationRecord 的管理员投影
 *
 * 协议命名沿用现有 `Conversation` 词汇，避免与持久化层混用第二套名称。
 *
 * 约束（spec §15.3 + §18）：
 *
 * - `id` / `appId` / `principalDisplayId` / `versionId` / `agentId` 全部为
 *   `*PublicId` template literal 类型，传输层禁止裸 UUID
 * - 默认列表 **不**返回消息正文（`messageCount` 仅是计数）
 * - 列表响应携带 `redacted: true` 标识，告知 UI 不要展示消息正文
 * - 详情/事件/附件请求必须经过控制面 Admin Token，不复用 Embed Bearer Token
 * - 跨 tenant / app / principal 越权统一返回 404，不区分 not-found 与
 *   cross-scope
 *
 * 审计：每次进入正文（Transcript/Event Log/附件）由服务端写
 * `admin.conversation.readed` 审计事件（spec §13.4）。
 */
import type {
	ConversationAdminSummary,
	ConversationEventPublicId,
	ConversationPublicId,
	PublishedAppPublicId,
	PublishedAppVersionPublicId,
} from "./admin-workbench.ts";
import type { SessionEventType } from "./session-events.ts";

/** Filter for the administrator conversation list endpoint. */
export interface ConversationListFilter {
	/** Restrict to one published app (admin_workbench/control API). */
	readonly appId?: PublishedAppPublicId;
	/** Restrict to conversations started after this inclusive timestamp (ISO 8601). */
	readonly createdAfter?: string;
	/** Restrict to conversations last active before this inclusive timestamp (ISO 8601). */
	readonly createdBefore?: string;
	/** Restrict to a status (`active`/`archived`/`deleted`). Unknown values are ignored. */
	readonly status?: "active" | "archived" | "deleted";
	/** Restrict to conversations anchored to a specific PublishedAppVersion. */
	readonly publishedAppVersionId?: PublishedAppVersionPublicId;
	/** Restrict to conversations with at least one error event. */
	readonly hasErrors?: boolean;
	/** Restrict to anonymous or signed-user principals only. */
	readonly principalType?: "external_user" | "anonymous_visitor";
	/** Case-insensitive match on conversation id (bare or `conv_` prefix), title, app name or `prn_` display id. */
	readonly search?: string;
	/** Inclusive lower bound on last-active time (ISO 8601). */
	readonly lastActiveAfter?: string;
	/** Inclusive upper bound on last-active time (ISO 8601). */
	readonly lastActiveBefore?: string;
}

/** Admin conversation list envelope; never includes raw payloads. */
export interface ConversationAdminListResponse {
	readonly items: readonly ConversationAdminSummary[];
	readonly nextCursor: string | null;
	/** Sentinel that the response is the redacted admin view; UI must fetch /events for bodies. */
	readonly redacted: true;
}

/**
 * Admin conversation event view; the payload is the JSON-decoded event
 * payload, but unknown event types are surfaced with `kind = "unknown"` so
 * the UI can render a safe placeholder instead of crashing.
 */
export type AdminConversationEventKind = SessionEventType | "unknown";

export interface ConversationAdminEvent {
	readonly eventId: ConversationEventPublicId;
	readonly conversationId: ConversationPublicId;
	readonly sequence: number;
	readonly eventType: string;
	readonly kind: AdminConversationEventKind;
	readonly schemaVersion: number;
	readonly turnId: string | null;
	readonly payload: unknown;
	readonly createdAt: string;
	readonly payloadBytes: number;
}

/**
 * Cursor-paginated event list. Always scoped by `(tenant, app, conversation)`
 * server-side; clients must pass `afterSequence` to page forward.
 */
export interface ConversationAdminEventListResponse {
	readonly conversationId: ConversationPublicId;
	readonly items: readonly ConversationAdminEvent[];
	readonly lastEventSequence: number;
	readonly throughSequence: number;
	readonly nextAfterSequence: number | null;
}

/**
 * Summary snapshot surfaced to the admin UI; mirrors the persisted summary
 * row but with public IDs and ISO timestamps. Multiple summaries per
 * conversation are returned newest-first; `latest` is the most recent.
 */
export interface ConversationAdminSummaryEntry {
	readonly summaryId: string;
	readonly throughSequence: number;
	readonly modelId: string;
	readonly sourceEventCount: number;
	readonly sourceBytes: number;
	readonly lastUserMessage: string;
	readonly keyFacts: readonly string[];
	readonly openItems: readonly string[];
	readonly createdAt: string;
}

export interface ConversationAdminSummaryListResponse {
	readonly conversationId: ConversationPublicId;
	readonly items: readonly ConversationAdminSummaryEntry[];
	readonly latest: ConversationAdminSummaryEntry | null;
	readonly rollover: {
		readonly previousConversationId: string | null;
		readonly nextConversationId: string | null;
		readonly rolledOverAt: string | null;
	};
}

/**
 * Audit event written when an admin reads a conversation's body, events or
 * attachments. The server records `actor`, `resourceId` (= conversationId),
 * `action` (read-events / read-summary / read-attachments / export…) and the
 * `requestId`. The protocol type is exposed so dashboards / log scrapers
 * can decode the wire shape.
 */
export const ADMIN_CONVERSATION_READ_ACTIONS = [
	"conversation.read-events",
	"conversation.read-summary",
	"conversation.read-attachments",
	"conversation.read-transcript",
	"conversation.read-llm-call",
	"conversation.exported",
] as const;
export type AdminConversationReadAction = (typeof ADMIN_CONVERSATION_READ_ACTIONS)[number];

/**
 * WB-006: administrator attachment view for a conversation. Metadata only —
 * never the object store key or checksum (those are storage internals; the
 * control plane has no download surface in MVP). `status` is ready|staged.
 */
export interface ConversationAdminAttachment {
	readonly attachmentId: string;
	readonly conversationId: ConversationPublicId;
	readonly filename: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly status: "ready" | "staged" | string;
	readonly createdAt: string;
}

export interface ConversationAdminAttachmentListResponse {
	readonly conversationId: ConversationPublicId;
	readonly items: readonly ConversationAdminAttachment[];
}

/**
 * WB-009: conversation export modes. The archive is a single gzip-compressed
 * JSONL stream (`session.jsonl.gz`); each line is a versioned object.
 */
export const CONVERSATION_EXPORT_MODES = ["full", "diagnostics", "transcript"] as const;
export type ConversationExportMode = (typeof CONVERSATION_EXPORT_MODES)[number];

/**
 * First JSONL line of every export; freezes the export boundary so events
 * appended after export starts are never included in this archive.
 */
export interface ConversationExportManifest {
	readonly v: 1;
	readonly kind: "manifest";
	readonly exportVersion: "wb009-1";
	readonly conversationId: ConversationPublicId;
	readonly mode: ConversationExportMode;
	readonly throughSequence: number;
	readonly generatedAt: string;
}

/*
 * Session V1 — admin Session 详情页契约。
 *
 * 原则：默认详情只带会话概要与任务输入，绝不带任何一次 LLM 请求的完整
 * Request/Response。逐次调用以摘要列表提供，原文只在显式点击后按单条读取。
 * 原始事实源仍是 append-only 的 `conversation_events`；`llmCalls` 摘要来自
 * 编排侧的 provider 边界记录，Chat 会话没有该记录时如实标注"未采集"。
 */

/** 逐次请求记录状态。`incomplete` / `unknown` 一律不得当作完整记录。 */
export type ConversationLlmCallStatus = "completed" | "failed" | "interrupted" | "incomplete" | "unknown";

/** Trace 完整性：只有与 `llmUsage.callCount` 核对一致且无 partial 轮次才允许 `complete`。 */
export type ConversationLlmTraceCoverage = "complete" | "partial" | "unknown";

export type ConversationLlmTraceReason = "collected" | "table_missing" | "no_records" | "chat_untraced";

export interface ConversationLlmTraceStatus {
	/** 表存在且本会话确实有逐次请求记录。 */
	readonly available: boolean;
	readonly reason: ConversationLlmTraceReason;
	readonly recordedCalls: number;
	/** 来自 `turn/end.payload.llmUsage.callCount`；`null` = 无法核对。 */
	readonly expectedCalls: number | null;
	readonly coverage: ConversationLlmTraceCoverage;
}

/** 会话详情（默认响应）。任务输入单独给出，避免把内部触发消息当业务输入。 */
export interface ConversationAdminDetailResponse {
	readonly conversation: ConversationAdminSummary;
	readonly rollover: {
		readonly previousConversationId: string | null;
		readonly nextConversationId: string | null;
		readonly rolledOverAt: string | null;
	};
	readonly latestSummary: ConversationAdminSummaryEntry | null;
	readonly source: "chat" | "orchestration";
	/** AaaS 持久化请求契约；`legacy_prompt` 表示 task_prompt 覆盖 System Prompt。 */
	readonly requestContract: string | null;
	/** 仅 `legacy_prompt` 契约有值；其它契约/Chat 直接使用 `user/message` 事件。 */
	readonly taskInput: { readonly kind: "external_task"; readonly text: string } | null;
	readonly trace: ConversationLlmTraceStatus;
}

/** 单条 LLM 调用的轻量摘要，不含任何原始 payload。 */
export interface ConversationAdminLlmCallSummary {
	readonly turnId: string;
	readonly callIndex: number;
	readonly model: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	/** 记录时间差（含落库往返），仅作参考。 */
	readonly durationMs: number | null;
	readonly status: ConversationLlmCallStatus;
	readonly messageCount: number | null;
	readonly systemPromptChars: number | null;
	readonly toolCallIds: readonly string[];
	readonly toolCallNames: readonly string[];
	readonly responsePreview: string | null;
	readonly hasRawPayload: boolean;
}

export interface ConversationAdminLlmCallListResponse {
	readonly conversationId: ConversationPublicId;
	readonly items: readonly ConversationAdminLlmCallSummary[];
	/** 整数偏移量游标；`null` 表示已到末尾。 */
	readonly nextCursor: string | null;
	readonly trace: ConversationLlmTraceStatus;
}

/** 按需读取的单条原文。`redacted=true` 表示出站做过敏感值替换（库内原文不变）。 */
export interface ConversationAdminLlmCallDetailResponse {
	readonly conversationId: ConversationPublicId;
	readonly turnId: string;
	readonly callIndex: number;
	readonly model: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly request: unknown;
	readonly response: unknown | null;
	readonly redacted: boolean;
}

/** Provider 报告的 Token 分项。`null` = 未采集/未知，禁止显示成 0。 */
export interface ConversationSessionUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly reasoning: number | null;
}

/** 逐次 LLM 用量调用终态；unknown = 只看到调用发起边界，无法判定结果。 */
export type ConversationSessionCallStatus = "completed" | "failed" | "aborted" | "unknown";

/**
 * Runtime 在 provider 调用边界观察到的单次请求耗时。`durationMs` 由单调时钟
 * 相减得到，是 Runtime 观察到的请求生命周期耗时，不等于模型内部纯推理时间；
 * 两个时间戳是墙钟观察值，仅用于展示与排序。`null`/缺省表示该次调用未采集到
 * 可靠的响应边界，不按 0 处理。
 */
export interface ConversationSessionLlmCallTiming {
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly durationMs: number;
	/** 首个有效生成增量相对请求开始的单调延迟；无有效生成事件时缺省（未知）。 */
	readonly firstOutputLatencyMs?: number;
}

/** 逐次 LLM 用量；上下文规模 = `input + cacheRead`（不含 cacheWrite）。 */
export interface ConversationSessionLlmCallUsage {
	readonly turnId: string | null;
	/** 展示序号（该 Turn 内 calls[] 的数组位置，1-based），不是稳定身份，不可用于关联。 */
	readonly index: number;
	/**
	 * 稳定的 Turn 内调用编号，与 AaaS Trace 的 `call_index` 同源（由 Runtime 在
	 * provider 调用边界分配，重试分配新编号）。`null` = 历史数据/无该调用的权威
	 * Trace，无法可靠关联；不得用 `index` 或完成顺序回填。
	 */
	readonly callIndex: number | null;
	readonly model: string | null;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	/** Explicit zero and historical positive counts are known. */
	readonly cacheReadReported?: boolean;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly reasoning: number | null;
	readonly contextTokens: number | null;
	/**
	 * 单次请求的 Prompt Token = `input + cacheRead + cacheWrite`。
	 * 这是该次请求发给模型的 prompt 规模（不含 output），与跨调用的累计消耗不同口径。
	 * `null` = 该次调用缺少可靠分项用量，不能按 0 处理，也不能用字符数估算回填。
	 */
	readonly promptTokens: number | null;
	/**
	 * 该次调用的终态。历史记录没有此字段时按 "completed" 兼容（旧采集只记录
	 * completed 的 assistant item），不凭数组位置或完成顺序推断。
	 */
	readonly status: ConversationSessionCallStatus;
	/**
	 * provider 是否为该次调用返回了可用 Token 分项。false 时所有数值 Token 均为
	 * 未知，不按 0 处理，也不计入累计；历史记录缺省视为 true（旧采集仅在有
	 * usage 时才记录该调用）。
	 */
	readonly usageReported: boolean;
	/** Runtime 观察到的单次请求耗时；历史数据或缺响应边界时缺省（未知）。 */
	readonly timing?: ConversationSessionLlmCallTiming;
	/**
	 * `timing.durationMs - timing.firstOutputLatencyMs`。仅当单调计时有效、
	 * generationMs > 0 且响应边界完整时可得。是 Runtime 客户端从首个有效生成
	 * 增量到响应完成的观察时长，不是模型内部纯推理时间。null = 未知，不是 0。
	 */
	readonly generationMs: number | null;
	/**
	 * `output × 1000 / generationMs`。单位为 token/s，仅在 Provider output
	 * Token 可靠且 generationMs > 0 时计算。这是 Runtime 客户端观察值，不是
	 * 模型内部 decode TPS。null = 未知，不是 0。
	 */
	readonly observedOutputTps: number | null;
	readonly precision: "reported" | "partial";
}

export type ConversationSessionTurnPrecision = "per_call" | "partial" | "legacy_last_call" | "missing";

export interface ConversationSessionTurnUsage {
	readonly turnId: string | null;
	readonly sequence: number;
	readonly precision: ConversationSessionTurnPrecision;
	readonly callCount: number;
	readonly partial: boolean;
	readonly totals: ConversationSessionUsageTotals | null;
}

/** Session 级用量汇总。`totals=null` 表示没有任何 Turn 提供逐次 llmUsage。 */
export interface ConversationSessionUsageResponse {
	readonly conversationId: ConversationPublicId;
	/**
	 * 各 Turn 已上报调用用量的合计（已确认消耗），包括 partial 与 interrupted Turn
	 * 中已确认的部分；不与逐次明细重复累加。它不代表全部实际消耗——未上报用量
	 * 的调用保持未知且不填 0。完整性由 `accurateTurns`/`partialTurns`/`trace` 表达。
	 */
	readonly totals: ConversationSessionUsageTotals | null;
	readonly calls: readonly ConversationSessionLlmCallUsage[];
	readonly turns: readonly ConversationSessionTurnUsage[];
	readonly accurateTurns: number;
	readonly partialTurns: number;
	readonly legacyTurns: number;
	readonly missingTurns: number;
	readonly toolCallCount: number;
	readonly toolErrorCount: number;
	/**
	 * 最近一次 LLM 调用的 Prompt Token（按 turn/end 事件顺序取最后一次调用）。
	 * 该调用缺少可靠用量时为 null，不回退到更早的调用、不伪造 0。
	 */
	readonly latestPromptTokens: number | null;
	/** 所有可测调用中的最大 Prompt Token；没有任何可测调用时为 null。 */
	readonly peakPromptTokens: number | null;
	readonly trace: ConversationLlmTraceStatus;
	readonly notes: readonly string[];
}

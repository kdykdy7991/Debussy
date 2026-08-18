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

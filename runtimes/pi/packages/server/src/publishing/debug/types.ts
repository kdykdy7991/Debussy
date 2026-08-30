/**
 * Debug Conversation Phase 1 domain types (admin workbench).
 *
 * A Debug Conversation is scoped by `(tenant, agent, owner)` instead of the
 * Production `(tenant, published app, owner principal)` triple. It has no
 * published version and its events are appended to an independent table, kept
 * physically separate from the Production event stream so admin debug history
 * can never pollute production metrics, admin lists, or usage aggregation.
 */
import type {
	AgentDefinitionId,
	DebugConversationEventId,
	DebugConversationId,
	PrincipalId,
	TenantId,
	TurnId,
} from "../domain/ids.ts";

export type DebugConversationStatus = "active" | "deleted";

export interface DebugConversationRecord {
	readonly debugConversationId: DebugConversationId;
	readonly tenantId: TenantId;
	readonly agentId: AgentDefinitionId | null;
	readonly ownerPrincipalId: PrincipalId;
	readonly status: DebugConversationStatus;
	readonly lastEventSequence: number;
	readonly createdAt: Date;
	readonly lastActiveAt: Date;
	/** Set only by the Phase 2F expire step; NULL while active. */
	readonly deletedAt: Date | null;
}

/**
 * Scope for GC lifecycle operations. Physical deletion, soft expiry and the
 * deleted-list scan are always confined to one (tenant, owner) so a GC pass can
 * never touch another tenant's or another owner's conversations.
 */
export interface DebugConversationGcScope {
	readonly tenantId: TenantId;
	readonly ownerPrincipalId: PrincipalId;
}

/** Scope for conversation reads: tenant + owner + (nullable) agent. */
export interface DebugConversationScope {
	readonly tenantId: TenantId;
	readonly ownerPrincipalId: PrincipalId;
	readonly agentId: AgentDefinitionId | null;
}

/** Scope for a single conversation: tenant + owner + conversation id. */
export interface DebugConversationRef {
	readonly tenantId: TenantId;
	readonly ownerPrincipalId: PrincipalId;
	readonly debugConversationId: DebugConversationId;
}

/**
 * Phase 2E: parameters for the per-agent History list. The list is always
 * scoped to `(tenant, owner, agent)` and orders by `last_active_at DESC, id DESC`
 * so the most recently active conversation sits on top. Pagination is not part
 * of the MVP — the limit is hard-capped at 100 by the service layer and the
 * History panel renders a finite, scrollable window.
 */
export interface DebugConversationListParams {
	readonly tenantId: TenantId;
	readonly ownerPrincipalId: PrincipalId;
	readonly agentId: AgentDefinitionId | null;
	readonly limit: number;
}

/**
 * Phase 2E: per-row projection for the History list. The first-user-message
 * preview is joined in the same query (LATERAL on `debug_conversation_events`)
 * so the list endpoint stays a single round trip — no N+1 follow-up calls.
 * `null` preview means the conversation exists but has not yet recorded any
 * `user/message` event (e.g. an empty binding created by lazy-create that has
 * never sent).
 */
export interface DebugConversationListItem {
	readonly conversation: DebugConversationRecord;
	readonly firstUserMessagePreview: string | null;
}

/** Append-only Debug event row; shape aligned with the Production event log. */
export interface DebugConversationEventRecord {
	readonly eventId: DebugConversationEventId;
	readonly debugConversationId: DebugConversationId;
	readonly sequence: number;
	readonly eventType: string;
	readonly eventSchemaVersion: number;
	readonly turnId: TurnId | null;
	readonly payload: unknown;
	readonly createdAt: Date;
}

export interface DebugConversationEventInput {
	readonly eventType: string;
	readonly eventSchemaVersion?: number;
	readonly turnId?: TurnId | null;
	readonly payload: unknown;
	/**
	 * UTF-8 byte length of `payload`; when 0 the repository recomputes it (so
	 * a future counter can advance in the same transaction without re-reading).
	 */
	readonly payloadBytes?: number;
}

export interface DebugConversationEventListParams {
	readonly limit: number;
	readonly afterSequence?: number;
}

export interface DebugConversationRepository {
	/** Insert a new active conversation. */
	insert(record: DebugConversationRecord): Promise<void>;
	/** Most recent `active` conversation for a (owner, agent) scope, if any. */
	getRecentActive(scope: DebugConversationScope): Promise<DebugConversationRecord | undefined>;
	/** Fetch a conversation by tenant + id (returns deleted rows too). */
	getByRef(scope: DebugConversationRef): Promise<DebugConversationRecord | undefined>;
	/** Discard writer: mark a conversation deleted (reserved for Phase 2 GC). */
	setStatus(scope: DebugConversationRef, status: "deleted"): Promise<boolean>;
	/**
	 * Phase 2E: list active conversations for the (owner, agent) scope, ordered
	 * by most recent activity, with the first `user/message` event's payload
	 * text joined in the SAME query (no N+1). The repository implementation
	 * uses a LATERAL subquery to keep the preview extraction in one round
	 * trip. `limit` is the only pagination knob in the MVP; the service layer
	 * clamps it to a sane upper bound.
	 */
	listByScope(params: DebugConversationListParams): Promise<readonly DebugConversationListItem[]>;
	/**
	 * Soft-delete every `active` conversation for the (tenant, owner) scope whose
	 * `last_active_at` is older than `cutoff`: `status='deleted'` + `deleted_at`.
	 * The conditional UPDATE is atomic against a concurrent `append` (turn/start)
	 * on the same row — exactly one of the two wins at the DB level. Returns the
	 * conversation ids that were expired.
	 */
	expireActiveBefore(scope: DebugConversationGcScope, cutoff: Date): Promise<readonly DebugConversationId[]>;
	/** Soft-deleted conversations for the scope whose `deleted_at` is older than `cutoff`. */
	listDeletedBefore(scope: DebugConversationGcScope, cutoff: Date): Promise<readonly DebugConversationRecord[]>;
	/**
	 * Physically remove one soft-deleted conversation: its `debug_conversation_events`
	 * rows then its parent row, in one transaction. Idempotent: no-op when the
	 * conversation is gone or no longer scoped.
	 */
	deletePhysical(scope: DebugConversationRef, conversationId: DebugConversationId): Promise<boolean>;
}

export interface DebugConversationEventRepository {
	/**
	 * Atomically append one event: bump `debug_conversations.last_event_sequence`
	 * and insert the row in ONE transaction (mirrors the Production sequence
	 * machine against the Debug parent table). Returns undefined when the
	 * conversation is missing / out of scope / not active.
	 */
	append(
		scope: DebugConversationRef,
		conversationId: DebugConversationId,
		input: DebugConversationEventInput,
	): Promise<DebugConversationEventRecord | undefined>;
	/** List events in sequence order for incremental replay / context restore. */
	list(
		scope: DebugConversationRef,
		params: DebugConversationEventListParams,
	): Promise<readonly DebugConversationEventRecord[]>;
}

export interface DebugRepositories {
	readonly conversations: DebugConversationRepository;
	readonly events: DebugConversationEventRepository;
}

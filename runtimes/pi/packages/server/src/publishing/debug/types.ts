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
}

/** Scope for conversation reads: tenant + owner + (nullable) agent. */
export interface DebugConversationScope {
	readonly tenantId: TenantId;
	readonly ownerPrincipalId: PrincipalId;
	readonly agentId: AgentDefinitionId | null;
}

/** Scope for a single conversation's reads: tenant + conversation id. */
export interface DebugConversationRef {
	readonly tenantId: TenantId;
	readonly debugConversationId: DebugConversationId;
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

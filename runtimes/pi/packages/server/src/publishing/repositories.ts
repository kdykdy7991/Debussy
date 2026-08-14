/**
 * Scoped repository contracts for the publishing/embed planes.
 *
 * Spec section 13.2: every repository query must carry an explicit
 * `ResourceScope` and scope conditions are enforced in SQL (`WHERE tenant_id =
 * $1 AND published_app_id = $2 ...`). There is deliberately **no** public
 * `getX(id)` method: a bare id lookup cannot express resource ownership and
 * would let callers probe resources across tenants/apps/principals. When a
 * scoped lookup misses, repositories return `undefined` / `null` and callers
 * map it to the uniform "resource unavailable" error, so cross-scope access is
 * indistinguishable from a missing resource (no ID enumeration).
 */
import type {
	AgentDefinitionId,
	AuditEventId,
	ConversationEventId,
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	RequestId,
	TenantId,
	TurnId,
} from "./domain/ids.ts";
import type {
	ConversationStatus,
	PrincipalType,
	PublishedAppStatus,
	PublishedAppVersionStatus,
} from "./domain/states.ts";
import type { Principal, ResourceScope } from "./domain/types.ts";

/**
 * Concrete scope shapes used by the repository methods. Each method names the
 * narrowest scope it needs so the type system (not just convention) requires
 * the caller to supply every ownership dimension:
 *
 * - `TenantScope` for tenant-owned control-plane rows (agent definitions).
 * - `AppScope` for app-owned rows (apps, versions, principals).
 * - `OwnerScope` for principal-owned rows (conversations).
 */
export interface TenantScope {
	readonly tenantId: TenantId;
}
export interface AppScope extends TenantScope {
	readonly publishedAppId: PublishedAppId;
}
export interface OwnerScope extends AppScope {
	readonly principalId: PrincipalId;
}

/** Tenant record (control plane). */
export interface TenantRecord {
	readonly tenantId: TenantId;
	readonly name: string;
	readonly status: "active" | "suspended" | "archived";
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** Agent definition record (control plane). */
export interface AgentDefinitionRecord {
	readonly agentDefinitionId: AgentDefinitionId;
	readonly tenantId: TenantId;
	readonly name: string;
	readonly revision: number;
	readonly draftConfig: unknown;
	/** SHA-256 of the canonicalised source config (spec 33.3); "" = legacy. */
	readonly sourceHash: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** PublishedApp record. */
export interface PublishedAppRecord {
	readonly publishedAppId: PublishedAppId;
	readonly tenantId: TenantId;
	readonly agentDefinitionId: AgentDefinitionId;
	readonly publicAppId: string;
	readonly name: string;
	readonly status: PublishedAppStatus;
	readonly accessMode: "anonymous" | "signed_user" | "mixed";
	readonly currentVersionId: PublishedAppVersionId | null;
	readonly allowedOrigins: readonly string[];
	readonly mutablePolicy: unknown;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** PublishedAppVersion record (immutable after creation). */
export interface PublishedAppVersionRecord {
	readonly publishedAppVersionId: PublishedAppVersionId;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly versionNumber: number;
	readonly sourceAgentRevision: number;
	readonly snapshot: unknown;
	readonly runtimeSpec: unknown;
	/** NULL when the version was rejected (no activatable spec). */
	readonly runtimeSpecHash: string | null;
	readonly status: PublishedAppVersionStatus;
	readonly validationErrors: readonly unknown[];
	readonly createdAt: Date;
}

/** Persisted principal mapping record. */
export interface PrincipalRecord {
	readonly principalId: PrincipalId;
	readonly tenantId: TenantId;
	/** NULL only for the tenant's platform service principal (TASK-013/33.1). */
	readonly publishedAppId: PublishedAppId | null;
	readonly principalType: PrincipalType;
	readonly subjectHash: string;
	readonly status: "active" | "blocked" | "deleted";
	readonly createdAt: Date;
	readonly lastSeenAt: Date;
}

/** Conversation record. */
export interface ConversationRecord {
	readonly conversationId: ConversationId;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly publishedAppVersionId: PublishedAppVersionId;
	readonly ownerPrincipalId: PrincipalId;
	readonly title: string;
	readonly status: ConversationStatus;
	readonly lastEventSequence: number;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly lastActiveAt: Date;
}

/** Row shape returned by the conversation list cursor query. */
export interface ConversationListRow extends ConversationRecord {
	/** Opaque cursor value: `lastActiveAt + "|" + id`. */
	readonly cursor: string;
}

export interface ConversationListParams {
	readonly scope: OwnerScope;
	readonly limit: number;
	/** Opaque cursor from a previous page; when omitted starts from the newest. */
	readonly cursor?: string;
}

export interface TenantRepository {
	/** Upsert a tenant idempotently (bootstrap). Returns the stored record. */
	upsert(record: TenantRecord): Promise<TenantRecord>;
	get(tenantId: TenantId): Promise<TenantRecord | undefined>;
}

export interface AgentDefinitionRepository {
	/** Insert a new revision; the `(id, revision)` pair must be unique. */
	insert(record: AgentDefinitionRecord): Promise<void>;
	/** Fetch a specific revision scoped to the tenant. */
	getRevision(
		scope: TenantScope,
		agentDefinitionId: AgentDefinitionId,
		revision: number,
	): Promise<AgentDefinitionRecord | undefined>;
	/** Latest revision for the agent within the tenant, if any. */
	getLatest(scope: TenantScope, agentDefinitionId: AgentDefinitionId): Promise<AgentDefinitionRecord | undefined>;
	/** Latest revision of the named agent within the tenant (control import). */
	getLatestByName(scope: TenantScope, name: string): Promise<AgentDefinitionRecord | undefined>;
}

export interface PublishedAppRepository {
	insert(record: PublishedAppRecord): Promise<void>;
	/** Scoped get: tenant + app must both match. */
	get(scope: AppScope, publishedAppId: PublishedAppId): Promise<PublishedAppRecord | undefined>;
	/** Scoped get by the public locator (publicAppId is not a credential). */
	getByPublicAppId(scope: TenantScope, publicAppId: string): Promise<PublishedAppRecord | undefined>;
	/** Update mutable fields only (never historical versions). */
	updateMutable(
		scope: AppScope,
		publishedAppId: PublishedAppId,
		fields: {
			readonly name?: string;
			readonly status?: PublishedAppStatus;
			readonly accessMode?: "anonymous" | "signed_user" | "mixed";
			readonly allowedOrigins?: readonly string[];
			readonly mutablePolicy?: unknown;
		},
	): Promise<void>;
	/** Transactional activation/rollback: only flips the currentVersionId pointer. */
	setCurrentVersion(
		scope: AppScope,
		publishedAppId: PublishedAppId,
		versionId: PublishedAppVersionId | null,
	): Promise<void>;
	/**
	 * Transactional version pointer flip for activate/rollback (spec 27.3):
	 * locks the app row (`SELECT ... FOR UPDATE`) so concurrent transitions
	 * serialize (no lost update), verifies the target version belongs to this
	 * app and is `ready`, then updates `current_version_id` (and, for
	 * activation, the app status to `active`). Returns the previous pointer
	 * and whether the flip happened (`ok: false` when the version check
	 * failed, indistinguishable from an unavailable target).
	 */
	transitionVersion(
		scope: AppScope,
		publishedAppId: PublishedAppId,
		versionId: PublishedAppVersionId,
		input: { readonly activate: boolean },
	): Promise<{ readonly ok: boolean; readonly previousVersionId: PublishedAppVersionId | null }>;
}

export interface PublishedAppVersionRepository {
	insert(record: PublishedAppVersionRecord): Promise<void>;
	/** Scoped get by id; version must belong to the app in scope. */
	get(scope: AppScope, publishedAppVersionId: PublishedAppVersionId): Promise<PublishedAppVersionRecord | undefined>;
	/** Next version number for the app (max + 1, starting at 1). */
	nextVersionNumber(scope: AppScope, publishedAppId: PublishedAppId): Promise<number>;
	/**
	 * Atomically allocate the next version number and insert the version row
	 * in one transaction. The app row is locked (`SELECT ... FOR UPDATE`) so
	 * concurrent creates for the same app serialize and can never produce a
	 * duplicate `(app, version_number)`. Versions are immutable: this is the
	 * only write path beside `updateStatus`.
	 */
	createVersion(
		scope: AppScope,
		input: Omit<PublishedAppVersionRecord, "versionNumber"> & { readonly versionNumber?: never },
	): Promise<PublishedAppVersionRecord>;
	/** Transition status only (validating -> ready/rejected -> retired). */
	updateStatus(
		scope: AppScope,
		publishedAppVersionId: PublishedAppVersionId,
		status: Exclude<PublishedAppVersionStatus, "validating">,
		validationErrors: readonly unknown[],
	): Promise<void>;
}

export interface PrincipalRepository {
	/** Scoped upsert by `(tenant, app, type, subjectHash)`; returns the record. */
	upsert(record: PrincipalRecord): Promise<PrincipalRecord>;
	/**
	 * Upsert the tenant's platform service principal (id = tenantId,
	 * published_app_id = NULL) by `(tenant_id, id)` — used by control-plane
	 * idempotency/audit before any app exists (spec 33.1).
	 */
	upsertPlatform(scope: TenantScope): Promise<PrincipalRecord>;
	/** Scoped get by principal id. */
	get(scope: AppScope, principalId: PrincipalId): Promise<PrincipalRecord | undefined>;
	/** Scoped get by the stable subject triple. */
	getBySubject(
		scope: AppScope,
		principalType: PrincipalType,
		subjectHash: string,
	): Promise<PrincipalRecord | undefined>;
	/** Touch `last_seen_at` (scoped). */
	touch(scope: AppScope, principalId: PrincipalId): Promise<void>;
}

export interface ConversationRepository {
	/** Scoped insert; the conversation pins the given version at creation. */
	insert(record: ConversationRecord): Promise<void>;
	/** Scoped get; tenant/app/owner must all match. */
	get(scope: OwnerScope, conversationId: ConversationId): Promise<ConversationRecord | undefined>;
	/** Scoped list with opaque cursor pagination. */
	list(params: ConversationListParams): Promise<ConversationListRow[]>;
	/** Scoped status transition (active -> archived/deleted). */
	updateStatus(
		scope: OwnerScope,
		conversationId: ConversationId,
		status: Exclude<ConversationStatus, "active">,
	): Promise<void>;
	/**
	 * Atomically advance `last_event_sequence` and return the new value, or
	 * `undefined` when the conversation is missing/out of scope (spec 26.3).
	 */
	nextEventSequence(scope: OwnerScope, conversationId: ConversationId): Promise<number | undefined>;
}

/** Audit log row (append-only, spec section 26.2 / 13.4). */
export interface AuditEventRecord {
	readonly auditEventId: AuditEventId;
	readonly tenantId: TenantId;
	readonly actorType: string;
	readonly actorId: string;
	readonly action: string;
	readonly resourceType: string;
	readonly resourceId: string;
	readonly requestId: RequestId;
	readonly metadata: unknown;
	readonly createdAt: Date;
}

export interface AuditEventRepository {
	/** Append one audit event (never updated or deleted). */
	insert(record: AuditEventRecord): Promise<void>;
	/** List recent audit events for a tenant, newest first. */
	listByTenant(scope: TenantScope, limit: number): Promise<AuditEventRecord[]>;
}

/** Combined repository set wired to a single Postgres client. */
export interface PublishingRepositories {
	readonly tenants: TenantRepository;
	readonly agentDefinitions: AgentDefinitionRepository;
	readonly publishedApps: PublishedAppRepository;
	readonly publishedAppVersions: PublishedAppVersionRepository;
	readonly principals: PrincipalRepository;
	readonly conversations: ConversationRepository;
	readonly events: ConversationEventRepository;
	readonly idempotency: IdempotencyRepository;
	readonly audit: AuditEventRepository;
}

/** Convenience type for a persisted Principal record with its typed fields. */
export type { Principal, ResourceScope };

/**
 * Conversation event (append-only history row, spec section 26.2/26.3).
 * `sequence` is allocated by the atomic `UPDATE ... RETURNING` in the same
 * transaction that inserts the row, so it is never observable as a hole.
 */
export interface ConversationEventRecord {
	readonly eventId: ConversationEventId;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly conversationId: ConversationId;
	readonly sequence: number;
	readonly eventType: string;
	readonly eventSchemaVersion: number;
	readonly turnId: TurnId | null;
	readonly payload: unknown;
	readonly createdAt: Date;
}

/** Input for appending one event; the sequence is allocated by the repository. */
export interface ConversationEventInput {
	readonly conversationId: ConversationId;
	readonly eventType: string;
	readonly eventSchemaVersion?: number;
	readonly turnId?: TurnId | null;
	readonly payload: unknown;
}

export interface ConversationEventListParams {
	readonly limit: number;
	/** Only events with `sequence > afterSequence` (incremental replay). */
	readonly afterSequence?: number;
}

export interface ConversationEventRepository {
	/**
	 * Atomically append one event to the conversation (spec 26.3): the
	 * sequence bump and the event insert share one transaction, so a failed
	 * insert never leaves a hole or advances the counter. Returns the
	 * appended record, or `undefined` when the conversation is missing or
	 * out of scope (indistinguishable, as with every scoped read).
	 */
	append(scope: OwnerScope, input: ConversationEventInput): Promise<ConversationEventRecord | undefined>;
	/** List events in sequence order for incremental replay (scoped). */
	list(
		scope: OwnerScope,
		conversationId: ConversationId,
		params: ConversationEventListParams,
	): Promise<ConversationEventRecord[]>;
}

/** Scope for idempotency records: the table keys on (tenant, principal). */
export interface IdempotencyScope {
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
}

/** Idempotency record (spec section 26.2 idempotency_records). */
export interface IdempotencyRecord {
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly operation: string;
	readonly idempotencyKey: string;
	readonly requestHash: string;
	readonly state: "running" | "completed" | "failed";
	readonly responseStatus: number | null;
	readonly responseBody: unknown;
	readonly expiresAt: Date;
	readonly createdAt: Date;
}

/**
 * Result of claiming an idempotency slot:
 *
 * - `claimed` — this call owns the slot and must execute the operation.
 * - `replay` — a previous call with the same key and request hash completed;
 *   the stored response is returned without re-executing.
 * - `conflict` — the same key was used with a different request hash (409).
 * - `in_progress` — another execution with the same key is still running
 *   (its `expires_at` has not passed); the caller should wait/retry later.
 */
export type IdempotencyBeginResult =
	| { readonly outcome: "claimed" }
	| { readonly outcome: "replay"; readonly record: IdempotencyRecord }
	| { readonly outcome: "conflict" }
	| { readonly outcome: "in_progress" };

export interface IdempotencyRepository {
	/**
	 * Atomically claim the idempotency slot for `(operation, key)`. A
	 * `running` slot whose `expires_at` has passed is reclaimed (stale-lock
	 * recovery, spec TASK-008) before a retry is allowed; concurrent
	 * reclaimers race on the same row and only one wins.
	 */
	begin(
		scope: IdempotencyScope,
		operation: string,
		idempotencyKey: string,
		requestHash: string,
		ttlMs: number,
	): Promise<IdempotencyBeginResult>;
	/** Mark the slot completed and store the response for replay. */
	complete(
		scope: IdempotencyScope,
		operation: string,
		idempotencyKey: string,
		responseStatus: number,
		responseBody: unknown,
	): Promise<void>;
	/** Mark the slot failed so a later retry with the same key can reclaim it. */
	fail(scope: IdempotencyScope, operation: string, idempotencyKey: string): Promise<void>;
	/**
	 * Reclaim all expired `running` slots for the scope (explicit sweep used
	 * by periodic cleanup). Returns the number of slots transitioned to
	 * `failed`.
	 */
	sweepExpired(scope: IdempotencyScope, now?: Date): Promise<number>;
}

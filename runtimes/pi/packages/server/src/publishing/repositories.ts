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

import type { ReasoningEffort } from "@earendil-works/pi-protocol";
import type {
	AgentDefinitionId,
	AttachmentId,
	AuditEventId,
	ConversationEventId,
	ConversationId,
	LaunchKeyId,
	McpCallAuditId,
	McpSecretId,
	McpServerId,
	McpToolId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	RequestId,
	SkillArtifactId,
	SkillId,
	TenantId,
	TurnId,
} from "./domain/ids.ts";
import type {
	AttachmentStatus,
	ConversationStatus,
	EmbedLaunchKeyStatus,
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
 * - `ConversationScope` for attachment rows (conversation-scoped by principal).
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
export interface ConversationScope extends OwnerScope {
	readonly conversationId: ConversationId;
}

/** Tenant record (control plane). */
export interface TenantRecord {
	readonly tenantId: TenantId;
	readonly name: string;
	readonly status: "active" | "suspended" | "archived";
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/**
 * Row shape returned by the agent-definition list query (ADMIN-001).
 * `cursor` is the opaque value used to request the next page.
 */
export interface AgentDefinitionListRow {
	readonly agentDefinitionId: AgentDefinitionId;
	readonly name: string;
	readonly revision: number;
	readonly sourceHash: string;
	readonly createdAt: Date;
	/** Opaque cursor value: `createdAt + "|" + agentDefinitionId`. */
	readonly cursor: string;
}

export interface AgentDefinitionListParams {
	readonly scope: TenantScope;
	readonly limit: number;
	/** Opaque cursor from a previous page; when omitted starts from the newest. */
	readonly cursor?: string;
	/** false (default) = each agent's newest revision; true = all revisions. */
	readonly includeRevisions?: boolean;
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

export interface SkillDiagnosticRecord {
	readonly code: string;
	readonly path: string;
	readonly message: string;
	readonly severity: "error" | "warning";
}

export interface SkillRecord {
	readonly skillId: SkillId;
	readonly tenantId: TenantId;
	readonly name: string;
	readonly status: "enabled" | "disabled";
	readonly currentRevision: number;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface SkillArtifactRecord {
	readonly artifactId: SkillArtifactId;
	readonly tenantId: TenantId;
	readonly filename: string;
	readonly mediaType: string;
	readonly sourceHash: string;
	readonly sizeBytes: number;
	readonly content: Uint8Array;
	readonly createdAt: Date;
}

export interface SkillRevisionRecord {
	readonly skillId: SkillId;
	readonly tenantId: TenantId;
	readonly revision: number;
	readonly artifactId: SkillArtifactId;
	readonly sourceHash: string;
	readonly parsedName: string;
	readonly description: string;
	readonly instructionText: string;
	readonly disableModelInvocation: boolean;
	readonly diagnostics: readonly SkillDiagnosticRecord[];
	readonly createdAt: Date;
}

export interface AgentRevisionSkillBindingRecord {
	readonly tenantId: TenantId;
	readonly agentDefinitionId: AgentDefinitionId;
	readonly agentRevision: number;
	readonly position: number;
	readonly skillId: SkillId;
	readonly skillRevision: number;
}

export interface SkillRepository {
	create(input: {
		readonly skill: SkillRecord;
		readonly artifact: SkillArtifactRecord;
		readonly revision: SkillRevisionRecord;
	}): Promise<"created" | "name_conflict">;
	addRevision(input: {
		readonly scope: TenantScope;
		readonly skillId: SkillId;
		readonly artifact: SkillArtifactRecord;
		readonly revision: Omit<SkillRevisionRecord, "revision">;
	}): Promise<SkillRevisionRecord | undefined>;
	list(scope: TenantScope, limit: number, cursor?: string): Promise<readonly SkillRecord[]>;
	get(scope: TenantScope, skillId: SkillId): Promise<SkillRecord | undefined>;
	getRevision(scope: TenantScope, skillId: SkillId, revision: number): Promise<SkillRevisionRecord | undefined>;
	getArtifact(scope: TenantScope, artifactId: SkillArtifactId): Promise<SkillArtifactRecord | undefined>;
	listRevisions(scope: TenantScope, skillId: SkillId): Promise<readonly SkillRevisionRecord[]>;
	setStatus(scope: TenantScope, skillId: SkillId, status: "enabled" | "disabled"): Promise<boolean>;
	softDelete(scope: TenantScope, skillId: SkillId): Promise<boolean>;
	softDeleteIfUnreferenced(
		scope: TenantScope,
		skillId: SkillId,
	): Promise<"deleted" | "published_reference" | "not_found">;
	bindAgentRevision(input: {
		readonly scope: TenantScope;
		readonly agentDefinitionId: AgentDefinitionId;
		readonly agentRevision: number;
		readonly bindings: readonly { readonly skillId: SkillId; readonly skillRevision: number }[];
	}): Promise<"bound" | "agent_not_found" | "skill_unavailable">;
	listBindings(
		scope: TenantScope,
		agentDefinitionId: AgentDefinitionId,
		agentRevision: number,
	): Promise<readonly AgentRevisionSkillBindingRecord[]>;
	listBindingsForSkill(scope: TenantScope, skillId: SkillId): Promise<readonly AgentRevisionSkillBindingRecord[]>;
}

export interface McpServerRecord {
	readonly mcpServerId: McpServerId;
	readonly tenantId: TenantId;
	readonly name: string;
	readonly status: "enabled" | "disabled";
	readonly currentRevision: number;
	readonly lastTestOk: boolean | null;
	readonly lastTestLatencyMs: number | null;
	readonly lastTestAt: Date | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface McpServerRevisionRecord {
	readonly mcpServerId: McpServerId;
	readonly tenantId: TenantId;
	readonly revision: number;
	readonly transport: "streamable_http";
	readonly endpoint: string;
	readonly authentication: "none" | "bearer";
	readonly createdAt: Date;
}

export interface McpToolRecord {
	readonly mcpToolId: McpToolId;
	readonly tenantId: TenantId;
	readonly mcpServerId: McpServerId;
	readonly mcpRevision: number;
	readonly name: string;
	readonly description: string | null;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly inputSchemaHash: string;
	readonly createdAt: Date;
}

export interface AgentRevisionMcpBindingRecord {
	readonly tenantId: TenantId;
	readonly agentDefinitionId: AgentDefinitionId;
	readonly agentRevision: number;
	readonly position: number;
	readonly mcpServerId: McpServerId;
	readonly mcpRevision: number;
	readonly toolAllowlist: readonly string[];
}

export interface McpCallAuditRecord {
	readonly mcpCallAuditId: McpCallAuditId;
	readonly tenantId: TenantId;
	readonly conversationId: ConversationId | null;
	readonly publishedAppVersionId: PublishedAppVersionId | null;
	readonly mcpServerId: McpServerId;
	readonly mcpRevision: number;
	readonly toolName: string;
	readonly outcome: "success" | "error" | "cancelled";
	readonly latencyMs: number;
	readonly resultBytes: number;
	readonly resultTruncated: boolean;
	readonly errorCode: string | null;
	readonly requestId: RequestId | null;
	readonly createdAt: Date;
}

export interface McpServerRepository {
	create(input: {
		readonly server: McpServerRecord;
		readonly revision: McpServerRevisionRecord;
		readonly tools?: readonly McpToolRecord[];
	}): Promise<"created" | "name_conflict">;
	addRevision(input: {
		readonly scope: TenantScope;
		readonly mcpServerId: McpServerId;
		readonly revision: Omit<McpServerRevisionRecord, "revision">;
		readonly tools: readonly Omit<McpToolRecord, "mcpRevision">[];
	}): Promise<McpServerRevisionRecord | undefined>;
	list(scope: TenantScope, limit: number, cursor?: string): Promise<readonly McpServerRecord[]>;
	get(scope: TenantScope, mcpServerId: McpServerId): Promise<McpServerRecord | undefined>;
	getRevision(
		scope: TenantScope,
		mcpServerId: McpServerId,
		revision: number,
	): Promise<McpServerRevisionRecord | undefined>;
	listRevisions(scope: TenantScope, mcpServerId: McpServerId): Promise<readonly McpServerRevisionRecord[]>;
	listTools(scope: TenantScope, mcpServerId: McpServerId, revision: number): Promise<readonly McpToolRecord[]>;
	setLastTest(
		scope: TenantScope,
		mcpServerId: McpServerId,
		result: { readonly ok: boolean; readonly latencyMs: number },
	): Promise<boolean>;
	setStatus(scope: TenantScope, mcpServerId: McpServerId, status: "enabled" | "disabled"): Promise<boolean>;
	softDelete(scope: TenantScope, mcpServerId: McpServerId): Promise<boolean>;
	softDeleteIfUnreferenced(
		scope: TenantScope,
		mcpServerId: McpServerId,
	): Promise<"deleted" | "published_reference" | "not_found">;
	listBindings(
		scope: TenantScope,
		agentDefinitionId: AgentDefinitionId,
		agentRevision: number,
	): Promise<readonly AgentRevisionMcpBindingRecord[]>;
	listBindingsForServer(
		scope: TenantScope,
		mcpServerId: McpServerId,
	): Promise<readonly AgentRevisionMcpBindingRecord[]>;
	recordCallAudit(record: McpCallAuditRecord): Promise<void>;
}

export interface McpEncryptedSecretRecord {
	readonly secretId: McpSecretId;
	readonly tenantId: TenantId;
	readonly mcpServerId: McpServerId;
	readonly ciphertext: Uint8Array;
	readonly nonce: Uint8Array;
	readonly authTag: Uint8Array;
	readonly keyVersion: number;
}

export interface McpSecretRepository {
	put(record: McpEncryptedSecretRecord): Promise<void>;
	get(scope: TenantScope, mcpServerId: McpServerId): Promise<McpEncryptedSecretRecord | undefined>;
	has(scope: TenantScope, mcpServerId: McpServerId): Promise<boolean>;
	delete(scope: TenantScope, mcpServerId: McpServerId): Promise<boolean>;
}

/** Row shape returned by the published-app list query (ADMIN-001). */
export interface PublishedAppListRow extends PublishedAppRecord {
	/** Opaque cursor value: `createdAt + "|" + publishedAppId`. */
	readonly cursor: string;
}

export interface PublishedAppListParams {
	readonly scope: TenantScope;
	readonly limit: number;
	/** Opaque cursor from a previous page; when omitted starts from the newest. */
	readonly cursor?: string;
	/** Optional status filter (draft | active | suspended | archived). */
	readonly status?: PublishedAppStatus;
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

/** Row shape returned by the version list query (ADMIN-001). */
export interface PublishedAppVersionListRow extends PublishedAppVersionRecord {
	/** true when this version is the app's current pointer. */
	readonly isCurrent: boolean;
	/** Opaque cursor value: `createdAt + "|" + publishedAppVersionId`. */
	readonly cursor: string;
}

export interface PublishedAppVersionListParams {
	readonly scope: AppScope;
	readonly limit: number;
	/** Opaque cursor from a previous page; when omitted starts from the newest. */
	readonly cursor?: string;
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
	/** WB-007: running event counters advanced in the same transaction as the append. */
	readonly eventCount: number;
	readonly eventBytes: number;
	readonly turnCount: number;
	/** WB-008: latest summary sequence applied to this conversation (0 = none). */
	readonly latestSummarySequence: number;
	/** WB-008: rollover chain (NULL = root conversation). */
	readonly previousConversationId: ConversationId | null;
	readonly nextConversationId: ConversationId | null;
	readonly rolledOverAt: Date | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly lastActiveAt: Date;
}

/** Row shape returned by the conversation list cursor query. */
export interface ConversationListRow extends ConversationRecord {
	/** Opaque cursor value: `lastActiveAt + "|" + id`. */
	readonly cursor: string;
}

/**
 * Attachment metadata record (spec 26.2 `attachments`, TASK-006/030).
 *
 * `objectKey` is always server-generated and never derived from the client
 * filename; the actual bytes live in the object store (spec 24.1: production
 * must not use node disk as the truth source). Status lifecycle:
 * staged -> ready | rejected; ready -> deleted.
 */
export interface AttachmentRecord {
	readonly attachmentId: AttachmentId;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly conversationId: ConversationId;
	readonly ownerPrincipalId: PrincipalId;
	readonly objectKey: string;
	readonly filename: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly checksumSha256: string;
	readonly status: AttachmentStatus;
	/** NULL = never expires (MVP ready rows are kept until deleted). */
	readonly expiresAt: Date | null;
	readonly createdAt: Date;
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
	/**
	 * Import by `(tenant, name)` under a transaction-scoped advisory lock.
	 * Returns the existing latest revision when its source hash is unchanged;
	 * otherwise inserts the next immutable revision atomically.
	 */
	importByName(record: Omit<AgentDefinitionRecord, "agentDefinitionId" | "revision">): Promise<AgentDefinitionRecord>;
	/**
	 * Create revision 1 while serialising on `(tenant, name)`. Returns false
	 * when an active Agent with the same name already exists.
	 */
	createInitial(record: AgentDefinitionRecord): Promise<boolean>;
	createInitialWithSkillBindings(
		record: AgentDefinitionRecord,
		bindings: readonly { readonly skillId: SkillId; readonly skillRevision: number }[],
		mcpBindings?: readonly {
			readonly mcpServerId: McpServerId;
			readonly mcpRevision: number;
			readonly toolAllowlist: readonly string[];
		}[],
	): Promise<"created" | "name_conflict" | "skill_unavailable" | "mcp_unavailable">;
	insertWithSkillBindings(
		record: AgentDefinitionRecord,
		bindings: readonly { readonly skillId: SkillId; readonly skillRevision: number }[],
		mcpBindings?: readonly {
			readonly mcpServerId: McpServerId;
			readonly mcpRevision: number;
			readonly toolAllowlist: readonly string[];
		}[],
	): Promise<"inserted" | "skill_unavailable" | "mcp_unavailable">;
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
	/** Agent-definition list, newest first, opaque-cursor paginated (ADMIN-001). */
	list(params: AgentDefinitionListParams): Promise<AgentDefinitionListRow[]>;
	/** Hide every revision of an Agent while retaining immutable history. */
	softDelete?(scope: TenantScope, agentDefinitionId: AgentDefinitionId): Promise<void>;
	/**
	 * Lock the Agent, reject active app references, and soft-delete all
	 * revisions in one transaction. `insertForActiveAgent` takes the same row
	 * locks, closing the create-app/delete race.
	 */
	softDeleteIfUnreferenced(
		scope: TenantScope,
		agentDefinitionId: AgentDefinitionId,
	): Promise<"deleted" | "has_associated_apps" | "not_found">;
}

/**
 * Outcome of `PublishedAppRepository.findOrCreateInternal`.
 *   - `created`   → an internal draft app was inserted for the Agent;
 *   - `existing`  → exactly one app already existed and is returned;
 *   - `conflict`  → the Agent already has >1 apps (legacy schema); never picks;
 *   - `agent_unavailable` → the referenced Agent is missing/inactive.
 */
export type FindOrCreateInternalResult =
	| { readonly status: "created"; readonly app: PublishedAppRecord }
	| { readonly status: "existing"; readonly app: PublishedAppRecord }
	| { readonly status: "conflict"; readonly count: number }
	| { readonly status: "agent_unavailable" };

export interface PublishedAppRepository {
	insert(record: PublishedAppRecord): Promise<void>;
	/** Insert only while the referenced Agent is active, under Agent row locks. */
	insertForActiveAgent(record: PublishedAppRecord): Promise<boolean>;
	/**
	 * Find-or-create the single internal published_app for an Agent under a
	 * transaction-scoped advisory lock keyed on the Agent id. Serializes
	 * concurrent first-publishes: two concurrent 0-observed calls merge into
	 * exactly one created app (TOCTOU-safe), never two.
	 */
	findOrCreateInternal(scope: TenantScope, record: PublishedAppRecord): Promise<FindOrCreateInternalResult>;
	/** Scoped get: tenant + app must both match. */
	get(scope: AppScope, publishedAppId: PublishedAppId): Promise<PublishedAppRecord | undefined>;
	/**
	 * Published-app list scoped to a tenant, newest first, opaque-cursor
	 * paginated, optional status filter (ADMIN-001).
	 */
	list(params: PublishedAppListParams): Promise<PublishedAppListRow[]>;
	/**
	 * All non-deleted published apps pinned to one Agent (tenant-scoped), oldest
	 * first. Used by one-click publish to apply the 0/1/N rule (a single Agent
	 * may reference more than one app today — the schema has no uniqueness
	 * constraint on `agent_definition_id`).
	 */
	listByAgentDefinition(
		scope: TenantScope,
		agentDefinitionId: AgentDefinitionId,
	): Promise<readonly PublishedAppRecord[]>;
	/**
	 * Lookup by the globally-unique public locator (`public_app_id`, UNIQUE).
	 *
	 * This is the ONE intentionally unscoped lookup in the repository layer:
	 * the embed Exchange endpoint is a public endpoint that only knows the
	 * publicAppId, and `publicAppId` is not a resource id — it is an
	 * unguessable, publicly-shareable locator (AD-10), so knowing it already
	 * implies the app. The discovered `tenantId` immediately becomes the
	 * scope for every downstream operation; there is no way to enumerate
	 * another tenant's apps without their publicAppId.
	 */
	getByPublicAppId(publicAppId: string): Promise<PublishedAppRecord | undefined>;
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
	/** Count published apps in the tenant (dashboard). */
	count(scope: TenantScope): Promise<number>;
	/** Remove the app subject from active/public lookup while retaining history. */
	softDelete?(scope: AppScope, publishedAppId: PublishedAppId): Promise<void>;
	/** Exact guard used before deleting an Agent; excludes deleted app subjects. */
	hasActiveForAgent?(scope: TenantScope, agentDefinitionId: AgentDefinitionId): Promise<boolean>;
}

/** Pending (ready, non-current) version row for dashboard. */
export interface PendingVersionRow {
	readonly publishedAppId: PublishedAppId;
	readonly publicAppId: string;
	readonly name: string;
	readonly appStatus: string;
	readonly versionNumber: number;
	readonly versionStatus: string;
}

export interface PublishedAppVersionRepository {
	insert(record: PublishedAppVersionRecord): Promise<void>;
	/** Scoped get by id; version must belong to the app in scope. */
	get(scope: AppScope, publishedAppVersionId: PublishedAppVersionId): Promise<PublishedAppVersionRecord | undefined>;
	/**
	 * Version list for an app, newest first, opaque-cursor paginated, with the
	 * `isCurrent` flag resolved against the app's current pointer (ADMIN-001).
	 */
	list(params: PublishedAppVersionListParams): Promise<PublishedAppVersionListRow[]>;
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
	/**
	 * Revalidate and row-lock every capability referenced by a candidate in the
	 * same transaction that allocates and inserts the immutable version.
	 */
	createVersionGuarded(
		scope: AppScope,
		input: Omit<PublishedAppVersionRecord, "versionNumber"> & { readonly versionNumber?: never },
		guards: {
			readonly skills: readonly { readonly skillId: SkillId; readonly revision: number }[];
			readonly mcpServers: readonly {
				readonly mcpServerId: McpServerId;
				readonly revision: number;
				readonly requiresSecret: boolean;
			}[];
		},
	): Promise<PublishedAppVersionRecord | undefined>;
	/** Transition status only (validating -> ready/rejected -> retired). */
	updateStatus(
		scope: AppScope,
		publishedAppVersionId: PublishedAppVersionId,
		status: Exclude<PublishedAppVersionStatus, "validating">,
		validationErrors: readonly unknown[],
	): Promise<void>;
	/** Newest ready non-current version per app in the tenant. */
	listPendingByTenant(scope: TenantScope): Promise<PendingVersionRow[]>;
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
	/** Count active principals in the tenant (dashboard). */
	countActive(scope: TenantScope): Promise<number>;
}

/** WB-006: tenant-scoped cross-owner conversation listing for the Admin Console. */
export interface AdminConversationListParams {
	readonly scope: TenantScope;
	readonly limit: number;
	readonly cursor?: string;
	readonly publishedAppId?: PublishedAppId;
	readonly status?: ConversationStatus;
	readonly createdAfter?: Date;
	readonly createdBefore?: Date;
	readonly publishedAppVersionId?: PublishedAppVersionId;
	/** Only conversations produced by this agent (agentDefinitionId). */
	readonly agentId?: AgentDefinitionId;
	/** Only conversations whose error-event count > 0. */
	readonly hasErrors?: boolean;
	readonly principalType?: "external_user" | "anonymous_visitor";
}

/** WB-006: tenant-scoped admin row with display + scope fields joined from siblings. */
export interface AdminConversationListRow extends ConversationRecord {
	readonly cursor: string;
	readonly errorCount: number;
	readonly messageCount: number;
	readonly principalDisplayId: string;
	readonly principalType: PrincipalType;
	readonly appName: string;
	readonly publicAppId: string;
	/** Agent (agentDefinitionId) that produced this conversation, if resolvable. */
	readonly agentId: AgentDefinitionId | null;
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
	/** Count active conversations in the tenant (dashboard, across all apps/principals). */
	countActive(scope: TenantScope): Promise<number>;
	/**
	 * WB-008: seal the conversation as read-only and link it to the next
	 * conversation in the rollover chain. Returns `false` when the
	 * conversation is missing / out of scope / not currently `active`. The
	 * caller is responsible for inserting the new conversation and updating
	 * `latest_summary_sequence` in the same transaction.
	 */
	sealForRollover(
		scope: OwnerScope,
		conversationId: ConversationId,
		fields: {
			readonly nextConversationId: ConversationId;
			readonly atSequence: number;
		},
	): Promise<boolean>;
	/**
	 * WB-008: stamp the latest summary sequence on a conversation so the
	 * Runtime can quickly check "do I have a fresh summary to load?".
	 * Returns `false` when the conversation is missing / out of scope. The
	 * caller MUST enforce that `atSequence` is monotonic against
	 * `latest_summary_sequence` (server-side: `>=` only on insert).
	 */
	updateLatestSummarySequence(scope: OwnerScope, conversationId: ConversationId, atSequence: number): Promise<boolean>;
	/**
	 * WB-006: tenant-scoped admin cross-owner listing. Every row carries
	 * the full `AdminConversationListRow` projection (no message bodies).
	 * `hasErrors` is honoured via a subselect on `conversation_events` to
	 * avoid materialising the full event log on the dashboard path.
	 */
	listByTenant(params: AdminConversationListParams): Promise<AdminConversationListRow[]>;
	/**
	 * WB-006: tenant-scoped admin get. Returns the full record joined with
	 * the principal + app display fields. A `conversationId` is globally
	 * unique, so tenant + conversation is sufficient scope; cross-tenant
	 * reads return `undefined` (uniform 404).
	 */
	getByTenant(scope: TenantScope, conversationId: ConversationId): Promise<AdminConversationListRow | undefined>;
	/** Admin-only tenant-scoped lifecycle transition. Returns false when no row changed. */
	updateStatusByTenant?(
		scope: TenantScope,
		conversationId: ConversationId,
		from: readonly ConversationStatus[],
		status: Exclude<ConversationStatus, "active">,
	): Promise<boolean>;
}

/** Expired/aged-out attachment selection for the background sweep (TASK-030). */
export interface AttachmentSweepParams {
	readonly limit: number;
	/** Staged rows older than this are swept (interrupted/abandoned uploads). */
	readonly stagedBefore: Date;
	/** Ready rows with `expires_at` before this are swept. */
	readonly readyExpiredBefore: Date;
}

/** 上传总量配额（spec 14；TASK-031）：单会话 / Principal / App 字节上限。 */
export interface UploadQuotaLimits {
	readonly conversationBytes: number;
	readonly principalBytes: number;
	readonly appBytes: number;
}

export type ReserveStagedOutcome =
	| { readonly outcome: "ok" }
	| { readonly outcome: "quota_exceeded" }
	| { readonly outcome: "conversation_missing" };

export interface AttachmentRepository {
	/** Scoped insert; the row is created in `staged` status (TASK-030). */
	insert(record: AttachmentRecord): Promise<void>;
	/** Scoped get; tenant/app/conversation/owner must all match. */
	get(scope: ConversationScope, attachmentId: AttachmentId): Promise<AttachmentRecord | undefined>;
	/**
	 * 事务内原子预留：锁会话行（并发上传串行化）-> 统计 staged+ready 字节
	 * （会话/Principal/App 三档）-> 配额检查 -> 插入 staged 行（TASK-031）。
	 * 超配额返回 `quota_exceeded`（不插入）；会话缺失/越权返回
	 * `conversation_missing`（统一不可用）。
	 */
	reserveStaged(
		scope: ConversationScope,
		record: AttachmentRecord,
		limits: UploadQuotaLimits,
	): Promise<ReserveStagedOutcome>;
	/** 该会话内 staged+ready 字节总量（sweep/测试用）。 */
	sumActiveBytes(scope: ConversationScope): Promise<number>;
	/**
	 * 会话内 status = ready 的附件列表（TASK-032 引用检索的授权来源枚举）。
	 * 全 scope SQL：只返回本会话、本 principal 的附件。
	 */
	listReadyByConversation(scope: ConversationScope): Promise<AttachmentRecord[]>;
	/**
	 * WB-006: tenant-scoped admin attachment listing for one conversation. A
	 * `conversationId` is globally unique, so tenant + conversation is
	 * sufficient scope; cross-owner (any principal in the tenant) is allowed,
	 * cross-tenant returns `[]`. Returns ready + staged metadata rows.
	 */
	listByConversationTenant(scope: TenantScope, conversationId: ConversationId): Promise<AttachmentRecord[]>;
	/**
	 * Scoped status transition. Returns `false` when the row is missing or out
	 * of scope (uniform unavailable; no ID enumeration).
	 */
	updateStatus(scope: ConversationScope, attachmentId: AttachmentId, status: AttachmentStatus): Promise<boolean>;
	/** Sweep selection: expired ready rows + aged staged rows (spec 6.3). */
	listSweepCandidates(params: AttachmentSweepParams): Promise<AttachmentRecord[]>;
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

/** Row shape returned by the audit list query (ADMIN-001). */
export interface AuditEventListRow extends AuditEventRecord {
	/** Opaque cursor value: `createdAt + "|" + auditEventId`. */
	readonly cursor: string;
}

export interface AuditEventListParams {
	readonly scope: TenantScope;
	readonly limit: number;
	/** Opaque cursor from a previous page; when omitted starts from the newest. */
	readonly cursor?: string;
	/** When set, only events for the app's resources are returned (ADMIN-001). */
	readonly appId?: PublishedAppId;
}

export interface AuditEventRepository {
	/** Append one audit event (never updated or deleted). */
	insert(record: AuditEventRecord): Promise<void>;
	/** List recent audit events for a tenant, newest first. */
	listByTenant(scope: TenantScope, limit: number): Promise<AuditEventRecord[]>;
	/** List recent audit events, newest first, opaque-cursor + optional app filter. */
	list(params: AuditEventListParams): Promise<AuditEventListRow[]>;
}

/**
 * Embed launch key record (spec section 26.2 `embed_launch_keys`, TASK-027).
 *
 * Only public key material is ever stored: the platform registers the host's
 * public key and never accepts or persists a private key. `keyId` is the
 * host-facing identifier used in the Launch Token `kid` header, unique per
 * published app. `status` lifecycle: `active` (current) -> `retiring`
 * (still accepted during the rotation window) -> `revoked` (never accepted).
 */
export interface LaunchKeyRecord {
	readonly launchKeyId: LaunchKeyId;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly keyId: string;
	/** JWS algorithm of the launch token (MVP: only `EdDSA`). */
	readonly algorithm: string;
	/** SPKI PEM of the host's public key — never a private key. */
	readonly publicKeyPem: string;
	readonly status: EmbedLaunchKeyStatus;
	readonly notBefore: Date;
	readonly expiresAt: Date | null;
	readonly createdAt: Date;
}

export interface LaunchKeyRepository {
	/**
	 * Register a new `active` launch key and atomically move every other
	 * `active` key of the same app to `retiring` (the rotation window: the
	 * old and new keys are accepted side by side until the old one is
	 * revoked or expires — spec TASK-027). One transaction; a duplicate
	 * `(published_app_id, key_id)` returns `key_id_conflict` instead of a
	 * raw constraint error.
	 */
	insertWithRotation(
		scope: AppScope,
		record: LaunchKeyRecord,
	): Promise<
		| { readonly outcome: "created"; readonly created: LaunchKeyRecord; readonly retired: readonly LaunchKeyRecord[] }
		| { readonly outcome: "key_id_conflict" }
	>;
	/** Scoped get by internal launch key id. */
	get(scope: AppScope, launchKeyId: LaunchKeyId): Promise<LaunchKeyRecord | undefined>;
	/** Scoped get by the host-facing keyId (used by TASK-028 verification). */
	getByKeyId(scope: AppScope, keyId: string): Promise<LaunchKeyRecord | undefined>;
	/** Scoped list, newest first. */
	list(scope: AppScope): Promise<LaunchKeyRecord[]>;
	/** Scoped status transition (active/retiring -> revoked, TASK-027). */
	updateStatus(scope: AppScope, launchKeyId: LaunchKeyId, status: EmbedLaunchKeyStatus): Promise<void>;
}

/**
 * Conversation-level reasoning effort fact source (V2-README §4.3).
 *
 * Dedicated per-conversation state (`conversation_reasoning_state`), NOT a
 * `conversation_events` row. `effort: null` means the conversation reverts to
 * the Agent Revision default. Session recovery and `GET .../reasoning` read
 * here; the append-only audit log carries before/after for accountability.
 */
export interface ConversationReasoningStateRecord {
	readonly conversationId: ConversationId;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly ownerPrincipalId: PrincipalId;
	readonly effort: ReasoningEffort | null;
	readonly updatedBy: string;
	readonly requestId: RequestId;
	readonly updatedAt: Date;
}

export interface ConversationReasoningRepository {
	/** Scoped get; tenant/app/owner must all match (else undefined → uniform 404). */
	get(scope: OwnerScope, conversationId: ConversationId): Promise<ConversationReasoningStateRecord | undefined>;
	/** Upsert the fact source for a conversation. */
	upsert(record: ConversationReasoningStateRecord): Promise<void>;
	/**
	 * Atomically read the prior fact source, upsert the new reasoning state and
	 * append the reasoning-updated audit row in ONE PostgreSQL transaction. On
	 * any failure (e.g. audit write error) the whole set — including the state
	 * upsert — rolls back. Resolves the prior state (or undefined when none).
	 */
	setEffortWithAudit(input: {
		readonly state: ConversationReasoningStateRecord;
		/** Build the audit row from the prior fact source read inside the transaction. */
		readonly audit: (before: ConversationReasoningStateRecord | undefined) => AuditEventRecord;
	}): Promise<ConversationReasoningStateRecord | undefined>;
}

/** Combined repository set wired to a single Postgres client. */
export interface PublishingRepositories {
	readonly tenants: TenantRepository;
	readonly agentDefinitions: AgentDefinitionRepository;
	readonly skills: SkillRepository;
	readonly mcpServers: McpServerRepository;
	readonly mcpSecrets: McpSecretRepository;
	readonly publishedApps: PublishedAppRepository;
	readonly publishedAppVersions: PublishedAppVersionRepository;
	readonly principals: PrincipalRepository;
	readonly conversations: ConversationRepository;
	readonly events: ConversationEventRepository;
	/** Agent V2 M1: conversation-level reasoning effort fact source. */
	readonly conversationReasoning: ConversationReasoningRepository;
	/** WB-008: conversation event-log summary snapshot repository. */
	readonly summaries: ConversationSummaryRepository;
	readonly idempotency: IdempotencyRepository;
	readonly audit: AuditEventRepository;
	readonly launchKeys: LaunchKeyRepository;
	readonly attachments: AttachmentRepository;
}

/** Convenience type for a persisted Principal record with its typed fields. */
export type { Principal, ResourceScope };

/**
 * Conversation event (append-only history row, spec section 26.2/26.3).
 * `sequence` is allocated by the atomic `UPDATE ... RETURNING` in the same
 * transaction that inserts the row, so it is never observable as a hole.
 * `payloadBytes` is denormalised so the conversation counter can advance in
 * the same transaction (spec §11.5, WB-007).
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
	readonly payloadBytes: number;
	readonly createdAt: Date;
}

/** Input for appending one event; the sequence is allocated by the repository. */
export interface ConversationEventInput {
	readonly conversationId: ConversationId;
	readonly eventType: string;
	readonly eventSchemaVersion?: number;
	readonly turnId?: TurnId | null;
	readonly payload: unknown;
	/**
	 * UTF-8 byte length of `payload` (WB-007). The caller computes this so
	 * the repository does not have to re-serialise; a value of `0` lets the
	 * repository recompute via `Buffer.byteLength(JSON.stringify(payload))`.
	 */
	readonly payloadBytes?: number;
}

export interface ConversationEventListParams {
	readonly limit: number;
	/** Only events with `sequence > afterSequence` (incremental replay). */
	readonly afterSequence?: number;
}

/**
 * WB-006: tenant-scoped admin cross-owner event listing. Distinct from
 * `ConversationEventRepository.list` (which is owner-scoped) so the admin
 * console can browse any conversation in the tenant while still requiring
 * the `(tenant, app, conversation)` triple to match.
 */
export interface AdminConversationEventListParams {
	readonly scope: TenantScope;
	readonly conversationId: ConversationId;
	readonly limit: number;
	readonly afterSequence?: number;
}

export interface AdminConversationEventRecord extends ConversationEventRecord {
	/** Stable public id for the event. */
	readonly eventId: ConversationEventId;
}

/** Tenant-scoped provider usage grouped by the Agent revision that served the turn. */
export interface UsageAggregateRow {
	readonly agentDefinitionId: AgentDefinitionId;
	readonly agentName: string;
	readonly source: "embed";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly requestCount: number;
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
	/** Count error-type events in the tenant (dashboard). */
	countErrors(scope: TenantScope): Promise<number>;
	/** Aggregate only persisted provider usage; message length is never used as a fallback. */
	summarizeUsage(input: {
		readonly scope: TenantScope;
		readonly from: Date;
		readonly to: Date;
	}): Promise<UsageAggregateRow[]>;
	/**
	 * WB-006: tenant-scoped admin listing (cross-owner). The query joins
	 * `conversations` to enforce `(tenant, app, conversation)` scope and
	 * uses opaque `(conversation_id, sequence)` pagination just like the
	 * embed-side path.
	 */
	listByConversation(params: AdminConversationEventListParams): Promise<ConversationEventRecord[]>;
}

/** WB-008: frozen summary record persisted at complete-Turn boundaries. */
export interface ConversationSummaryRecord {
	readonly id: string;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly ownerPrincipalId: PrincipalId;
	readonly conversationId: ConversationId;
	readonly throughSequence: number;
	readonly modelId: string;
	readonly sourceEventCount: number;
	readonly sourceBytes: number;
	readonly body: unknown;
	readonly createdAt: Date;
}

export interface ConversationSummaryRepository {
	/**
	 * Insert a summary. `(conversation_id, through_sequence)` is unique; a
	 * conflict (re-running for the same boundary) returns `duplicate`.
	 * Summary creation MUST run inside a transaction with the
	 * `latest_summary_sequence` update on `conversations`; this method
	 * does NOT touch the conversation counter itself.
	 */
	insert(
		scope: OwnerScope,
		record: ConversationSummaryRecord,
	): Promise<{ readonly outcome: "inserted" } | { readonly outcome: "duplicate" }>;
	/**
	 * Return the latest summary for the conversation (highest
	 * `through_sequence`), or `undefined` when no summary exists yet.
	 */
	getLatest(scope: OwnerScope, conversationId: ConversationId): Promise<ConversationSummaryRecord | undefined>;
	/** All summaries for the conversation, newest first. */
	list(scope: OwnerScope, conversationId: ConversationId): Promise<ConversationSummaryRecord[]>;
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

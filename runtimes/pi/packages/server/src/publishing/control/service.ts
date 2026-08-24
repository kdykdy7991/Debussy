/**
 * Control-plane services (spec section 33 + 27.1/27.2, TASK-011).
 *
 * Pure service layer over the scoped repositories — no HTTP, no global
 * mutable settings. Flow covered here:
 *
 * 1. `bootstrapTenant`  — idempotent tenant bootstrap (spec 33.1): an
 *    existing tenant is validated (id/name/status) and never overwritten.
 * 2. `importAgent`     — freeze the current agent configuration into an
 *    immutable AgentDefinition revision (spec 33.3): same source hash returns
 *    the existing latest revision (natural idempotency), a changed hash
 *    creates `revision + 1` without touching old revisions, and an
 *    `expectedSourceHash` mismatch is a 409 to stop drift during publishing.
 * 3. `createPublishedApp` — create a `draft` app pinned to an agent that must
 *    belong to the same tenant (cross-tenant publishing is rejected).
 * 4. `createPublishedAppVersion` — compile the pinned agent revision into an
 *    immutable RuntimeSpec (TASK-010) and persist `ready` (valid) or
 *    `rejected` (with validationErrors) versions with an atomically allocated
 *    version number. Versions have NO update path.
 *
 * The compile step depends only on the explicit `CapabilityCatalog` passed in
 * the constructor (never implicit global settings).
 */

import type {
	AdminSession,
	AdminUsageSummary,
	AgentCapabilities,
	AgentConfigSnapshot,
	AgentDefinitionAssociatedApp,
	AgentDefinitionDetail,
	AgentDefinitionRevision,
	AgentDefinitionRevisionListResponse,
	AgentPublicId,
	ConversationAdminEvent,
	ConversationAdminEventListResponse,
	ConversationAdminListResponse,
	ConversationAdminSummary,
	ConversationAdminSummaryEntry,
	ConversationAdminSummaryListResponse,
	ConversationEventPublicId,
	ConversationPublicId,
	CustomLlmApi,
	PreviewTicket,
	PublishedAppLocator,
	PublishedAppPublicId,
	PublishedAppVersionPublicId,
	SaveAgentRevisionRequest,
	SaveAgentRevisionResponse,
	SessionEventType,
	TurnPublicId,
} from "@earendil-works/pi-protocol";
import {
	type ContextUsageSnapshot,
	type ConversationContextResponse,
	type ConversationMetricsResponse,
	type ConversationTurnMetric,
	computeConversationMetricsStats,
	resolveMetricsPage,
	SESSION_EVENT_TYPES,
	turnOutcomeFromTerminalEvent,
} from "@earendil-works/pi-protocol";
import { importSPKI } from "jose";
import {
	isTerminalTurnEvent,
	isTurnStartEvent,
	readStoredContextSnapshot,
	readStoredTurnMetrics,
	toConversationTurnMetric,
} from "../../agent-v2/query.ts";
import { validateOriginList } from "../../embed/auth/origin.ts";
import { modelParameterCapabilities, validateModelParameters } from "../../model-parameters.ts";
import type {
	AgentDefinitionId,
	AuditEventId,
	ConversationId,
	PublishedAppId,
	PublishedAppVersionId,
	RequestId,
	TenantId,
	TurnId,
} from "../domain/ids.ts";
import {
	idPrefix,
	newAgentDefinitionId,
	newAuditEventId,
	newLaunchKeyId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newRequestId,
	newTenantId,
	toPublicId,
} from "../domain/ids.ts";
import type { AccessMode, PrincipalType } from "../domain/states.ts";
import { exportSessionLines } from "../export/session-export.ts";
import type { PreviewTicketService } from "../preview-ticket.ts";
import type {
	AdminConversationListRow,
	AgentDefinitionRecord,
	ConversationEventRecord,
	ConversationSummaryRecord,
	LaunchKeyRecord,
	PublishedAppRecord,
	PublishedAppVersionRecord,
	PublishingRepositories,
	TenantRecord,
} from "../repositories.ts";
import { type AgentDraftConfig, type CapabilityCatalog, compileRuntimeSpec } from "../runtime-spec/compiler.ts";
import { canonicalJson, sha256Hex } from "../runtime-spec/hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../runtime-spec/schema.ts";
import type { CustomLlmProviderView, LlmConfigStore } from "./llm-config.ts";

/** Cursor-paginated query result shared by the console query API (ADMIN-002). */
export interface CursorPage<T> {
	readonly items: readonly T[];
	readonly nextCursor: string | null;
}

/** `GET /api/control/v1/agent-definitions` item (ADMIN-002). */
export interface AgentDefinitionSummary {
	readonly id: string; // agent_<uuid>
	readonly name: string;
	readonly revision: number;
	readonly sourceHash: string;
	readonly createdAt: string;
}

/** `GET /api/control/v1/published-apps` item (ADMIN-002). */
export interface PublishedAppSummary {
	readonly id: string; // app_<uuid>
	readonly publicAppId: string;
	readonly name: string;
	readonly status: string;
	readonly accessMode: string;
	readonly allowedOrigins: readonly string[];
	readonly currentVersionId: string | null;
	readonly embedUrl: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Allowlisted capabilities of an activated version (never the full spec). */
export interface VersionCapabilitiesSummary {
	readonly tools: readonly string[];
	readonly knowledgeBases: readonly string[];
	readonly uploads: { readonly enabled: boolean; readonly maxFiles: number; readonly maxFileBytes: number };
	readonly speech: { readonly enabled: boolean };
	readonly avatar: { readonly enabled: boolean };
}

/** `GET /api/control/v1/published-apps/:appId` (ADMIN-002). */
export interface PublishedAppDetail {
	readonly id: string;
	readonly publicAppId: string;
	readonly name: string;
	readonly status: string;
	readonly accessMode: string;
	readonly allowedOrigins: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly sourceAgent: {
		readonly id: string;
		readonly name: string;
		readonly revision: number;
		readonly sourceHash: string;
	};
	readonly currentVersion: {
		readonly id: string;
		readonly versionNumber: number;
		readonly status: string;
		readonly sourceAgentRevision: number;
		readonly runtimeSpecHash: string | null;
		readonly createdAt: string;
	} | null;
	readonly capabilities: {
		readonly model: { readonly provider: string; readonly modelId: string };
		readonly context: {
			readonly maxTurns: number;
			readonly maxContextTokens: number;
			readonly toolResultMaxBytes: number;
		};
		readonly profile: string;
		readonly summary: VersionCapabilitiesSummary;
	} | null;
}

/** `GET /api/control/v1/published-apps/:appId/versions` item (ADMIN-002). */
export interface PublishedAppVersionSummary {
	readonly id: string;
	readonly versionNumber: number;
	readonly status: string;
	readonly sourceAgentRevision: number;
	readonly runtimeSpecHash: string | null;
	readonly validationErrors: readonly unknown[];
	readonly createdAt: string;
	readonly isCurrent: boolean;
}

/** `GET /api/control/v1/audit-events` item (ADMIN-002), bounded metadata only. */
export interface AuditEventSummary {
	readonly id: string;
	readonly actorType: string;
	readonly actorId: string;
	readonly action: string;
	readonly resourceType: string;
	readonly resourceId: string;
	readonly requestId: string;
	readonly createdAt: string;
	readonly metadata: unknown;
}

export interface ControlServiceOptions {
	readonly repositories: PublishingRepositories;
	readonly catalog: CapabilityCatalog;
	/** Base URL used to build the embedUrl returned on app creation. */
	readonly embedBaseUrl: string;
	/** Preview ticket issuer (WB-005). Required for `createPreviewTicket`. */
	readonly previewTicketService?: PreviewTicketService;
	/** Custom LLM provider store backed by models.json (Custom LLM console). */
	readonly llm?: LlmConfigStore;
	/**
	 * Agent V2 metrics/context 开关（M1）。缺省 false：metrics/context 查询返回
	 * `METRICS_UNAVAILABLE`/`CONTEXT_SNAPSHOT_UNAVAILABLE`(503)。组合时由
	 * `agentV2MetricsEnabled()` 读取 `PI_AGENT_V2_METRICS`。
	 */
	readonly metricsEnabled?: boolean;
}

export type ControlErrorCode =
	| "BOOTSTRAP_MISMATCH" // tenant exists with different name/status (409)
	| "AGENT_NOT_FOUND" // agent/revision not visible in the tenant scope (404)
	| "AGENT_REVISION_NOT_FOUND" // specific agent revision not visible (404)
	| "AGENT_SAVE_FAILED" // saving a new revision failed (500)
	| "SOURCE_HASH_MISMATCH" // expectedSourceHash differs from current (409)
	| "APP_NOT_FOUND" // app not visible in the tenant scope (404)
	| "VERSION_NOT_FOUND" // source agent revision not found (404)
	| "VERSION_UNAVAILABLE" // activate/rollback target not ready or not this app's (409)
	| "INVALID_ORIGINS" // allowedOrigins fails strict origin policy (400)
	| "KEY_ID_CONFLICT" // launch key keyId already registered for this app (409)
	| "INVALID_LAUNCH_KEY" // launch key material/params fail validation (400)
	| "KEY_NOT_FOUND" // launch key not visible in the app scope (404)
	| "KEY_ALREADY_REVOKED" // revoke target is already revoked (409)
	| "PREVIEW_TICKET_FAILED" // preview ticket creation failed (500)
	| "CONVERSATION_NOT_FOUND" // WB-006: conversation not visible in tenant scope (404)
	| "CONFLICT" // unexpected concurrent conflict (409)
	| "LLM_CONFIG_UNAVAILABLE" // Custom LLM console disabled (503)
	| "INVALID_LLM_CONFIG" // Custom LLM provider failed validation (400)
	| "INVALID_MODEL_PARAMETERS" // Agent model parameters failed capability validation (400)
	| "METRICS_UNAVAILABLE" // Agent V2 metrics subsystem disabled/unavailable (503)
	| "CONTEXT_SNAPSHOT_UNAVAILABLE" // Agent V2 context snapshot subsystem unavailable (503)
	| "INVALID_METRICS_FILTER"; // metrics/context query params invalid (422)

export interface ControlServiceError {
	readonly code: ControlErrorCode;
	readonly httpStatus: number;
	readonly message: string;
}

export type ControlResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: ControlServiceError };

function fail<T>(code: ControlErrorCode, httpStatus: number, message: string): ControlResult<T> {
	return { ok: false, error: { code, httpStatus, message } };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Result of importing the current agent configuration (spec 33.3). */
export interface ImportAgentResult {
	readonly agentDefinitionId: AgentDefinitionId;
	readonly revision: number;
	readonly sourceHash: string;
	readonly warnings: readonly { readonly code: string; readonly path: string; readonly message: string }[];
}

export interface CreatePublishedAppInput {
	readonly tenantId: TenantId;
	readonly agentDefinitionId: AgentDefinitionId;
	readonly name: string;
	readonly accessMode: AccessMode;
	readonly allowedOrigins?: readonly string[];
	/** App-level display config; version compilation uses the agent's theme. */
	readonly theme?: { readonly primaryColor?: string; readonly welcomeMessage?: string };
}

export interface CreatePublishedAppResult {
	readonly app: PublishedAppRecord;
	readonly publicAppId: string;
	readonly embedUrl: string;
}

export interface CreatePublishedAppVersionInput {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly sourceAgentRevision: number;
}

export interface CreatePublishedAppVersionResult {
	readonly version: PublishedAppVersionRecord;
}

/** MVP launch-token JWS algorithm (spec 24.1: Ed25519/EdDSA). */
export const LAUNCH_KEY_ALGORITHM = "EdDSA";
/** jose key-type name used to import the registered SPKI public key. */
const LAUNCH_KEY_TYPE = "Ed25519";
/** keyId charset: safe for JWT `kid` headers and control API URL paths. */
const LAUNCH_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface CreateLaunchKeyInput {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	/** Host-facing identifier used in the Launch Token `kid` header (required). */
	readonly keyId: string;
	/** JWS algorithm of host-signed launch tokens; MVP accepts only `EdDSA`. */
	readonly algorithm?: string;
	/** SPKI PEM of the host's public key. Private key material is rejected. */
	readonly publicKeyPem: string;
	/** ISO-8601; defaults to now. */
	readonly notBefore?: string;
	/** ISO-8601; optional. Must be after notBefore and in the future. */
	readonly expiresAt?: string | null;
	readonly requestId?: RequestId;
}

export interface CreateLaunchKeyResult {
	readonly key: LaunchKeyRecord;
	/** Previously-active keys of the app moved to `retiring` by this rotation. */
	readonly retired: readonly LaunchKeyRecord[];
	readonly auditEventId: AuditEventId;
}

export interface RevokeLaunchKeyInput {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly keyId: string;
	readonly requestId?: RequestId;
}

/** WB-009: thrown when the export target conversation is not in tenant scope. */
export class ConversationExportNotFound extends Error {}

export interface RevokeLaunchKeyResult {
	readonly key: LaunchKeyRecord;
	readonly auditEventId: AuditEventId;
}

/**
 * Adapter that collects the publishable subset of the current agent
 * configuration. `collect` must never return secrets: implementations only
 * map the fields declared by `AgentDraftConfig` (spec 33.3 "不得采集").
 */
export interface CurrentAgentDefinitionSource {
	collect(): Promise<{
		readonly name: string;
		readonly config: AgentDraftConfig;
		readonly warnings: readonly { readonly code: string; readonly path: string; readonly message: string }[];
	}>;
}

export class ControlService {
	private readonly repos: PublishingRepositories;
	private readonly catalog: CapabilityCatalog;
	private readonly embedBaseUrl: string;
	private readonly previewTicketService: PreviewTicketService | undefined;
	private readonly llm: LlmConfigStore | undefined;
	private readonly metricsEnabled: boolean;

	constructor(options: ControlServiceOptions) {
		this.repos = options.repositories;
		this.catalog = options.catalog;
		this.embedBaseUrl = options.embedBaseUrl.replace(/\/+$/, "");
		this.previewTicketService = options.previewTicketService;
		this.llm = options.llm;
		this.metricsEnabled = options.metricsEnabled ?? false;
	}

	/** Bootstrap the MVP tenant idempotently (spec 33.1). */
	async bootstrapTenant(input: {
		readonly tenantId?: TenantId;
		readonly tenantName?: string;
	}): Promise<ControlResult<TenantRecordResult>> {
		const tenantId = input.tenantId ?? newTenantId();
		const tenantName = input.tenantName ?? "bootstrap";
		const existing = await this.repos.tenants.get(tenantId);
		if (existing !== undefined) {
			if (existing.name !== tenantName || existing.status !== "active") {
				return fail("BOOTSTRAP_MISMATCH", 409, `existing tenant ${tenantId} does not match requested name/status`);
			}
			// Ensure the platform service principal exists even when the
			// tenant pre-dates this migration path (33.1 step 3).
			await this.repos.principals.upsertPlatform({ tenantId });
			return { ok: true, data: { tenant: existing, created: false } };
		}
		const now = new Date();
		const tenant = await this.repos.tenants.upsert({
			tenantId,
			name: tenantName,
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		await this.repos.principals.upsertPlatform({ tenantId });
		return { ok: true, data: { tenant, created: true } };
	}

	/**
	 * MVP-01 / Batch 1: real session/whoami. Returns the authenticated tenant
	 * display projection so the Web client never falls back to a static
	 * placeholder. Token / secret material is never echoed back; capabilities
	 * are coarse and intentionally non-secret.
	 */
	async getSession(input: { readonly tenantId: TenantId }): Promise<ControlResult<AdminSession>> {
		const tenant = await this.repos.tenants.get(input.tenantId);
		if (tenant === undefined) {
			return fail("BOOTSTRAP_MISMATCH", 404, `tenant ${input.tenantId} not found`);
		}
		const capabilities = new Set([
			"agent.read",
			"agent.write",
			"app.read",
			"app.write",
			"conversation.read",
			"conversation.export",
			"audit.read",
		] as const);
		return {
			ok: true,
			data: {
				tenantId: `${idPrefix("TenantId")}${tenant.tenantId}` as AdminSession["tenantId"],
				tenantName: tenant.name,
				tenantStatus: tenant.status,
				baseUrl: this.embedBaseUrl,
				capabilities,
			},
		};
	}

	/**
	 * Freeze the current agent configuration into an AgentDefinition revision
	 * (spec 33.3). Natural idempotency: re-importing an unchanged config
	 * returns the existing latest revision without creating a new one.
	 */
	async importAgent(
		input: {
			readonly tenantId: TenantId;
			readonly expectedSourceHash?: string | null;
		},
		source: CurrentAgentDefinitionSource,
	): Promise<ControlResult<ImportAgentResult>> {
		const collected = await source.collect();
		const sourceHash = sha256Hex(canonicalJson(collected.config));
		// import 路径与 saveAgentRevision 同口径：模型参数只接受已声明 reasoning 字段，
		// 非法 effort / 未知字段 / sampling-gen 覆盖一律拒绝（避免未加验证的草稿进入仓库）。
		if (collected.config.model.params !== undefined) {
			const parameterCapabilities = modelParameterCapabilities({
				id: collected.config.model.modelId,
				api: "openai-completions",
				reasoning: /qwen[\s._-]*3[\s._-]*8/i.test(collected.config.model.modelId),
			});
			const parameterErrors = validateModelParameters(
				collected.config.model.params as import("@earendil-works/pi-protocol").AgentModelParameters,
				parameterCapabilities,
			);
			if (parameterErrors.length > 0) {
				return fail("INVALID_MODEL_PARAMETERS", 400, parameterErrors.join("; "));
			}
		}
		if (
			input.expectedSourceHash !== undefined &&
			input.expectedSourceHash !== null &&
			input.expectedSourceHash !== sourceHash
		) {
			return fail(
				"SOURCE_HASH_MISMATCH",
				409,
				`expected source hash ${input.expectedSourceHash} does not match current configuration`,
			);
		}
		const tenantScope = { tenantId: input.tenantId };
		const existing = await this.repos.agentDefinitions.getLatestByName(tenantScope, collected.name);
		if (existing !== undefined && existing.sourceHash === sourceHash) {
			return {
				ok: true,
				data: {
					agentDefinitionId: existing.agentDefinitionId,
					revision: existing.revision,
					sourceHash: existing.sourceHash,
					warnings: collected.warnings,
				},
			};
		}
		const now = new Date();
		const agentDefinitionId = existing?.agentDefinitionId ?? newAgentDefinitionId();
		const revision = (existing?.revision ?? 0) + 1;
		const record: AgentDefinitionRecord = {
			agentDefinitionId,
			tenantId: input.tenantId,
			name: collected.name,
			revision,
			draftConfig: collected.config,
			sourceHash,
			createdAt: now,
			updatedAt: now,
		};
		await this.repos.agentDefinitions.insert(record);
		return { ok: true, data: { agentDefinitionId, revision, sourceHash, warnings: collected.warnings } };
	}

	/** Create a `draft` published app (spec 27.1). */
	async createPublishedApp(input: CreatePublishedAppInput): Promise<ControlResult<CreatePublishedAppResult>> {
		if (input.allowedOrigins !== undefined) {
			const validation = validateOriginList(input.allowedOrigins);
			if (!validation.ok) {
				return fail("INVALID_ORIGINS", 400, `invalid allowedOrigins: ${validation.errors.join("; ")}`);
			}
		}
		const tenantScope = { tenantId: input.tenantId };
		const agent = await this.repos.agentDefinitions.getLatest(tenantScope, input.agentDefinitionId);
		if (agent === undefined) {
			return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		}
		const publishedAppId = newPublishedAppId();
		const publicAppId = newPublicAppId();
		const now = new Date();
		const mutablePolicy = input.theme === undefined ? {} : { theme: input.theme };
		const app: PublishedAppRecord = {
			publishedAppId,
			tenantId: input.tenantId,
			agentDefinitionId: input.agentDefinitionId,
			publicAppId,
			name: input.name,
			status: "draft",
			accessMode: input.accessMode,
			currentVersionId: null,
			allowedOrigins: input.allowedOrigins ?? [],
			mutablePolicy,
			createdAt: now,
			updatedAt: now,
		};
		await this.repos.publishedApps.insert(app);
		return {
			ok: true,
			data: {
				app,
				publicAppId,
				embedUrl: `${this.embedBaseUrl}/embed/${publicAppId}`,
			},
		};
	}

	/**
	 * Create an immutable version by compiling the app's pinned agent revision
	 * (spec 27.2). Compile success persists `ready`; compile failure persists
	 * `rejected` with validationErrors (still created, for audit — the HTTP
	 * layer maps it to 422). The version number is allocated atomically.
	 */
	async createPublishedAppVersion(
		input: CreatePublishedAppVersionInput,
	): Promise<ControlResult<CreatePublishedAppVersionResult>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");

		const agentScope = { tenantId: input.tenantId };
		const agent = await this.repos.agentDefinitions.getRevision(
			agentScope,
			app.agentDefinitionId,
			input.sourceAgentRevision,
		);
		if (agent === undefined) {
			return fail("VERSION_NOT_FOUND", 404, `agent revision ${input.sourceAgentRevision} not found in tenant scope`);
		}

		// The version id is part of the frozen spec, so it is decided once and
		// used for both the compile and the inserted row.
		const versionId = newPublishedAppVersionId();
		const compiled = compileRuntimeSpec({
			agent: agent.draftConfig as AgentDraftConfig,
			publishedAppVersionId: versionId,
			catalog: this.catalog,
		});
		const now = new Date();
		const version: Omit<PublishedAppVersionRecord, "versionNumber"> = {
			publishedAppVersionId: versionId,
			tenantId: input.tenantId,
			publishedAppId: input.publishedAppId,
			sourceAgentRevision: input.sourceAgentRevision,
			snapshot: agent.draftConfig,
			runtimeSpec: compiled.ok ? compiled.spec : null,
			runtimeSpecHash: compiled.ok ? compiled.sha256 : null,
			status: compiled.ok ? "ready" : "rejected",
			validationErrors: compiled.ok ? [] : compiled.errors,
			createdAt: now,
		};
		const created = await this.repos.publishedAppVersions.createVersion(appScope, version);
		return { ok: true, data: { version: created } };
	}

	/**
	 * Register a host launch key (spec 8.1 `POST .../launch-keys`, TASK-027).
	 *
	 * Only the host's *public* key is accepted and persisted; private key
	 * material is rejected before any write. The first key for an app is
	 * `active`; registering a new key atomically moves every other `active`
	 * key to `retiring`, so old and new keys are both accepted during the
	 * rotation window (completion condition of TASK-027). Audited.
	 */
	async createLaunchKey(input: CreateLaunchKeyInput): Promise<ControlResult<CreateLaunchKeyResult>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");

		if (!LAUNCH_KEY_ID_PATTERN.test(input.keyId)) {
			return fail("INVALID_LAUNCH_KEY", 400, "keyId must match [A-Za-z0-9._-]{1,64}");
		}
		const algorithm = input.algorithm ?? LAUNCH_KEY_ALGORITHM;
		if (algorithm !== LAUNCH_KEY_ALGORITHM) {
			return fail("INVALID_LAUNCH_KEY", 400, `algorithm must be ${LAUNCH_KEY_ALGORITHM} in MVP`);
		}
		const pem = input.publicKeyPem.trim();
		if (!isPublicKeyPem(pem) || !(await isEd25519Spki(pem))) {
			return fail(
				"INVALID_LAUNCH_KEY",
				400,
				"publicKeyPem must be a valid Ed25519 SPKI public key PEM (private keys are rejected)",
			);
		}
		const notBefore = parseIsoOrNow(input.notBefore, () =>
			fail("INVALID_LAUNCH_KEY", 400, "notBefore must be a valid ISO-8601 timestamp"),
		);
		if (!notBefore.ok) return notBefore;
		const expiresAt = parseIsoOrNull(input.expiresAt, () =>
			fail("INVALID_LAUNCH_KEY", 400, "expiresAt must be a valid ISO-8601 timestamp"),
		);
		if (!expiresAt.ok) return expiresAt;
		if (expiresAt.data !== null) {
			if (expiresAt.data.getTime() <= notBefore.data.getTime()) {
				return fail("INVALID_LAUNCH_KEY", 400, "expiresAt must be after notBefore");
			}
			if (expiresAt.data.getTime() <= Date.now()) {
				return fail("INVALID_LAUNCH_KEY", 400, "expiresAt must be in the future");
			}
		}

		const record: LaunchKeyRecord = {
			launchKeyId: newLaunchKeyId(),
			tenantId: input.tenantId,
			publishedAppId: input.publishedAppId,
			keyId: input.keyId,
			algorithm,
			publicKeyPem: pem,
			status: "active",
			notBefore: notBefore.data,
			expiresAt: expiresAt.data,
			createdAt: new Date(),
		};
		const result = await this.repos.launchKeys.insertWithRotation(appScope, record);
		if (result.outcome === "key_id_conflict") {
			return fail("KEY_ID_CONFLICT", 409, `launch key ${input.keyId} is already registered for this app`);
		}
		const auditEventId = await this.writeAudit({
			tenantId: input.tenantId,
			action: "app.launch-key.create",
			resourceType: "embed_launch_key",
			resourceId: input.keyId,
			requestId: input.requestId,
			metadata: {
				launchKeyId: result.created.launchKeyId,
				algorithm: result.created.algorithm,
				notBefore: result.created.notBefore.toISOString(),
				expiresAt: result.created.expiresAt === null ? null : result.created.expiresAt.toISOString(),
				retiredKeyIds: result.retired.map((key) => key.keyId),
			},
		});
		return { ok: true, data: { key: result.created, retired: result.retired, auditEventId } };
	}

	/**
	 * Revoke a launch key by its host-facing keyId (spec 13.4 "吊销 Launch
	 * Key"): `active`/`retiring` -> `revoked`, scoped to the app. A revoked
	 * key is never accepted again (TASK-028 verification must skip it).
	 * Audited.
	 */
	async revokeLaunchKey(input: RevokeLaunchKeyInput): Promise<ControlResult<RevokeLaunchKeyResult>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		const key = await this.repos.launchKeys.getByKeyId(appScope, input.keyId);
		if (key === undefined) return fail("KEY_NOT_FOUND", 404, "launch key not found in app scope");
		if (key.status === "revoked") {
			return fail("KEY_ALREADY_REVOKED", 409, `launch key ${input.keyId} is already revoked`);
		}
		await this.repos.launchKeys.updateStatus(appScope, key.launchKeyId, "revoked");
		const auditEventId = await this.writeAudit({
			tenantId: input.tenantId,
			action: "app.launch-key.revoke",
			resourceType: "embed_launch_key",
			resourceId: input.keyId,
			requestId: input.requestId,
			metadata: { launchKeyId: key.launchKeyId, previousStatus: key.status },
		});
		const updated = await this.repos.launchKeys.getByKeyId(appScope, input.keyId);
		return {
			ok: true,
			data: {
				key: updated ?? { ...key, status: "revoked" as const },
				auditEventId,
			},
		};
	}

	/** List the app's launch keys, newest first (admin visibility). */
	async listLaunchKeys(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
	}): Promise<ControlResult<{ readonly keys: readonly LaunchKeyRecord[] }>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		const keys = await this.repos.launchKeys.list(appScope);
		return { ok: true, data: { keys } };
	}

	/** List agent definitions (newest-revision-per-agent by default) for the console. */
	async listAgentDefinitions(input: {
		readonly tenantId: TenantId;
		readonly limit: number;
		readonly cursor?: string;
		readonly includeRevisions?: boolean;
	}): Promise<ControlResult<CursorPage<AgentDefinitionSummary>>> {
		const rows = await this.repos.agentDefinitions.list({
			scope: { tenantId: input.tenantId },
			limit: input.limit,
			cursor: input.cursor,
			includeRevisions: input.includeRevisions ?? false,
		});
		const { page, nextCursor } = sliceCursorPage(rows, input.limit);
		return {
			ok: true,
			data: {
				items: page.map((row) => ({
					id: toPublicId("AgentDefinitionId", row.agentDefinitionId),
					name: row.name,
					revision: row.revision,
					sourceHash: row.sourceHash,
					createdAt: row.createdAt.toISOString(),
				})),
				nextCursor,
			},
		};
	}

	/**
	 * WB-003: Get the latest saved AgentDefinition for the detail page.
	 *
	 * Returns null (404) when the agent is not found in this tenant scope.
	 * Cross-tenant lookup is rejected by the repository's `scope.tenantId`
	 * filter; this method never reads from another tenant.
	 */
	async getAgentDefinitionDetail(input: {
		readonly tenantId: TenantId;
		readonly agentDefinitionId: AgentDefinitionId;
	}): Promise<ControlResult<AgentDefinitionDetail>> {
		const latest = await this.repos.agentDefinitions.getLatest({ tenantId: input.tenantId }, input.agentDefinitionId);
		if (latest === undefined) {
			return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		}
		const associatedApps = await this.repos.publishedApps.list({
			scope: { tenantId: input.tenantId },
			limit: 200,
		});
		const filteredApps = associatedApps.filter((row) => row.agentDefinitionId === input.agentDefinitionId);
		return {
			ok: true,
			data: this.agentDetailView(latest, filteredApps.length),
		};
	}

	/** WB-003: list all immutable revisions of an agent, newest first. */
	async listAgentDefinitionRevisions(input: {
		readonly tenantId: TenantId;
		readonly agentDefinitionId: AgentDefinitionId;
		readonly limit: number;
		readonly cursor?: string;
	}): Promise<ControlResult<AgentDefinitionRevisionListResponse>> {
		// First verify the agent exists in tenant scope; if not, return 404 to
		// match the detail endpoint and avoid leaking IDs from other tenants.
		const latest = await this.repos.agentDefinitions.getLatest({ tenantId: input.tenantId }, input.agentDefinitionId);
		if (latest === undefined) {
			return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		}
		const rows = await this.repos.agentDefinitions.list({
			scope: { tenantId: input.tenantId },
			limit: input.limit,
			cursor: input.cursor,
			includeRevisions: true,
		});
		const revisions = rows
			.filter((row) => row.agentDefinitionId === input.agentDefinitionId)
			.sort((a, b) => b.revision - a.revision);
		const { page, nextCursor } = sliceCursorPage(revisions, input.limit);
		// List returns metadata only; per-revision configSnapshot and diff are
		// fetched on demand via `getAgentDefinitionRevision` (N+1 avoidance).
		const items: AgentDefinitionRevision[] = page.map((row) => this.revisionView(row, undefined));
		return { ok: true, data: { items, nextCursor } };
	}

	/** WB-003: get a single revision (with configSnapshot) for the detail page. */
	async getAgentDefinitionRevision(input: {
		readonly tenantId: TenantId;
		readonly agentDefinitionId: AgentDefinitionId;
		readonly revision: number;
	}): Promise<ControlResult<AgentDefinitionRevision>> {
		const record = await this.repos.agentDefinitions.getRevision(
			{ tenantId: input.tenantId },
			input.agentDefinitionId,
			input.revision,
		);
		if (record === undefined) {
			return fail("AGENT_REVISION_NOT_FOUND", 404, "agent revision not found in tenant scope");
		}
		const previous =
			input.revision > 1
				? await this.repos.agentDefinitions.getRevision(
						{ tenantId: input.tenantId },
						input.agentDefinitionId,
						input.revision - 1,
					)
				: undefined;
		return { ok: true, data: this.revisionView(record, previous) };
	}

	/** WB-003: create a new immutable revision from the client's draft. */
	async saveAgentRevision(input: {
		readonly tenantId: TenantId;
		readonly agentDefinitionId: AgentDefinitionId;
		readonly request: SaveAgentRevisionRequest;
	}): Promise<ControlResult<SaveAgentRevisionResponse>> {
		const latest = await this.repos.agentDefinitions.getLatest({ tenantId: input.tenantId }, input.agentDefinitionId);
		if (latest === undefined) {
			return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		}
		const availableModels = this.llm === undefined ? [] : await this.llm.listAvailableModels();
		const selectedModel = availableModels.find((model) => model.id === input.request.modelId);
		const parameterCapabilities =
			selectedModel?.parameterCapabilities ??
			modelParameterCapabilities({
				id: input.request.modelId ?? "",
				api: "openai-completions",
				reasoning: /qwen[\s._-]*3[\s._-]*8/i.test(input.request.modelId ?? ""),
			});
		const parameterErrors = validateModelParameters(input.request.parameters, parameterCapabilities);
		if (parameterErrors.length > 0) {
			return fail("INVALID_MODEL_PARAMETERS", 400, parameterErrors.join("; "));
		}
		const nextRevision = latest.revision + 1;
		const draft = this.requestToDraft(input.request);
		const sourceHash = sha256Hex(canonicalJson(draft));
		const now = new Date();
		await this.repos.agentDefinitions.insert({
			agentDefinitionId: input.agentDefinitionId,
			tenantId: input.tenantId,
			name: latest.name,
			revision: nextRevision,
			draftConfig: draft,
			sourceHash,
			createdAt: now,
			updatedAt: now,
		});
		return {
			ok: true,
			data: {
				id: toPublicId("AgentDefinitionId", input.agentDefinitionId) as SaveAgentRevisionResponse["id"],
				revision: nextRevision,
				sourceHash,
				createdAt: now.toISOString(),
			},
		};
	}

	/** WB-003: list PublishedApps that use the given AgentDefinition. */
	async listAgentDefinitionApps(input: {
		readonly tenantId: TenantId;
		readonly agentDefinitionId: AgentDefinitionId;
	}): Promise<ControlResult<{ readonly items: readonly AgentDefinitionAssociatedApp[] }>> {
		const latest = await this.repos.agentDefinitions.getLatest({ tenantId: input.tenantId }, input.agentDefinitionId);
		if (latest === undefined) {
			return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		}
		const rows = await this.repos.publishedApps.list({
			scope: { tenantId: input.tenantId },
			limit: 200,
		});
		const filtered = rows.filter((row) => row.agentDefinitionId === input.agentDefinitionId);
		return {
			ok: true,
			data: {
				items: filtered.map((row) => ({
					appId: toPublicId("PublishedAppId", row.publishedAppId) as AgentDefinitionAssociatedApp["appId"],
					publicAppId: row.publicAppId as AgentDefinitionAssociatedApp["publicAppId"],
					name: row.name,
					status: row.status as string,
					currentVersionId:
						row.currentVersionId === null
							? null
							: (toPublicId(
									"PublishedAppVersionId",
									row.currentVersionId,
								) as AgentDefinitionAssociatedApp["currentVersionId"]),
				})),
			},
		};
	}

	/** Internal: project a repository record into the wire-format detail DTO. */
	private agentDetailView(
		record: {
			readonly agentDefinitionId: AgentDefinitionId;
			readonly name: string;
			readonly revision: number;
			readonly draftConfig: unknown;
			readonly updatedAt: Date;
		},
		associatedAppCount: number,
	): AgentDefinitionDetail {
		const snapshot = this.draftToSnapshot(record.draftConfig);
		return {
			id: toPublicId("AgentDefinitionId", record.agentDefinitionId) as AgentDefinitionDetail["id"],
			name: record.name,
			description: null,
			currentRevision: record.revision,
			modelId: snapshot.modelId,
			systemPrompt: snapshot.systemPrompt,
			parameters: snapshot.parameters,
			toolIds: snapshot.toolIds,
			knowledgeBaseIds: snapshot.knowledgeBaseIds,
			capabilities: snapshot.capabilities,
			hasDraft: false,
			updatedAt: record.updatedAt.toISOString(),
			updatedBy: "system",
			changeSummary: null,
			associatedAppCount,
		};
	}

	/** Internal: project a single revision into the wire-format revision DTO. */
	private revisionView(
		row: {
			readonly agentDefinitionId: AgentDefinitionId;
			readonly revision: number;
			readonly sourceHash: string;
			readonly createdAt: Date;
			readonly draftConfig?: unknown;
		},
		previousRow: { readonly draftConfig: unknown; readonly revision: number } | undefined = undefined,
	): AgentDefinitionRevision {
		const draftConfig = row.draftConfig ?? {};
		const snapshot = this.draftToSnapshot(draftConfig);
		const diff = previousRow === undefined ? null : this.computeDiff(previousRow.draftConfig, draftConfig);
		return {
			id: toPublicId("AgentDefinitionId", row.agentDefinitionId) as AgentDefinitionRevision["id"],
			revision: row.revision,
			sourceHash: row.sourceHash,
			changeSummary: null,
			createdBy: "system",
			createdAt: row.createdAt.toISOString(),
			configSnapshot: snapshot,
			diffFromPrevious: diff,
			associatedVersionIds: [],
		};
	}

	/** Internal: convert the persisted `AgentDraftConfig` shape to a flat `AgentConfigSnapshot`. */
	private draftToSnapshot(draft: unknown): AgentConfigSnapshot {
		const d = (draft ?? {}) as Partial<AgentDraftConfig>;
		const toolIds = Array.isArray(d.tools) ? d.tools.map((t) => t.id) : [];
		const knowledgeBaseIds = Array.isArray(d.knowledgeBases) ? d.knowledgeBases.map((k) => k.id) : [];
		const capabilities: AgentCapabilities = {
			liveSpeech: d.speech?.enabled === true,
			avatar: d.avatar?.enabled === true,
			attachments: d.uploads?.enabled === true,
			citations: false,
			realtime: false,
			webSearch: false,
		};
		return {
			modelId: d.model?.modelId ?? null,
			systemPrompt: d.prompt ?? "",
			parameters: (d.model?.params ?? {}) as AgentConfigSnapshot["parameters"],
			toolIds,
			knowledgeBaseIds,
			capabilities,
		};
	}

	/** Internal: convert a save request to the persisted `AgentDraftConfig` shape. */
	private requestToDraft(request: SaveAgentRevisionRequest): AgentDraftConfig {
		return {
			prompt: request.systemPrompt,
			model: {
				provider: "platform",
				modelId: request.modelId ?? "",
				params: request.parameters as unknown as Readonly<Record<string, unknown>>,
			},
			tools: request.toolIds.map((id) => ({ id })),
			knowledgeBases: request.knowledgeBaseIds.map((id) => ({ id })),
			uploads: { enabled: request.capabilities.attachments },
			speech: { enabled: request.capabilities.liveSpeech },
			avatar: { enabled: request.capabilities.avatar },
		};
	}

	/** Internal: compute a structural diff between two consecutive revisions' draft configs. */
	private computeDiff(previous: unknown, current: unknown): AgentDefinitionRevision["diffFromPrevious"] {
		if (previous === null || previous === undefined || current === null || current === undefined) return null;
		const p = previous as Partial<AgentDraftConfig>;
		const c = current as Partial<AgentDraftConfig>;
		const fields: ("modelId" | "systemPrompt" | "parameters" | "toolIds" | "knowledgeBaseIds" | "capabilities")[] =
			[];
		if ((p.model?.modelId ?? null) !== (c.model?.modelId ?? null)) fields.push("modelId");
		if ((p.prompt ?? "") !== (c.prompt ?? "")) fields.push("systemPrompt");
		const pTools = new Set((p.tools ?? []).map((t) => t.id));
		const cTools = new Set((c.tools ?? []).map((t) => t.id));
		const pKb = new Set((p.knowledgeBases ?? []).map((k) => k.id));
		const cKb = new Set((c.knowledgeBases ?? []).map((k) => k.id));
		if (
			JSON.stringify(p.model?.params ?? {}) !== JSON.stringify(c.model?.params ?? {}) ||
			(p.model?.provider ?? "") !== (c.model?.provider ?? "")
		)
			fields.push("parameters");
		if (pTools.size !== cTools.size || ![...pTools].every((id) => cTools.has(id))) fields.push("toolIds");
		if (pKb.size !== cKb.size || ![...pKb].every((id) => cKb.has(id))) fields.push("knowledgeBaseIds");
		if (
			(p.speech?.enabled ?? false) !== (c.speech?.enabled ?? false) ||
			(p.avatar?.enabled ?? false) !== (c.avatar?.enabled ?? false) ||
			(p.uploads?.enabled ?? false) !== (c.uploads?.enabled ?? false)
		)
			fields.push("capabilities");
		return {
			changedFields: fields,
			promptDelta: (p.prompt ?? "") === (c.prompt ?? "") ? null : (c.prompt ?? ""),
			parametersDelta: {},
			toolsAdded: [...cTools].filter((id) => !pTools.has(id)),
			toolsRemoved: [...pTools].filter((id) => !cTools.has(id)),
			knowledgeAdded: [...cKb].filter((id) => !pKb.has(id)),
			knowledgeRemoved: [...pKb].filter((id) => !cKb.has(id)),
			capabilitiesChanged: [],
		};
	}

	/** List published apps of the tenant, newest first, for the console. */
	async getDashboardSummary(input: {
		readonly tenantId: TenantId;
	}): Promise<ControlResult<import("@earendil-works/pi-protocol").DashboardSummary>> {
		const [appCount, userCount, sessionCount, errorCount, pendingRows] = await Promise.all([
			this.repos.publishedApps.count({ tenantId: input.tenantId }),
			this.repos.principals.countActive({ tenantId: input.tenantId }),
			this.repos.conversations.countActive({ tenantId: input.tenantId }),
			this.repos.events.countErrors({ tenantId: input.tenantId }),
			this.repos.publishedAppVersions.listPendingByTenant({ tenantId: input.tenantId }),
		]);
		return {
			ok: true,
			data: {
				appCount,
				activeUserCount: userCount,
				activeSessionCount: sessionCount,
				errorEventCount: errorCount,
				pendingApps: pendingRows.map((row) => ({
					appId: toPublicId("PublishedAppId", row.publishedAppId),
					publicAppId: row.publicAppId,
					name: row.name,
					status: row.appStatus as import("@earendil-works/pi-protocol").KnownPublishedAppStatus,
					pendingVersionNumber: row.versionNumber,
					pendingVersionStatus:
						row.versionStatus as import("@earendil-works/pi-protocol").KnownPublishedAppVersionStatus,
				})),
			},
		};
	}

	/** Aggregate provider-reported token usage for a bounded UTC period. */
	async getUsageSummary(input: {
		readonly tenantId: TenantId;
		readonly from: Date;
		readonly to: Date;
	}): Promise<ControlResult<AdminUsageSummary>> {
		const rows = await this.repos.events.summarizeUsage({
			scope: { tenantId: input.tenantId },
			from: input.from,
			to: input.to,
		});
		const totals = rows.reduce(
			(acc, row) => ({
				inputTokens: acc.inputTokens + row.inputTokens,
				outputTokens: acc.outputTokens + row.outputTokens,
				cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
				cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
				totalTokens: acc.totalTokens + row.totalTokens,
				requestCount: acc.requestCount + row.requestCount,
			}),
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				requestCount: 0,
			},
		);
		return {
			ok: true,
			data: {
				period: { from: input.from.toISOString(), to: input.to.toISOString(), timezone: "UTC" },
				totals,
				byAgent: rows.map((row) => ({
					agentId: toPublicId("AgentDefinitionId", row.agentDefinitionId),
					agentName: row.agentName,
					source: row.source,
					inputTokens: row.inputTokens,
					outputTokens: row.outputTokens,
					cacheReadTokens: row.cacheReadTokens,
					cacheWriteTokens: row.cacheWriteTokens,
					totalTokens: row.totalTokens,
					requestCount: row.requestCount,
				})),
				bySource: rows.length === 0 ? [] : [{ source: "embed", ...totals }],
				generatedAt: new Date().toISOString(),
			},
		};
	}

	/** List published apps of the tenant, newest first, for the console. */
	async listPublishedApps(input: {
		readonly tenantId: TenantId;
		readonly limit: number;
		readonly cursor?: string;
		readonly status?: string;
	}): Promise<ControlResult<CursorPage<PublishedAppSummary>>> {
		const status = input.status === undefined ? undefined : parsePublishedStatus(input.status);
		const rows = await this.repos.publishedApps.list({
			scope: { tenantId: input.tenantId },
			limit: input.limit,
			cursor: input.cursor,
			status,
		});
		const { page, nextCursor } = sliceCursorPage(rows, input.limit);
		return {
			ok: true,
			data: {
				items: page.map((row) => ({
					id: toPublicId("PublishedAppId", row.publishedAppId),
					publicAppId: row.publicAppId,
					name: row.name,
					status: row.status,
					accessMode: row.accessMode,
					allowedOrigins: row.allowedOrigins,
					currentVersionId:
						row.currentVersionId === null ? null : toPublicId("PublishedAppVersionId", row.currentVersionId),
					embedUrl: `${this.embedBaseUrl}/embed/${row.publicAppId}`,
					createdAt: row.createdAt.toISOString(),
					updatedAt: row.updatedAt.toISOString(),
				})),
				nextCursor,
			},
		};
	}

	/** Fetch a published app with its source-agent and allowlisted current version summary. */
	async getPublishedAppDetail(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
	}): Promise<ControlResult<PublishedAppDetail>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");

		const tenantScope = { tenantId: input.tenantId };
		const agent = await this.repos.agentDefinitions.getLatest(tenantScope, app.agentDefinitionId);
		const sourceAgent = {
			id: toPublicId("AgentDefinitionId", agent?.agentDefinitionId ?? app.agentDefinitionId),
			name: agent?.name ?? "",
			revision: agent?.revision ?? 0,
			sourceHash: agent?.sourceHash ?? "",
		};

		let currentVersion: PublishedAppDetail["currentVersion"] = null;
		let capabilities: PublishedAppDetail["capabilities"] = null;
		if (app.currentVersionId !== null) {
			const version = await this.repos.publishedAppVersions.get(appScope, app.currentVersionId);
			if (version !== undefined) {
				currentVersion = {
					id: toPublicId("PublishedAppVersionId", version.publishedAppVersionId),
					versionNumber: version.versionNumber,
					status: version.status,
					sourceAgentRevision: version.sourceAgentRevision,
					runtimeSpecHash: version.runtimeSpecHash,
					createdAt: version.createdAt.toISOString(),
				};
				capabilities = summarizeCapabilities(version.runtimeSpec);
			}
		}

		return {
			ok: true,
			data: {
				id: toPublicId("PublishedAppId", app.publishedAppId),
				publicAppId: app.publicAppId,
				name: app.name,
				status: app.status,
				accessMode: app.accessMode,
				allowedOrigins: app.allowedOrigins,
				createdAt: app.createdAt.toISOString(),
				updatedAt: app.updatedAt.toISOString(),
				sourceAgent,
				currentVersion,
				capabilities,
			},
		};
	}

	/** List immutable versions of an app, newest first, with the current flag. */
	async listPublishedAppVersions(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly limit: number;
		readonly cursor?: string;
	}): Promise<ControlResult<CursorPage<PublishedAppVersionSummary>>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		const rows = await this.repos.publishedAppVersions.list({
			scope: appScope,
			limit: input.limit,
			cursor: input.cursor,
		});
		const { page, nextCursor } = sliceCursorPage(rows, input.limit);
		return {
			ok: true,
			data: {
				items: page.map((row) => ({
					id: toPublicId("PublishedAppVersionId", row.publishedAppVersionId),
					versionNumber: row.versionNumber,
					status: row.status,
					sourceAgentRevision: row.sourceAgentRevision,
					runtimeSpecHash: row.runtimeSpecHash,
					validationErrors: row.validationErrors,
					createdAt: row.createdAt.toISOString(),
					isCurrent: row.isCurrent,
				})),
				nextCursor,
			},
		};
	}

	/**
	 * WB-006: list administrator-facing conversations across all principals
	 * in the tenant. The payload is redacted (no message bodies); the client
	 * fetches events separately. Cross-owner (any principal in the tenant) is
	 * permitted; filters are applied server-side, never leaking raw subject
	 * data.
	 */
	async listConversations(input: {
		readonly tenantId: TenantId;
		readonly limit: number;
		readonly cursor?: string;
		readonly publishedAppId?: PublishedAppId;
		readonly status?: "active" | "archived" | "deleted";
		readonly agentId?: AgentDefinitionId;
		readonly hasErrors?: boolean;
		readonly principalType?: "external_user" | "anonymous_visitor";
		readonly publishedAppVersionId?: PublishedAppVersionId;
		readonly createdAfter?: Date;
		readonly createdBefore?: Date;
	}): Promise<ControlResult<ConversationAdminListResponse>> {
		const rows = await this.repos.conversations.listByTenant({
			scope: { tenantId: input.tenantId },
			limit: input.limit,
			cursor: input.cursor,
			publishedAppId: input.publishedAppId,
			status: input.status,
			agentId: input.agentId,
			hasErrors: input.hasErrors,
			principalType: input.principalType,
			publishedAppVersionId: input.publishedAppVersionId,
			createdAfter: input.createdAfter,
			createdBefore: input.createdBefore,
		});
		const { page, nextCursor } = sliceCursorPage(rows, input.limit);
		return {
			ok: true,
			data: {
				items: page.map(toConversationAdminSummary),
				nextCursor,
				redacted: true,
			},
		};
	}

	/**
	 * WB-006: fetch one conversation's admin projection, its rollover chain
	 * and — when a fresh latest summary exists — the latest summary body so
	 * the Transcript header can render it without a second round-trip.
	 * Reading the body/events triggers an audit event.
	 */
	async getConversationAdminDetail(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly requestId?: string;
	}): Promise<
		ControlResult<{
			readonly conversation: ConversationAdminSummary;
			readonly rollover: {
				readonly previousConversationId: string | null;
				readonly nextConversationId: string | null;
				readonly rolledOverAt: string | null;
			};
			readonly latestSummary: ConversationAdminSummaryEntry | null;
		}>
	> {
		const row = await this.repos.conversations.getByTenant({ tenantId: input.tenantId }, input.conversationId);
		if (row === undefined) return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const ownerScope = {
			tenantId: row.tenantId,
			publishedAppId: row.publishedAppId,
			principalId: row.ownerPrincipalId,
		};
		const latest = await this.repos.summaries.getLatest(ownerScope, row.conversationId);
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "conversation.read-transcript",
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId: input.requestId === undefined ? undefined : (input.requestId as RequestId),
			metadata: { publishedAppId: row.publishedAppId, latestThroughSequence: latest?.throughSequence ?? null },
		});
		return {
			ok: true,
			data: {
				conversation: toConversationAdminSummary(row),
				rollover: {
					previousConversationId:
						row.previousConversationId === null ? null : toPublicId("ConversationId", row.previousConversationId),
					nextConversationId:
						row.nextConversationId === null ? null : toPublicId("ConversationId", row.nextConversationId),
					rolledOverAt: row.rolledOverAt === null ? null : row.rolledOverAt.toISOString(),
				},
				latestSummary: latest === undefined ? null : toConversationAdminSummaryEntry(latest),
			},
		};
	}

	/**
	 * WB-006: incrementally page a conversation's event log into the admin
	 * UI. Unknown/new event types are surfaced read-only via `kind:
	 * "unknown"`. Reading the log writes an audit event. Cross-owner is
	 * allowed within the tenant; cross-tenant is a uniform 404.
	 */
	async listConversationEvents(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly limit: number;
		readonly afterSequence?: number;
		readonly requestId?: string;
	}): Promise<ControlResult<ConversationAdminEventListResponse>> {
		const conversation = await this.repos.conversations.getByTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		if (conversation === undefined)
			return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const events = await this.repos.events.listByConversation({
			scope: { tenantId: input.tenantId },
			conversationId: input.conversationId,
			limit: input.limit,
			afterSequence: input.afterSequence ?? 0,
		});
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "conversation.read-events",
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId: input.requestId === undefined ? undefined : (input.requestId as RequestId),
			metadata: {
				publishedAppId: conversation.publishedAppId,
				afterSequence: input.afterSequence ?? 0,
				eventCount: events.length,
				lastSequence: events.length > 0 ? events[events.length - 1]!.sequence : null,
			},
		});
		const items: ConversationAdminEvent[] = events.map((event) => ({
			eventId: toPublicId("ConversationEventId", event.eventId) as ConversationEventPublicId,
			conversationId: toPublicId("ConversationId", event.conversationId) as ConversationPublicId,
			sequence: event.sequence,
			eventType: event.eventType,
			kind: isSessionEventType(event.eventType) ? event.eventType : "unknown",
			schemaVersion: event.eventSchemaVersion,
			turnId: event.turnId === null ? null : (toPublicId("TurnId", event.turnId) as TurnPublicId),
			payload: event.payload,
			createdAt: event.createdAt.toISOString(),
			payloadBytes: event.payloadBytes,
		}));
		const lastSequence = conversation.lastEventSequence;
		const throughSequence = items.length > 0 ? items[items.length - 1]!.sequence : 0;
		return {
			ok: true,
			data: {
				conversationId: toPublicId("ConversationId", input.conversationId) as ConversationPublicId,
				items,
				lastEventSequence: lastSequence,
				throughSequence,
				nextAfterSequence: items.length === input.limit && throughSequence < lastSequence ? throughSequence : null,
			},
		};
	}

	/**
	 * GET /metrics（M1）——只读聚合持久化轮指标。`stats` 在整个会话轮记录上计算，
	 * 分页仅作用于返回页。开关关 → `METRICS_UNAVAILABLE`(503)。
	 */
	async getConversationMetrics(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly afterSequence?: number;
		readonly limit?: number;
		readonly requestId?: string;
	}): Promise<ControlResult<ConversationMetricsResponse>> {
		if (!this.metricsEnabled)
			return fail("METRICS_UNAVAILABLE", 503, "Agent V2 metrics disabled (PI_AGENT_V2_METRICS)");
		const resolved = resolveMetricsPage({ afterSequence: input.afterSequence, limit: input.limit });
		if (!resolved.ok) return fail("INVALID_METRICS_FILTER", 422, resolved.message);
		const conversation = await this.repos.conversations.getByTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		if (conversation === undefined)
			return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const rows = await this.collectTurnMetrics(input.tenantId, input.conversationId);
		const stats = computeConversationMetricsStats(rows);
		const page = rows.filter((r) => r.sequence > resolved.afterSequence).slice(0, resolved.limit);
		// 契约：只有本页之后仍有轮才返回游标；本页即是最后一页（或空页）时为 null。
		const lastGlobal = rows[rows.length - 1];
		const pageLast = page.length === 0 ? undefined : page[page.length - 1];
		const nextAfterSequence =
			pageLast === undefined || (lastGlobal !== undefined && pageLast.sequence >= lastGlobal.sequence)
				? null
				: pageLast.sequence;
		return {
			ok: true,
			data: {
				conversationId: toPublicId("ConversationId", input.conversationId) as ConversationPublicId,
				stats,
				items: page,
				nextAfterSequence,
			},
		};
	}

	/** GET /context（M1）——返回最新 `context/snapshot` 帧。关 → `CONTEXT_SNAPSHOT_UNAVAILABLE`(503)。 */
	async getConversationContext(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly requestId?: string;
	}): Promise<ControlResult<ConversationContextResponse>> {
		if (!this.metricsEnabled)
			return fail("CONTEXT_SNAPSHOT_UNAVAILABLE", 503, "Agent V2 context snapshot disabled (PI_AGENT_V2_METRICS)");
		const conversation = await this.repos.conversations.getByTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		if (conversation === undefined)
			return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		let latest: ContextUsageSnapshot | undefined;
		let atSequence: number | null = null;
		let after = 0;
		for (;;) {
			const batch = await this.repos.events.listByConversation({
				scope: { tenantId: input.tenantId },
				conversationId: input.conversationId,
				limit: 500,
				afterSequence: after,
			});
			if (batch.length === 0) break;
			for (const event of batch) {
				if (event.eventType === "context/snapshot") {
					const snapshot = readStoredContextSnapshot(event.payload);
					if (snapshot !== undefined) {
						latest = snapshot;
						atSequence = event.sequence;
					}
				}
			}
			after = batch[batch.length - 1]!.sequence;
			if (batch.length < 500) break;
		}
		return {
			ok: true,
			data: {
				conversationId: toPublicId("ConversationId", input.conversationId) as ConversationPublicId,
				available: latest !== undefined,
				latest: latest ?? null,
				atSequence,
			},
		};
	}

	/**
	 * 汇总全会话轮指标：扫描事件，关联 turn/start→model，收集持有合法 `metrics`
	 * 的终态轮记录（升序）。
	 */
	private async collectTurnMetrics(
		tenantId: TenantId,
		conversationId: ConversationId,
	): Promise<readonly ConversationTurnMetric[]> {
		let after = 0;
		const allEvents: ConversationEventRecord[] = [];
		for (;;) {
			const batch = await this.repos.events.listByConversation({
				scope: { tenantId },
				conversationId,
				limit: 500,
				afterSequence: after,
			});
			allEvents.push(...batch);
			if (batch.length === 0) break;
			after = batch[batch.length - 1]!.sequence;
			if (batch.length < 500) break;
		}
		const modelByTurn = new Map<string, string>();
		for (const event of allEvents) {
			if (event.turnId === null || !isTurnStartEvent(event.eventType)) continue;
			const payload = isObject(event.payload) ? event.payload : undefined;
			const model = payload === undefined ? undefined : payload.model;
			if (typeof model === "string" && model.length > 0) modelByTurn.set(event.turnId, model);
		}
		// 先按 turnId 统计全部终态事件（含 malformed / outcome 不匹配者），再逐轮判定：
		// 同轮终态事件数不等于 1 → 重复/冲突终态，整轮排除，绝不因先过滤而漏掉重复。
		const terminalByTurn = new Map<TurnId, ConversationEventRecord[]>();
		for (const event of allEvents) {
			if (event.turnId === null || !isTerminalTurnEvent(event.eventType)) continue;
			const list = terminalByTurn.get(event.turnId);
			if (list === undefined) terminalByTurn.set(event.turnId, [event]);
			else list.push(event);
		}
		const rows: ConversationTurnMetric[] = [];
		for (const [turnId, terminal] of terminalByTurn) {
			if (terminal.length !== 1) continue;
			const event = terminal[0]!;
			const metrics = readStoredTurnMetrics(event.payload);
			if (metrics === undefined) continue;
			// 终态事件必须与 metrics.outcome 一致（turn/end→success、turn/failed→failed、
			// turn/interrupted→cancelled），否则整轮排除。
			if (metrics.outcome !== turnOutcomeFromTerminalEvent(event.eventType)) continue;
			rows.push(
				toConversationTurnMetric({
					turnId: toPublicId("TurnId", turnId) as string,
					sequence: event.sequence,
					modelId: modelByTurn.get(turnId) ?? "",
					metrics,
				}),
			);
		}
		return rows;
	}

	/**
	 * WB-006: all persisted summaries for a conversation, newest first, plus
	 * the rollover chain. Reading a summary writes an audit event.
	 */
	async listConversationSummaries(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly requestId?: string;
	}): Promise<ControlResult<ConversationAdminSummaryListResponse>> {
		const row = await this.repos.conversations.getByTenant({ tenantId: input.tenantId }, input.conversationId);
		if (row === undefined) return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const ownerScope = {
			tenantId: row.tenantId,
			publishedAppId: row.publishedAppId,
			principalId: row.ownerPrincipalId,
		};
		const summaries = await this.repos.summaries.list(ownerScope, row.conversationId);
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "conversation.read-summary",
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId: input.requestId === undefined ? undefined : (input.requestId as RequestId),
			metadata: { publishedAppId: row.publishedAppId, summaryCount: summaries.length },
		});
		const items = summaries.map(toConversationAdminSummaryEntry);
		return {
			ok: true,
			data: {
				conversationId: toPublicId("ConversationId", row.conversationId) as ConversationPublicId,
				items,
				latest: items.length > 0 ? items[0]! : null,
				rollover: {
					previousConversationId:
						row.previousConversationId === null ? null : toPublicId("ConversationId", row.previousConversationId),
					nextConversationId:
						row.nextConversationId === null ? null : toPublicId("ConversationId", row.nextConversationId),
					rolledOverAt: row.rolledOverAt === null ? null : row.rolledOverAt.toISOString(),
				},
			},
		};
	}

	/**
	 * WB-009: stream a conversation export (gzip JSONL). Anchors the export at
	 * the conversation's current `last_event_sequence` (freezing throughSequence),
	 * validates tenant scope, writes a `conversation.exported` audit event, then
	 * yields versioned JSONL lines with bounded-per-page memory.
	 */
	async *streamConversationExport(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly mode: import("@earendil-works/pi-protocol").ConversationExportMode;
		readonly requestId?: string;
	}): AsyncGenerator<string, void, unknown> {
		const conversation = await this.repos.conversations.getByTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		if (conversation === undefined) {
			throw new ConversationExportNotFound();
		}
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "conversation.exported",
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId: input.requestId === undefined ? undefined : (input.requestId as RequestId),
			metadata: {
				publishedAppId: conversation.publishedAppId,
				mode: input.mode,
				throughSequence: conversation.lastEventSequence,
			},
		});
		yield* exportSessionLines({
			conversation,
			mode: input.mode,
			page: (afterSequence, limit) =>
				this.repos.events.listByConversation({
					scope: { tenantId: input.tenantId },
					conversationId: input.conversationId,
					afterSequence,
					limit,
				}),
		});
	}

	/** WB-006: list a conversation's attachments (metadata only) for the admin UI. */
	async listConversationAttachments(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly requestId?: string;
	}): Promise<ControlResult<import("@earendil-works/pi-protocol").ConversationAdminAttachmentListResponse>> {
		const row = await this.repos.conversations.getByTenant({ tenantId: input.tenantId }, input.conversationId);
		if (row === undefined) return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const rows = await this.repos.attachments.listByConversationTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "conversation.read-attachments",
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId: input.requestId === undefined ? undefined : (input.requestId as RequestId),
			metadata: { publishedAppId: row.publishedAppId, attachmentCount: rows.length },
		});
		const cid = toPublicId("ConversationId", input.conversationId) as ConversationPublicId;
		const items: import("@earendil-works/pi-protocol").ConversationAdminAttachment[] = rows.map((a) => ({
			attachmentId: toPublicId("AttachmentId", a.attachmentId),
			conversationId: cid,
			filename: a.filename,
			contentType: a.contentType,
			sizeBytes: a.sizeBytes,
			status: a.status,
			createdAt: a.createdAt.toISOString(),
		}));
		return { ok: true, data: { conversationId: cid, items } };
	}

	/** List recent management audit events (optionally app-scoped) for the console. */
	async listAuditEvents(input: {
		readonly tenantId: TenantId;
		readonly appId?: PublishedAppId;
		readonly limit: number;
		readonly cursor?: string;
	}): Promise<ControlResult<CursorPage<AuditEventSummary>>> {
		const rows = await this.repos.audit.list({
			scope: { tenantId: input.tenantId },
			limit: input.limit,
			cursor: input.cursor,
			appId: input.appId,
		});
		const { page, nextCursor } = sliceCursorPage(rows, input.limit);
		return {
			ok: true,
			data: {
				items: page.map((row) => ({
					id: toPublicId("AuditEventId", row.auditEventId),
					actorType: row.actorType,
					actorId: row.actorId,
					action: row.action,
					resourceType: row.resourceType,
					resourceId: row.resourceId,
					requestId: row.requestId,
					createdAt: row.createdAt.toISOString(),
					metadata: row.metadata,
				})),
				nextCursor,
			},
		};
	}

	/**
	 * Activate a ready version (spec 27.3): the pointer flip and the app
	 * status move to `active` happen in one transaction (row-locked), and an
	 * audit event is appended. The target must belong to this app and be
	 * `ready`; otherwise `VERSION_UNAVAILABLE`.
	 */
	async activateApp(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly versionId: PublishedAppVersionId;
		readonly requestId?: RequestId;
	}): Promise<ControlResult<VersionTransitionResult>> {
		return this.transitionVersion(input, true, "app.activate");
	}

	/**
	 * Roll back to a previous ready version (spec 27.3): the pointer is
	 * flipped in a row-locked transaction and the historical RuntimeSpec rows
	 * are never copied or modified. The app stays active. Audited.
	 */
	async rollbackApp(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly versionId: PublishedAppVersionId;
		readonly requestId?: RequestId;
	}): Promise<ControlResult<VersionTransitionResult>> {
		return this.transitionVersion(input, false, "app.rollback");
	}

	/**
	 * Suspend the app (PD-04: no new exchanges/conversations/turns; running
	 * turns are allowed to finish — enforced by the embed plane reading the
	 * app status). The pointer is left untouched. Audited.
	 */
	async suspendApp(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly reason?: string;
		readonly requestId?: RequestId;
	}): Promise<ControlResult<{ readonly app: PublishedAppRecord; readonly auditEventId: AuditEventId }>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		await this.repos.publishedApps.updateMutable(appScope, input.publishedAppId, { status: "suspended" });
		const auditEventId = await this.writeAudit({
			tenantId: input.tenantId,
			action: "app.suspend",
			resourceType: "published_app",
			resourceId: input.publishedAppId,
			requestId: input.requestId,
			metadata: input.reason === undefined ? {} : { reason: input.reason },
		});
		const updated = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		return {
			ok: true,
			data: {
				app: updated ?? app,
				auditEventId,
			},
		};
	}

	/**
	 * WB-005: issue a single-use preview ticket bound to a specific non-current
	 * version of an app. Tickets are short-lived (default 5 min) and never
	 * logged. The preview is for admins only and never modifies the app's
	 * `current_version_id` or runtime state.
	 */
	async createPreviewTicket(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly versionId: PublishedAppVersionId;
		readonly ttlSeconds?: number;
		readonly requestId?: RequestId;
	}): Promise<ControlResult<PreviewTicket>> {
		if (this.previewTicketService === undefined) {
			return fail("PREVIEW_TICKET_FAILED", 500, "preview ticket service not configured");
		}
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		const version = await this.repos.publishedAppVersions.get(appScope, input.versionId);
		if (version === undefined) return fail("VERSION_NOT_FOUND", 404, "version not found in app scope");
		if (version.status !== "ready") {
			return fail("VERSION_UNAVAILABLE", 409, "preview version must be ready");
		}
		try {
			const ticket = await this.previewTicketService.issue({
				tenantId: input.tenantId,
				appId: input.publishedAppId,
				versionId: input.versionId,
				publicAppId: app.publicAppId,
				ttlSeconds: input.ttlSeconds,
			});
			await this.writeAudit({
				tenantId: input.tenantId,
				action: "app.preview-ticket",
				resourceType: "published_app_version",
				resourceId: input.versionId,
				requestId: input.requestId,
				metadata: { expiresAt: ticket.expiresAt },
			});
			return { ok: true, data: ticket };
		} catch (error) {
			return fail(
				"PREVIEW_TICKET_FAILED",
				500,
				`preview ticket creation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async transitionVersion(
		input: {
			readonly tenantId: TenantId;
			readonly publishedAppId: PublishedAppId;
			readonly versionId: PublishedAppVersionId;
			readonly requestId?: RequestId;
		},
		activate: boolean,
		action: "app.activate" | "app.rollback",
	): Promise<ControlResult<VersionTransitionResult>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		const result = await this.repos.publishedApps.transitionVersion(appScope, input.publishedAppId, input.versionId, {
			activate,
		});
		if (!result.ok) {
			return fail("VERSION_UNAVAILABLE", 409, "target version is not ready or does not belong to this app");
		}
		const auditEventId = await this.writeAudit({
			tenantId: input.tenantId,
			action,
			resourceType: "published_app",
			resourceId: input.publishedAppId,
			requestId: input.requestId,
			metadata: {
				versionId: input.versionId,
				previousVersionId: result.previousVersionId,
			},
		});
		const updated = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		return {
			ok: true,
			data: {
				app: updated ?? app,
				previousVersionId: result.previousVersionId,
				auditEventId,
			},
		};
	}

	private async writeAudit(input: {
		readonly tenantId: TenantId;
		readonly action: string;
		readonly resourceType: string;
		readonly resourceId: string;
		readonly requestId?: RequestId;
		readonly metadata: unknown;
	}): Promise<AuditEventId> {
		const auditEventId = newAuditEventId();
		await this.repos.audit.insert({
			auditEventId,
			tenantId: input.tenantId,
			actorType: "platform_admin",
			actorId: input.tenantId,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			requestId: input.requestId ?? newRequestId(),
			metadata: input.metadata,
			createdAt: new Date(),
		});
		return auditEventId;
	}

	/** List custom LLM providers configured in models.json (secret-blind). */
	async listLlmProviders(): Promise<ControlResult<{ readonly items: readonly CustomLlmProviderView[] }>> {
		if (this.llm === undefined) {
			return fail("LLM_CONFIG_UNAVAILABLE", 503, "Custom LLM configuration is not available");
		}
		const items = await this.llm.list();
		return { ok: true, data: { items } };
	}

	/** Create or update a custom LLM provider and hot-reload the model runtime. */
	async upsertLlmProvider(input: {
		readonly id: string;
		readonly name: string;
		readonly baseUrl: string;
		readonly api: CustomLlmApi;
		readonly models: readonly string[];
		readonly apiKey?: string;
	}): Promise<ControlResult<{ readonly provider: CustomLlmProviderView }>> {
		if (this.llm === undefined) {
			return fail("LLM_CONFIG_UNAVAILABLE", 503, "Custom LLM configuration is not available");
		}
		try {
			const provider = await this.llm.upsert(input);
			return { ok: true, data: { provider } };
		} catch (error) {
			return fail("INVALID_LLM_CONFIG", 400, error instanceof Error ? error.message : String(error));
		}
	}

	/** Remove a custom LLM provider and hot-reload the model runtime. */
	async removeLlmProvider(input: { readonly id: string }): Promise<ControlResult<{ readonly removed: boolean }>> {
		if (this.llm === undefined) {
			return fail("LLM_CONFIG_UNAVAILABLE", 503, "Custom LLM configuration is not available");
		}
		const removed = await this.llm.remove(input.id);
		return { ok: true, data: { removed } };
	}

	/** Best-effort connectivity/auth probe against a custom LLM endpoint. */
	async testLlmProvider(input: {
		readonly baseUrl: string;
		readonly api: CustomLlmApi;
		readonly apiKey?: string;
	}): Promise<
		ControlResult<{ readonly ok: boolean; readonly advertisedModels?: readonly string[]; readonly error?: string }>
	> {
		if (this.llm === undefined) {
			return fail("LLM_CONFIG_UNAVAILABLE", 503, "Custom LLM configuration is not available");
		}
		return { ok: true, data: await this.llm.test(input) };
	}

	/** List currently available runtime models (built-in + custom), for the Chat model switcher. */
	async listLlmModels(): Promise<
		ControlResult<{
			readonly items: readonly {
				readonly provider: string;
				readonly id: string;
				readonly name: string;
				readonly api: string;
				readonly reasoning: boolean;
				readonly parameterCapabilities: import("@earendil-works/pi-protocol").ModelParameterCapabilities;
			}[];
		}>
	> {
		if (this.llm === undefined) {
			return fail("LLM_CONFIG_UNAVAILABLE", 503, "Custom LLM configuration is not available");
		}
		const items = await this.llm.listAvailableModels();
		return { ok: true, data: { items } };
	}
}

export interface VersionTransitionResult {
	readonly app: PublishedAppRecord;
	readonly previousVersionId: PublishedAppVersionId | null;
	readonly auditEventId: AuditEventId;
}

export interface TenantRecordResult {
	readonly tenant: TenantRecord;
	readonly created: boolean;
}

/** Accept only SPKI public-key PEM armor; any private-key marker is rejected. */
function isPublicKeyPem(pem: string): boolean {
	return pem.startsWith("-----BEGIN PUBLIC KEY-----") && !pem.includes("PRIVATE KEY");
}

/** Verify the PEM is cryptographically a usable Ed25519 SPKI public key. */
async function isEd25519Spki(pem: string): Promise<boolean> {
	try {
		await importSPKI(pem, LAUNCH_KEY_TYPE);
		return true;
	} catch {
		return false;
	}
}

/** Parse an optional ISO-8601 timestamp, defaulting to now. */
function parseIsoOrNow(value: string | undefined, onInvalid: () => ControlResult<never>): ControlResult<Date> {
	if (value === undefined || value === "") return { ok: true, data: new Date() };
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return onInvalid();
	return { ok: true, data: parsed };
}

/** Parse an optional ISO-8601 timestamp (empty/null -> no expiry). */
function parseIsoOrNull(
	value: string | null | undefined,
	onInvalid: () => ControlResult<never>,
): ControlResult<Date | null> {
	if (value === undefined || value === null || value === "") return { ok: true, data: null };
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return onInvalid();
	return { ok: true, data: parsed };
}

/** Validate a status filter against the published-app status union, or undefined. */
function parsePublishedStatus(value: string): "draft" | "active" | "suspended" | "archived" | undefined {
	return value === "draft" || value === "active" || value === "suspended" || value === "archived" ? value : undefined;
}

/**
 * Split a `limit + 1` repo page into the visible page and the next cursor.
 * The repository returns at most `limit + 1` rows so a full page with one
 * extra row proves there is another page.
 */
function sliceCursorPage<T extends { readonly cursor: string }>(
	rows: readonly T[],
	limit: number,
): {
	readonly page: readonly T[];
	readonly nextCursor: string | null;
} {
	const page = rows.slice(0, limit);
	const nextCursor = rows.length > limit && page.length > 0 ? page[page.length - 1]!.cursor : null;
	return { page, nextCursor };
}

/**
 * Build the allowlisted capability summary of a version's RuntimeSpec for the
 * console detail view. Reads only bounded fields (model, capability ids and
 * limits) — never the system prompt or any secret. An unparseable/missing
 * spec yields null so the console can still show the app.
 */
function summarizeCapabilities(runtimeSpec: unknown): PublishedAppDetail["capabilities"] {
	if (runtimeSpec === null) return null;
	const parsed = parseRuntimeSpec(runtimeSpec);
	if (!parsed.ok) return null;
	const spec: RuntimeSpec = parsed.spec;
	return {
		model: {
			provider: spec.agent.model.provider,
			modelId: spec.agent.model.modelId,
		},
		context: {
			maxTurns: spec.contextPolicy.maxTurns,
			maxContextTokens: spec.contextPolicy.maxContextTokens,
			toolResultMaxBytes: spec.contextPolicy.toolResultMaxBytes,
		},
		profile: spec.runtimePolicy.profile,
		summary: {
			tools: spec.capabilities.tools.map((tool) => String(tool.id)),
			knowledgeBases: spec.capabilities.knowledgeBases.map((kb) => String(kb.id)),
			uploads: {
				enabled: spec.capabilities.uploads.enabled,
				maxFiles: spec.capabilities.uploads.maxFiles,
				maxFileBytes: spec.capabilities.uploads.maxFileBytes,
			},
			speech: { enabled: spec.capabilities.speech.enabled },
			avatar: { enabled: spec.capabilities.avatar.enabled },
		},
	};
}

/** WB-006: project an admin list row to its protocol summary (redacted). */
function toConversationAdminSummary(row: AdminConversationListRow): ConversationAdminSummary {
	const principalType = mapPrincipalType(row.principalType);
	return {
		id: toPublicId("ConversationId", row.conversationId) as ConversationPublicId,
		appId: toPublicId("PublishedAppId", row.publishedAppId) as PublishedAppPublicId,
		publicAppId: row.publicAppId as PublishedAppLocator,
		appName: row.appName,
		agentId:
			row.agentId === null ? ("" as AgentPublicId) : (toPublicId("AgentDefinitionId", row.agentId) as AgentPublicId),
		principalDisplayId: row.principalDisplayId,
		principalType,
		publishedAppVersionId: toPublicId(
			"PublishedAppVersionId",
			row.publishedAppVersionId,
		) as PublishedAppVersionPublicId,
		title: row.title,
		status: row.status,
		messageCount: row.messageCount,
		errorCount: row.errorCount,
		lastEventSequence: row.lastEventSequence,
		createdAt: row.createdAt.toISOString(),
		lastActiveAt: row.lastActiveAt.toISOString(),
	};
}

/** WB-006: narrow a persisted principal type to the admin-facing 4-way union. */
function mapPrincipalType(value: PrincipalType): ConversationAdminSummary["principalType"] {
	if (value === "external_user" || value === "anonymous_visitor" || value === "platform_user" || value === "service") {
		return value;
	}
	return "platform_user";
}

/** WB-006: project a persisted summary row to its admin entry. */
function toConversationAdminSummaryEntry(row: ConversationSummaryRecord): ConversationAdminSummaryEntry {
	const safeBody =
		typeof row.body === "object" && row.body !== null
			? (row.body as { text?: unknown; keyFacts?: unknown[]; openItems?: unknown[]; lastUserMessage?: unknown })
			: { text: "", keyFacts: [], openItems: [], lastUserMessage: "" };
	return {
		summaryId: row.id,
		throughSequence: row.throughSequence,
		modelId: row.modelId,
		sourceEventCount: row.sourceEventCount,
		sourceBytes: row.sourceBytes,
		lastUserMessage: typeof safeBody.lastUserMessage === "string" ? safeBody.lastUserMessage : "",
		keyFacts: Array.isArray(safeBody.keyFacts) ? safeBody.keyFacts.filter((x) => typeof x === "string") : [],
		openItems: Array.isArray(safeBody.openItems) ? safeBody.openItems.filter((x) => typeof x === "string") : [],
		createdAt: row.createdAt.toISOString(),
	};
}

/** WB-006: is the event type one of the known session event types? */
function isSessionEventType(value: string): value is SessionEventType {
	return (SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

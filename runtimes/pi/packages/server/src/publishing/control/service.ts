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
	ConversationReasoningState,
	CreateAgentDefinitionRequest,
	CreateAgentDefinitionResponse,
	CustomLlmApi,
	McpServerDetail,
	McpServerListResponse,
	McpServerRevisionSummary,
	McpStreamableHttpConfig,
	McpSyncToolsResponse,
	McpTestResponse,
	McpToolRef,
	PreviewTicket,
	PublishedAppLocator,
	PublishedAppPublicId,
	PublishedAppVersionPublicId,
	ReasoningPrincipal,
	ReasoningUpdateRequest,
	SaveAgentRevisionRequest,
	SaveAgentRevisionResponse,
	SessionEventType,
	SkillDetail,
	SkillImportResponse,
	SkillListResponse,
	SkillRevisionSummary,
	SkillToggleResponse,
	SkillValidateResponse,
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
import type { Tool as McpSdkTool } from "@modelcontextprotocol/client";
import { importSPKI } from "jose";
import {
	isTerminalTurnEvent,
	isTurnStartEvent,
	readStoredContextSnapshot,
	readStoredTurnMetrics,
	toConversationTurnMetric,
} from "../../agent-v2/query.ts";
import { applyConversationReasoning, reasoningCapabilitiesForVersion } from "../../agent-v2/reasoning.ts";
import { validateOriginList } from "../../embed/auth/origin.ts";
import { modelParameterCapabilities, validateModelParameters } from "../../model-parameters.ts";
import type {
	AgentDefinitionId,
	AuditEventId,
	ConversationId,
	McpServerId,
	PublishedAppId,
	PublishedAppVersionId,
	RequestId,
	SkillId,
	TenantId,
	TurnId,
} from "../domain/ids.ts";
import {
	fromPublicId,
	idPrefix,
	newAgentDefinitionId,
	newAuditEventId,
	newLaunchKeyId,
	newMcpSecretId,
	newMcpServerId,
	newMcpToolId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newRequestId,
	newSkillArtifactId,
	newSkillId,
	newTenantId,
	toPublicId,
} from "../domain/ids.ts";
import type { AccessMode, PrincipalType } from "../domain/states.ts";
import { exportSessionLines } from "../export/session-export.ts";
import type { McpSecretBox } from "../mcp/secret-box.ts";
import {
	connectSecureMcpClient,
	type McpNetworkPolicy,
	McpNetworkPolicyError,
	type SecureMcpClientSession,
	validateMcpEndpoint,
} from "../mcp/secure-client.ts";
import type { PreviewTicketService } from "../preview-ticket.ts";
import type {
	AdminConversationListRow,
	ConversationEventRecord,
	ConversationSummaryRecord,
	LaunchKeyRecord,
	McpServerRevisionRecord,
	McpToolRecord,
	PublishedAppRecord,
	PublishedAppVersionRecord,
	PublishingRepositories,
	TenantRecord,
} from "../repositories.ts";
import {
	type AgentDraftConfig,
	type CapabilityCatalog,
	type CompilerInput,
	compileRuntimeSpec,
} from "../runtime-spec/compiler.ts";
import { canonicalJson, sha256Hex } from "../runtime-spec/hash.ts";
import { PLATFORM_LIMITS, parseRuntimeSpec, type RuntimeSpec } from "../runtime-spec/schema.ts";
import type { CustomLlmProviderView, LlmConfigStore } from "./llm-config.ts";
import { parseSkillArtifact, SkillImportRejected } from "./skill-import.ts";

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
	/** Required for MCP bearer-secret write/read operations. */
	readonly mcpSecretBox?: McpSecretBox;
	readonly mcpNetworkPolicy?: McpNetworkPolicy;
}

export type ControlErrorCode =
	| "BOOTSTRAP_MISMATCH" // tenant exists with different name/status (409)
	| "AGENT_NOT_FOUND" // agent/revision not visible in the tenant scope (404)
	| "AGENT_REVISION_NOT_FOUND" // specific agent revision not visible (404)
	| "AGENT_SAVE_FAILED" // saving a new revision failed (500)
	| "AGENT_NAME_CONFLICT" // active Agent with the same name already exists (409)
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
	| "CONVERSATION_STATE_CONFLICT" // lifecycle transition is invalid or raced (409)
	| "CONVERSATION_LIFECYCLE_UNAVAILABLE" // admin lifecycle storage unavailable (503)
	| "CONFLICT" // unexpected concurrent conflict (409)
	| "LLM_CONFIG_UNAVAILABLE" // Custom LLM console disabled (503)
	| "INVALID_LLM_CONFIG" // Custom LLM provider failed validation (400)
	| "INVALID_MODEL_PARAMETERS" // Agent model parameters failed capability validation (400)
	| "INVALID_AGENT_NAME" // Agent name failed length validation (400)
	| "INVALID_AGENT_DESCRIPTION" // Agent description failed length validation (400)
	| "INVALID_SYSTEM_PROMPT" // Agent system prompt exceeds the platform limit (400)
	| "SKILL_NOT_FOUND"
	| "SKILL_INVALID"
	| "SKILL_IMPORT_REJECTED"
	| "SKILL_NAME_CONFLICT"
	| "SKILL_BINDING_VIOLATION"
	| "MCP_SERVER_NOT_FOUND"
	| "MCP_TEST_FAILED"
	| "MCP_SYNC_FAILED"
	| "MCP_BINDING_VIOLATION"
	| "MCP_SECRET_NOT_CONFIGURED"
	| "MCP_CONFIG_NOT_APPROVED"
	| "MCP_NAME_CONFLICT"
	| "AGENT_HAS_ASSOCIATED_APPS" // Agent cannot be deleted while applications reference it (409)
	| "DELETE_NOT_SUPPORTED" // Repository does not implement subject deletion (501)
	| "DELETE_CONFIRMATION_MISMATCH" // Confirmation name does not match the resource (400)
	| "METRICS_UNAVAILABLE" // Agent V2 metrics subsystem disabled/unavailable (503)
	| "CONTEXT_SNAPSHOT_UNAVAILABLE" // Agent V2 context snapshot subsystem unavailable (503)
	| "INVALID_METRICS_FILTER" // metrics/context query params invalid (422)
	// Agent V2 §4.3: conversation reasoning effort overrides.
	| "REASONING_INVALID_EFFORT" // effort not in the model's declared tiers (422)
	| "REASONING_NOT_CONFIGURABLE"; // policy forbids adjusting this conversation (403)

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

/**
 * Partial-update input for `updatePublishedApp`. Only `name` and
 * `allowedOrigins` are exposed today — `accessMode` / `theme` / `status`
 * changes go through dedicated routes. Empty patch (both undefined) is a
 * no-op that returns the existing record without writing an audit event.
 */
export interface UpdatePublishedAppInput {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly name?: string;
	readonly allowedOrigins?: readonly string[];
	readonly requestId?: RequestId;
}

export interface UpdatePublishedAppResult {
	readonly app: PublishedAppRecord;
	/**
	 * Empty string sentinel for the no-op case (both fields undefined) so the
	 * caller can distinguish "no change" from a real audit id. The HTTP layer
	 * maps this to `null` in the wire response.
	 */
	readonly auditEventId: AuditEventId;
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
	private readonly mcpSecretBox: McpSecretBox | undefined;
	private readonly mcpNetworkPolicy: McpNetworkPolicy;

	constructor(options: ControlServiceOptions) {
		this.repos = options.repositories;
		this.catalog = options.catalog;
		this.embedBaseUrl = options.embedBaseUrl.replace(/\/+$/, "");
		this.previewTicketService = options.previewTicketService;
		this.llm = options.llm;
		this.metricsEnabled = options.metricsEnabled ?? false;
		this.mcpSecretBox = options.mcpSecretBox;
		this.mcpNetworkPolicy = options.mcpNetworkPolicy ?? {};
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
		const now = new Date();
		const record = await this.repos.agentDefinitions.importByName({
			tenantId: input.tenantId,
			name: collected.name,
			draftConfig: collected.config,
			sourceHash,
			createdAt: now,
			updatedAt: now,
		});
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "agent.imported",
			resourceType: "agent_definition",
			resourceId: record.agentDefinitionId,
			metadata: { revision: record.revision, sourceHash: record.sourceHash },
		});
		return {
			ok: true,
			data: {
				agentDefinitionId: record.agentDefinitionId,
				revision: record.revision,
				sourceHash: record.sourceHash,
				warnings: collected.warnings,
			},
		};
	}

	/** Create a new Agent and its first immutable revision. */
	async createAgentDefinition(input: {
		readonly tenantId: TenantId;
		readonly request: CreateAgentDefinitionRequest;
	}): Promise<ControlResult<CreateAgentDefinitionResponse>> {
		const name = input.request.name.trim();
		const validation = await this.validateAgentDraftRequest({
			...input.request,
			name,
			changeSummary: "",
		});
		if (!validation.ok) return validation;
		const draft = this.requestToDraft({ ...input.request, name, changeSummary: "" });
		const sourceHash = sha256Hex(
			canonicalJson({ draft, skills: input.request.skills ?? [], mcpServers: input.request.mcpServers ?? [] }),
		);
		const now = new Date();
		const agentDefinitionId = newAgentDefinitionId();
		const skillBindings = this.skillBindingsFromRequest(input.request.skills ?? []);
		if (!skillBindings.ok) return skillBindings;
		const mcpBindings = this.mcpBindingsFromRequest(input.request.mcpServers ?? []);
		if (!mcpBindings.ok) return mcpBindings;
		const created = await this.repos.agentDefinitions.createInitialWithSkillBindings(
			{
				agentDefinitionId,
				tenantId: input.tenantId,
				name,
				revision: 1,
				draftConfig: draft,
				sourceHash,
				createdAt: now,
				updatedAt: now,
			},
			skillBindings.data,
			mcpBindings.data,
		);
		if (created === "name_conflict")
			return fail("AGENT_NAME_CONFLICT", 409, "an active Agent with this name already exists");
		if (created === "skill_unavailable")
			return fail("SKILL_NOT_FOUND", 404, "one or more Skill revisions are unavailable");
		if (created === "mcp_unavailable")
			return fail("MCP_BINDING_VIOLATION", 409, "one or more MCP bindings are unavailable");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "agent.created",
			resourceType: "agent_definition",
			resourceId: agentDefinitionId,
			metadata: { revision: 1, sourceHash },
		});
		return {
			ok: true,
			data: {
				id: toPublicId("AgentDefinitionId", agentDefinitionId) as CreateAgentDefinitionResponse["id"],
				revision: 1,
				sourceHash,
				createdAt: now.toISOString(),
			},
		};
	}

	/** Create a `draft` published app (spec 27.1). */
	async createPublishedApp(input: CreatePublishedAppInput): Promise<ControlResult<CreatePublishedAppResult>> {
		if (input.allowedOrigins !== undefined) {
			const validation = validateOriginList(input.allowedOrigins);
			if (!validation.ok) {
				return fail("INVALID_ORIGINS", 400, `invalid allowedOrigins: ${validation.errors.join("; ")}`);
			}
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
		const inserted = await this.repos.publishedApps.insertForActiveAgent(app);
		if (!inserted) return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "published-app.created",
			resourceType: "published_app",
			resourceId: publishedAppId,
			metadata: { agentDefinitionId: input.agentDefinitionId },
		});
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
		const skillBindings = await this.repos.skills.listBindings(
			agentScope,
			app.agentDefinitionId,
			input.sourceAgentRevision,
		);
		const skills: NonNullable<CompilerInput["skills"]>[number][] = [];
		for (const binding of skillBindings) {
			const skill = await this.repos.skills.get(agentScope, binding.skillId);
			const revision = await this.repos.skills.getRevision(agentScope, binding.skillId, binding.skillRevision);
			if (skill === undefined || skill.status !== "enabled" || revision === undefined) {
				return fail("SKILL_NOT_FOUND", 404, "a bound Skill revision is unavailable");
			}
			skills.push({
				skillId: toPublicId("SkillId", revision.skillId),
				revision: revision.revision,
				sourceHash: revision.sourceHash,
				name: revision.parsedName,
				description: revision.description,
				instructionText: revision.instructionText,
				disableModelInvocation: revision.disableModelInvocation,
			});
		}
		const mcpBindings = await this.repos.mcpServers.listBindings(
			agentScope,
			app.agentDefinitionId,
			input.sourceAgentRevision,
		);
		const mcpServers: NonNullable<CompilerInput["mcpServers"]>[number][] = [];
		for (const binding of mcpBindings) {
			const server = await this.repos.mcpServers.get(agentScope, binding.mcpServerId);
			const revision = await this.repos.mcpServers.getRevision(agentScope, binding.mcpServerId, binding.mcpRevision);
			if (server === undefined || server.status !== "enabled" || revision === undefined)
				return fail("MCP_BINDING_VIOLATION", 409, "a bound MCP Server revision is unavailable");
			if (
				revision.authentication === "bearer" &&
				!(await this.repos.mcpSecrets.has(agentScope, binding.mcpServerId))
			) {
				return fail("MCP_SECRET_NOT_CONFIGURED", 409, "a bound MCP Server credential is not configured");
			}
			const discoveredTools = await this.repos.mcpServers.listTools(
				agentScope,
				binding.mcpServerId,
				binding.mcpRevision,
			);
			const allowed = new Set(binding.toolAllowlist);
			const tools = discoveredTools.filter((tool) => allowed.has(tool.name));
			if (tools.length !== allowed.size)
				return fail(
					"MCP_BINDING_VIOLATION",
					409,
					"an MCP Tool allowlist does not match its frozen discovery snapshot",
				);
			mcpServers.push({
				mcpServerId: toPublicId("McpServerId", binding.mcpServerId),
				revision: binding.mcpRevision,
				transport: revision.transport,
				endpoint: revision.endpoint,
				authentication: revision.authentication,
				tools: tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					inputSchemaHash: tool.inputSchemaHash,
				})),
			});
		}
		const compiled = compileRuntimeSpec({
			agent: agent.draftConfig as AgentDraftConfig,
			publishedAppVersionId: versionId,
			catalog: this.catalog,
			skills,
			mcpServers,
		});
		const now = new Date();
		const version: Omit<PublishedAppVersionRecord, "versionNumber"> = {
			publishedAppVersionId: versionId,
			tenantId: input.tenantId,
			publishedAppId: input.publishedAppId,
			sourceAgentRevision: input.sourceAgentRevision,
			snapshot: { agent: agent.draftConfig, skills, mcpServers },
			runtimeSpec: compiled.ok ? compiled.spec : null,
			runtimeSpecHash: compiled.ok ? compiled.sha256 : null,
			status: compiled.ok ? "ready" : "rejected",
			validationErrors: compiled.ok ? [] : compiled.errors,
			createdAt: now,
		};
		const created = await this.repos.publishedAppVersions.createVersionGuarded(appScope, version, {
			skills: skillBindings.map((binding) => ({ skillId: binding.skillId, revision: binding.skillRevision })),
			mcpServers: mcpBindings.map((binding) => {
				const server = mcpServers.find(
					(candidate) => candidate.mcpServerId === toPublicId("McpServerId", binding.mcpServerId),
				);
				return {
					mcpServerId: binding.mcpServerId,
					revision: binding.mcpRevision,
					requiresSecret: server?.authentication === "bearer",
				};
			}),
		});
		if (created === undefined)
			return fail("MCP_BINDING_VIOLATION", 409, "a bound capability changed while creating the version");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "published-app.version-created",
			resourceType: "published_app_version",
			resourceId: created.publishedAppVersionId,
			metadata: {
				publishedAppId: input.publishedAppId,
				versionNumber: created.versionNumber,
				status: created.status,
			},
		});
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
		const [skills, mcpServers] = await Promise.all([
			this.repos.skills.listBindings({ tenantId: input.tenantId }, input.agentDefinitionId, latest.revision),
			this.repos.mcpServers.listBindings({ tenantId: input.tenantId }, input.agentDefinitionId, latest.revision),
		]);
		return {
			ok: true,
			data: this.agentDetailView(latest, filteredApps.length, skills, mcpServers),
		};
	}

	async deleteAgentDefinition(input: {
		readonly tenantId: TenantId;
		readonly agentDefinitionId: AgentDefinitionId;
		readonly confirmName: string;
	}): Promise<ControlResult<{ readonly deleted: true }>> {
		const latest = await this.repos.agentDefinitions.getLatest({ tenantId: input.tenantId }, input.agentDefinitionId);
		if (latest === undefined) return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		if (input.confirmName !== latest.name)
			return fail("DELETE_CONFIRMATION_MISMATCH", 400, "confirmation name does not match the Agent name");
		const outcome = await this.repos.agentDefinitions.softDeleteIfUnreferenced(
			{ tenantId: input.tenantId },
			input.agentDefinitionId,
		);
		if (outcome === "has_associated_apps")
			return fail("AGENT_HAS_ASSOCIATED_APPS", 409, "Agent is still associated with one or more applications");
		if (outcome === "not_found") return fail("AGENT_NOT_FOUND", 404, "agent definition not found in tenant scope");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "agent.deleted",
			resourceType: "agent_definition",
			resourceId: input.agentDefinitionId,
			metadata: {},
		});
		return { ok: true, data: { deleted: true } };
	}

	async deletePublishedApp(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly confirmName: string;
	}): Promise<ControlResult<{ readonly deleted: true }>> {
		const scope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(scope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");
		if (input.confirmName !== app.name)
			return fail("DELETE_CONFIRMATION_MISMATCH", 400, "confirmation name does not match the application name");
		if (this.repos.publishedApps.softDelete === undefined)
			return fail("DELETE_NOT_SUPPORTED", 501, "application deletion is not supported by this repository");
		await this.repos.publishedApps.softDelete(scope, input.publishedAppId);
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "published-app.deleted",
			resourceType: "published_app",
			resourceId: input.publishedAppId,
			metadata: {},
		});
		return { ok: true, data: { deleted: true } };
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
		const [skills, mcpServers] = await Promise.all([
			this.repos.skills.listBindings({ tenantId: input.tenantId }, input.agentDefinitionId, input.revision),
			this.repos.mcpServers.listBindings({ tenantId: input.tenantId }, input.agentDefinitionId, input.revision),
		]);
		return { ok: true, data: this.revisionView(record, previous, skills, mcpServers) };
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
		const name = input.request.name?.trim() ?? latest.name;
		const validation = await this.validateAgentDraftRequest({ ...input.request, name });
		if (!validation.ok) return validation;
		const nextRevision = latest.revision + 1;
		const draft = this.requestToDraft(input.request);
		const sourceHash = sha256Hex(
			canonicalJson({ draft, skills: input.request.skills ?? [], mcpServers: input.request.mcpServers ?? [] }),
		);
		const now = new Date();
		const skillBindings = this.skillBindingsFromRequest(input.request.skills ?? []);
		if (!skillBindings.ok) return skillBindings;
		const mcpBindings = this.mcpBindingsFromRequest(input.request.mcpServers ?? []);
		if (!mcpBindings.ok) return mcpBindings;
		const inserted = await this.repos.agentDefinitions.insertWithSkillBindings(
			{
				agentDefinitionId: input.agentDefinitionId,
				tenantId: input.tenantId,
				name,
				revision: nextRevision,
				draftConfig: draft,
				sourceHash,
				createdAt: now,
				updatedAt: now,
			},
			skillBindings.data,
			mcpBindings.data,
		);
		if (inserted === "skill_unavailable")
			return fail("SKILL_NOT_FOUND", 404, "one or more Skill revisions are unavailable");
		if (inserted === "mcp_unavailable")
			return fail("MCP_BINDING_VIOLATION", 409, "one or more MCP bindings are unavailable");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "agent.revision-created",
			resourceType: "agent_definition",
			resourceId: input.agentDefinitionId,
			metadata: { revision: nextRevision, sourceHash },
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

	async importSkill(input: {
		readonly tenantId: TenantId;
		readonly filename: string;
		readonly bytes: Uint8Array;
	}): Promise<ControlResult<SkillImportResponse>> {
		let parsed: Awaited<ReturnType<typeof parseSkillArtifact>>;
		try {
			parsed = await parseSkillArtifact(input.filename, input.bytes);
		} catch (error) {
			if (error instanceof SkillImportRejected) return fail(error.code, 422, error.message);
			throw error;
		}
		const now = new Date();
		const skillId = newSkillId();
		const artifactId = newSkillArtifactId();
		const outcome = await this.repos.skills.create({
			skill: {
				skillId,
				tenantId: input.tenantId,
				name: parsed.name,
				status: "enabled",
				currentRevision: 1,
				createdAt: now,
				updatedAt: now,
			},
			artifact: {
				artifactId,
				tenantId: input.tenantId,
				filename: parsed.filename,
				mediaType: parsed.mediaType,
				sourceHash: parsed.sourceHash,
				sizeBytes: parsed.bytes.byteLength,
				content: parsed.bytes,
				createdAt: now,
			},
			revision: {
				skillId,
				tenantId: input.tenantId,
				revision: 1,
				artifactId,
				sourceHash: parsed.sourceHash,
				parsedName: parsed.name,
				description: parsed.description,
				instructionText: parsed.instructionText,
				disableModelInvocation: parsed.disableModelInvocation,
				diagnostics: parsed.diagnostics,
				createdAt: now,
			},
		});
		if (outcome === "name_conflict") return fail("SKILL_NAME_CONFLICT", 409, "an active Skill with this name exists");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "skill.created",
			resourceType: "skill",
			resourceId: skillId,
			metadata: { revision: 1, sourceHash: parsed.sourceHash },
		});
		return {
			ok: true,
			data: {
				id: toPublicId("SkillId", skillId),
				revision: 1,
				sourceHash: parsed.sourceHash,
				warnings: parsed.diagnostics,
			},
		};
	}

	async addSkillRevision(input: {
		readonly tenantId: TenantId;
		readonly skillId: SkillId;
		readonly filename: string;
		readonly bytes: Uint8Array;
	}): Promise<ControlResult<SkillImportResponse>> {
		let parsed: Awaited<ReturnType<typeof parseSkillArtifact>>;
		try {
			parsed = await parseSkillArtifact(input.filename, input.bytes);
		} catch (error) {
			if (error instanceof SkillImportRejected) return fail(error.code, 422, error.message);
			throw error;
		}
		const existing = await this.repos.skills.get({ tenantId: input.tenantId }, input.skillId);
		if (existing === undefined) return fail("SKILL_NOT_FOUND", 404, "Skill not found in tenant scope");
		if (existing.name !== parsed.name)
			return fail("SKILL_INVALID", 422, "a Skill revision cannot change the Skill name");
		const now = new Date();
		const artifactId = newSkillArtifactId();
		const revision = await this.repos.skills.addRevision({
			scope: { tenantId: input.tenantId },
			skillId: input.skillId,
			artifact: {
				artifactId,
				tenantId: input.tenantId,
				filename: parsed.filename,
				mediaType: parsed.mediaType,
				sourceHash: parsed.sourceHash,
				sizeBytes: parsed.bytes.byteLength,
				content: parsed.bytes,
				createdAt: now,
			},
			revision: {
				skillId: input.skillId,
				tenantId: input.tenantId,
				artifactId,
				sourceHash: parsed.sourceHash,
				parsedName: parsed.name,
				description: parsed.description,
				instructionText: parsed.instructionText,
				disableModelInvocation: parsed.disableModelInvocation,
				diagnostics: parsed.diagnostics,
				createdAt: now,
			},
		});
		if (revision === undefined) return fail("SKILL_NOT_FOUND", 404, "Skill not found in tenant scope");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "skill.revision-created",
			resourceType: "skill",
			resourceId: input.skillId,
			metadata: { revision: revision.revision, sourceHash: revision.sourceHash },
		});
		return {
			ok: true,
			data: {
				id: toPublicId("SkillId", input.skillId),
				revision: revision.revision,
				sourceHash: revision.sourceHash,
				warnings: revision.diagnostics,
			},
		};
	}

	async listSkills(input: {
		readonly tenantId: TenantId;
		readonly limit: number;
		readonly cursor?: string;
	}): Promise<ControlResult<SkillListResponse>> {
		const rows = await this.repos.skills.list({ tenantId: input.tenantId }, input.limit, input.cursor);
		const page = rows.slice(0, input.limit);
		const next = rows.length > input.limit ? rows[input.limit - 1] : undefined;
		return {
			ok: true,
			data: {
				items: page.map((skill) => ({
					id: toPublicId("SkillId", skill.skillId),
					name: skill.name,
					kind: "file",
					currentRevision: skill.currentRevision,
					enabled: skill.status === "enabled",
					updatedAt: skill.updatedAt.toISOString(),
				})),
				nextCursor: next === undefined ? null : `${next.updatedAt.toISOString()}|${next.skillId}`,
			},
		};
	}

	async getSkillDetail(input: {
		readonly tenantId: TenantId;
		readonly skillId: SkillId;
	}): Promise<ControlResult<SkillDetail>> {
		const scope = { tenantId: input.tenantId };
		const skill = await this.repos.skills.get(scope, input.skillId);
		if (skill === undefined) return fail("SKILL_NOT_FOUND", 404, "Skill not found in tenant scope");
		const revisions = await this.repos.skills.listRevisions(scope, input.skillId);
		const bindings = await this.repos.skills.listBindingsForSkill(scope, input.skillId);
		const revisionView = (revision: (typeof revisions)[number]): SkillRevisionSummary => ({
			id: toPublicId("SkillId", revision.skillId),
			revision: revision.revision,
			sourceHash: revision.sourceHash,
			diagnostics: revision.diagnostics,
			createdBy: String(input.tenantId),
			createdAt: revision.createdAt.toISOString(),
		});
		return {
			ok: true,
			data: {
				id: toPublicId("SkillId", skill.skillId),
				name: skill.name,
				kind: "file",
				currentRevision: skill.currentRevision,
				enabled: skill.status === "enabled",
				updatedAt: skill.updatedAt.toISOString(),
				revisions: revisions.map(revisionView),
				boundAgents: bindings.map((binding) => ({
					agentId: toPublicId("AgentDefinitionId", binding.agentDefinitionId) as AgentPublicId,
					agentRevision: binding.agentRevision,
				})),
			},
		};
	}

	async validateSkill(input: {
		readonly tenantId: TenantId;
		readonly skillId: SkillId;
	}): Promise<ControlResult<SkillValidateResponse>> {
		const skill = await this.repos.skills.get({ tenantId: input.tenantId }, input.skillId);
		if (skill === undefined) return fail("SKILL_NOT_FOUND", 404, "Skill not found in tenant scope");
		const revision = await this.repos.skills.getRevision(
			{ tenantId: input.tenantId },
			input.skillId,
			skill.currentRevision,
		);
		if (revision === undefined) return fail("SKILL_NOT_FOUND", 404, "Skill revision not found in tenant scope");
		return {
			ok: true,
			data: {
				id: toPublicId("SkillId", input.skillId),
				revision: revision.revision,
				diagnostics: revision.diagnostics,
			},
		};
	}

	async setSkillStatus(input: {
		readonly tenantId: TenantId;
		readonly skillId: SkillId;
		readonly enabled: boolean;
	}): Promise<ControlResult<SkillToggleResponse>> {
		const updated = await this.repos.skills.setStatus(
			{ tenantId: input.tenantId },
			input.skillId,
			input.enabled ? "enabled" : "disabled",
		);
		if (!updated) return fail("SKILL_NOT_FOUND", 404, "Skill not found in tenant scope");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: input.enabled ? "skill.enabled" : "skill.disabled",
			resourceType: "skill",
			resourceId: input.skillId,
			metadata: {},
		});
		return { ok: true, data: { id: toPublicId("SkillId", input.skillId), enabled: input.enabled } };
	}

	async deleteSkill(input: {
		readonly tenantId: TenantId;
		readonly skillId: SkillId;
	}): Promise<ControlResult<{ readonly deleted: true }>> {
		const outcome = await this.repos.skills.softDeleteIfUnreferenced({ tenantId: input.tenantId }, input.skillId);
		if (outcome === "not_found") return fail("SKILL_NOT_FOUND", 404, "Skill not found in tenant scope");
		if (outcome === "published_reference")
			return fail("SKILL_BINDING_VIOLATION", 409, "Skill is referenced by a Published App Version");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "skill.deleted",
			resourceType: "skill",
			resourceId: input.skillId,
			metadata: {},
		});
		return { ok: true, data: { deleted: true } };
	}

	async createMcpServer(input: {
		readonly tenantId: TenantId;
		readonly name: string;
		readonly config: McpStreamableHttpConfig;
	}): Promise<ControlResult<McpServerDetail>> {
		const name = input.name.trim();
		if (name.length < 1 || name.length > 100)
			return fail("MCP_CONFIG_NOT_APPROVED", 422, "MCP name must be 1-100 characters");
		const config = this.validateMcpConfig(input.config);
		if (!config.ok) return config;
		const now = new Date();
		const mcpServerId = newMcpServerId();
		const outcome = await this.repos.mcpServers.create({
			server: {
				mcpServerId,
				tenantId: input.tenantId,
				name,
				status: "enabled",
				currentRevision: 1,
				lastTestOk: null,
				lastTestLatencyMs: null,
				lastTestAt: null,
				createdAt: now,
				updatedAt: now,
			},
			revision: {
				mcpServerId,
				tenantId: input.tenantId,
				revision: 1,
				...config.data,
				createdAt: now,
			},
		});
		if (outcome === "name_conflict")
			return fail("MCP_NAME_CONFLICT", 409, "an active MCP Server with this name exists");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "mcp-server.created",
			resourceType: "mcp_server",
			resourceId: mcpServerId,
			metadata: { revision: 1, transport: config.data.transport },
		});
		return this.getMcpServerDetail({ tenantId: input.tenantId, mcpServerId });
	}

	async addMcpServerRevision(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
		readonly config: McpStreamableHttpConfig;
	}): Promise<ControlResult<McpServerRevisionSummary>> {
		const config = this.validateMcpConfig(input.config);
		if (!config.ok) return config;
		const revision = await this.repos.mcpServers.addRevision({
			scope: { tenantId: input.tenantId },
			mcpServerId: input.mcpServerId,
			revision: {
				mcpServerId: input.mcpServerId,
				tenantId: input.tenantId,
				...config.data,
				createdAt: new Date(),
			},
			tools: [],
		});
		if (revision === undefined) return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "mcp-server.revision-created",
			resourceType: "mcp_server",
			resourceId: input.mcpServerId,
			metadata: { revision: revision.revision },
		});
		return {
			ok: true,
			data: {
				revision: revision.revision,
				config: config.data,
				tools: [],
				createdAt: revision.createdAt.toISOString(),
			},
		};
	}

	async listMcpServers(input: {
		readonly tenantId: TenantId;
		readonly limit: number;
		readonly cursor?: string;
	}): Promise<ControlResult<McpServerListResponse>> {
		const scope = { tenantId: input.tenantId };
		const rows = await this.repos.mcpServers.list(scope, input.limit, input.cursor);
		const page = rows.slice(0, input.limit);
		const next = rows.length > input.limit ? rows[input.limit - 1] : undefined;
		const items = await Promise.all(
			page.map(async (server) => {
				const tools = await this.repos.mcpServers.listTools(scope, server.mcpServerId, server.currentRevision);
				return {
					id: toPublicId("McpServerId", server.mcpServerId),
					name: server.name,
					status: server.status,
					currentRevision: server.currentRevision,
					transport: "streamable_http" as const,
					toolCount: tools.length,
					secretConfigured: await this.repos.mcpSecrets.has(scope, server.mcpServerId),
					updatedAt: server.updatedAt.toISOString(),
				};
			}),
		);
		return {
			ok: true,
			data: {
				items,
				nextCursor: next === undefined ? null : `${next.updatedAt.toISOString()}|${next.mcpServerId}`,
			},
		};
	}

	async getMcpServerDetail(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
	}): Promise<ControlResult<McpServerDetail>> {
		const scope = { tenantId: input.tenantId };
		const server = await this.repos.mcpServers.get(scope, input.mcpServerId);
		if (server === undefined) return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
		const revisions = await this.repos.mcpServers.listRevisions(scope, input.mcpServerId);
		const revisionViews = await Promise.all(
			revisions.map(
				async (revision): Promise<McpServerRevisionSummary> => ({
					revision: revision.revision,
					config: {
						transport: revision.transport,
						endpoint: revision.endpoint,
						authentication: revision.authentication,
					},
					tools: (await this.repos.mcpServers.listTools(scope, input.mcpServerId, revision.revision)).map((tool) =>
						this.mcpToolView(tool),
					),
					createdAt: revision.createdAt.toISOString(),
				}),
			),
		);
		const bindings = await this.repos.mcpServers.listBindingsForServer(scope, input.mcpServerId);
		const currentTools = revisionViews.find((revision) => revision.revision === server.currentRevision)?.tools ?? [];
		return {
			ok: true,
			data: {
				id: toPublicId("McpServerId", server.mcpServerId),
				name: server.name,
				status: server.status,
				currentRevision: server.currentRevision,
				transport: "streamable_http",
				toolCount: currentTools.length,
				secretConfigured: await this.repos.mcpSecrets.has(scope, input.mcpServerId),
				updatedAt: server.updatedAt.toISOString(),
				revisions: revisionViews,
				boundAgents: bindings.map((binding) => ({
					agentId: toPublicId("AgentDefinitionId", binding.agentDefinitionId) as AgentPublicId,
					agentRevision: binding.agentRevision,
				})),
				lastTest:
					server.lastTestAt === null || server.lastTestOk === null
						? null
						: { ok: server.lastTestOk, latencyMs: server.lastTestLatencyMs, at: server.lastTestAt.toISOString() },
			},
		};
	}

	async replaceMcpSecret(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
		readonly bearerToken: string;
	}): Promise<ControlResult<{ readonly id: string; readonly secretConfigured: true }>> {
		const server = await this.repos.mcpServers.get({ tenantId: input.tenantId }, input.mcpServerId);
		if (server === undefined) return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
		if (this.mcpSecretBox === undefined)
			return fail("MCP_SECRET_NOT_CONFIGURED", 503, "MCP secret store is unavailable");
		if (input.bearerToken.length < 1 || input.bearerToken.length > 16_384)
			return fail("MCP_CONFIG_NOT_APPROVED", 422, "MCP bearer token length is invalid");
		const sealed = this.mcpSecretBox.seal(input.tenantId, input.mcpServerId, input.bearerToken);
		await this.repos.mcpSecrets.put({
			secretId: newMcpSecretId(),
			tenantId: input.tenantId,
			mcpServerId: input.mcpServerId,
			...sealed,
		});
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "mcp-server.secret-replaced",
			resourceType: "mcp_server",
			resourceId: input.mcpServerId,
			metadata: { secretConfigured: true },
		});
		return { ok: true, data: { id: toPublicId("McpServerId", input.mcpServerId), secretConfigured: true } };
	}

	async testMcpServer(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
		readonly signal?: AbortSignal;
	}): Promise<ControlResult<McpTestResponse>> {
		const startedAt = Date.now();
		const connected = await this.openMcpServer(input);
		if (!connected.ok) {
			if (connected.error.code === "MCP_TEST_FAILED") {
				await this.repos.mcpServers.setLastTest({ tenantId: input.tenantId }, input.mcpServerId, {
					ok: false,
					latencyMs: Date.now() - startedAt,
				});
			}
			return connected;
		}
		try {
			const tools = await connected.data.session.listTools(input.signal);
			const toolViews = this.discoveredMcpTools(
				input.tenantId,
				input.mcpServerId,
				connected.data.revision.revision,
				tools,
			).map((tool) => this.mcpToolView(tool));
			const latencyMs = Date.now() - startedAt;
			await this.repos.mcpServers.setLastTest({ tenantId: input.tenantId }, input.mcpServerId, {
				ok: true,
				latencyMs,
			});
			await this.writeAudit({
				tenantId: input.tenantId,
				action: "mcp-server.tested",
				resourceType: "mcp_server",
				resourceId: input.mcpServerId,
				metadata: { ok: true, latencyMs, toolCount: toolViews.length },
			});
			return { ok: true, data: { ok: true, latencyMs, tools: toolViews } };
		} catch {
			const latencyMs = Date.now() - startedAt;
			await this.repos.mcpServers.setLastTest({ tenantId: input.tenantId }, input.mcpServerId, {
				ok: false,
				latencyMs,
			});
			return fail("MCP_TEST_FAILED", 422, "MCP connection or Tool discovery failed");
		} finally {
			await connected.data.session.close();
		}
	}

	async syncMcpTools(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
		readonly signal?: AbortSignal;
	}): Promise<ControlResult<McpSyncToolsResponse>> {
		const connected = await this.openMcpServer(input);
		if (!connected.ok) return connected;
		try {
			const discovered = await connected.data.session.listTools(input.signal);
			if (discovered.length === 0) {
				return fail("MCP_SYNC_FAILED", 422, "MCP Tool discovery returned no Tools");
			}
			const oldTools = await this.repos.mcpServers.listTools(
				{ tenantId: input.tenantId },
				input.mcpServerId,
				connected.data.revision.revision,
			);
			const nextTools = this.discoveredMcpTools(
				input.tenantId,
				input.mcpServerId,
				connected.data.revision.revision + 1,
				discovered,
			);
			const oldByName = new Map(oldTools.map((tool) => [tool.name, tool]));
			const nextByName = new Map(nextTools.map((tool) => [tool.name, tool]));
			const added = [...nextByName.keys()].filter((name) => !oldByName.has(name)).sort();
			const removed = [...oldByName.keys()].filter((name) => !nextByName.has(name)).sort();
			const changed = [...nextByName.entries()]
				.filter(([name, tool]) => {
					const oldTool = oldByName.get(name);
					return (
						oldTool !== undefined &&
						(oldTool.inputSchemaHash !== tool.inputSchemaHash || oldTool.description !== tool.description)
					);
				})
				.map(([name]) => name)
				.sort();
			const created = await this.repos.mcpServers.addRevision({
				scope: { tenantId: input.tenantId },
				mcpServerId: input.mcpServerId,
				revision: {
					mcpServerId: connected.data.revision.mcpServerId,
					tenantId: connected.data.revision.tenantId,
					transport: connected.data.revision.transport,
					endpoint: connected.data.revision.endpoint,
					authentication: connected.data.revision.authentication,
					createdAt: new Date(),
				},
				tools: nextTools.map(({ mcpRevision: _mcpRevision, ...tool }) => tool),
			});
			if (created === undefined) return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
			await this.writeAudit({
				tenantId: input.tenantId,
				action: "mcp-server.tools-synced",
				resourceType: "mcp_server",
				resourceId: input.mcpServerId,
				metadata: { revision: created.revision, added, removed, changed },
			});
			return { ok: true, data: { ok: true, revision: created.revision, added, removed, changed } };
		} catch {
			return fail("MCP_SYNC_FAILED", 422, "MCP Tool discovery failed");
		} finally {
			await connected.data.session.close();
		}
	}

	async setMcpServerStatus(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
		readonly enabled: boolean;
	}): Promise<ControlResult<{ readonly id: string; readonly enabled: boolean }>> {
		const updated = await this.repos.mcpServers.setStatus(
			{ tenantId: input.tenantId },
			input.mcpServerId,
			input.enabled ? "enabled" : "disabled",
		);
		if (!updated) return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: input.enabled ? "mcp-server.enabled" : "mcp-server.disabled",
			resourceType: "mcp_server",
			resourceId: input.mcpServerId,
			metadata: {},
		});
		return { ok: true, data: { id: toPublicId("McpServerId", input.mcpServerId), enabled: input.enabled } };
	}

	async deleteMcpServer(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
	}): Promise<ControlResult<{ readonly deleted: true }>> {
		const outcome = await this.repos.mcpServers.softDeleteIfUnreferenced(
			{ tenantId: input.tenantId },
			input.mcpServerId,
		);
		if (outcome === "not_found") return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
		if (outcome === "published_reference")
			return fail("MCP_BINDING_VIOLATION", 409, "MCP Server is referenced by a Published App Version");
		await this.repos.mcpSecrets.delete({ tenantId: input.tenantId }, input.mcpServerId);
		await this.writeAudit({
			tenantId: input.tenantId,
			action: "mcp-server.deleted",
			resourceType: "mcp_server",
			resourceId: input.mcpServerId,
			metadata: {},
		});
		return { ok: true, data: { deleted: true } };
	}

	private validateMcpConfig(config: McpStreamableHttpConfig): ControlResult<McpStreamableHttpConfig> {
		if (config.transport !== "streamable_http")
			return fail("MCP_CONFIG_NOT_APPROVED", 422, "MVP supports streamable_http transport only");
		if (config.authentication !== "none" && config.authentication !== "bearer")
			return fail("MCP_CONFIG_NOT_APPROVED", 422, "MCP authentication must be none or bearer");
		try {
			const endpoint = validateMcpEndpoint(config.endpoint, this.mcpNetworkPolicy).toString();
			return { ok: true, data: { ...config, endpoint } };
		} catch (error) {
			if (error instanceof McpNetworkPolicyError) return fail("MCP_CONFIG_NOT_APPROVED", 422, error.message);
			throw error;
		}
	}

	private async openMcpServer(input: {
		readonly tenantId: TenantId;
		readonly mcpServerId: McpServerId;
		readonly signal?: AbortSignal;
	}): Promise<
		ControlResult<{ readonly session: SecureMcpClientSession; readonly revision: McpServerRevisionRecord }>
	> {
		const scope = { tenantId: input.tenantId };
		const server = await this.repos.mcpServers.get(scope, input.mcpServerId);
		if (server === undefined) return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server not found in tenant scope");
		if (server.status !== "enabled") return fail("MCP_BINDING_VIOLATION", 409, "MCP Server is disabled");
		const revision = await this.repos.mcpServers.getRevision(scope, input.mcpServerId, server.currentRevision);
		if (revision === undefined)
			return fail("MCP_SERVER_NOT_FOUND", 404, "MCP Server revision not found in tenant scope");
		let bearerToken: string | undefined;
		if (revision.authentication === "bearer") {
			if (this.mcpSecretBox === undefined)
				return fail("MCP_SECRET_NOT_CONFIGURED", 409, "MCP bearer credential is not configured");
			const secret = await this.repos.mcpSecrets.get(scope, input.mcpServerId);
			if (secret === undefined)
				return fail("MCP_SECRET_NOT_CONFIGURED", 409, "MCP bearer credential is not configured");
			try {
				bearerToken = this.mcpSecretBox.open(input.tenantId, input.mcpServerId, secret);
			} catch {
				return fail("MCP_SECRET_NOT_CONFIGURED", 409, "MCP bearer credential cannot be opened");
			}
		}
		try {
			const session = await connectSecureMcpClient({
				endpoint: revision.endpoint,
				bearerToken,
				networkPolicy: this.mcpNetworkPolicy,
				signal: input.signal,
			});
			return { ok: true, data: { session, revision } };
		} catch {
			return fail("MCP_TEST_FAILED", 422, "MCP connection failed");
		}
	}

	private discoveredMcpTools(
		tenantId: TenantId,
		mcpServerId: McpServerId,
		mcpRevision: number,
		tools: readonly McpSdkTool[],
	): readonly McpToolRecord[] {
		if (tools.length > 128) throw new Error("MCP Server exposes too many Tools");
		const names = new Set<string>();
		return tools.map((tool) => {
			if (tool.name.length < 1 || tool.name.length > 128 || names.has(tool.name))
				throw new Error("MCP Tool names are invalid or duplicated");
			names.add(tool.name);
			const inputSchema = tool.inputSchema as Readonly<Record<string, unknown>>;
			const canonicalSchema = canonicalJson(inputSchema);
			if (Buffer.byteLength(canonicalSchema, "utf8") > 256 * 1024) throw new Error("MCP Tool schema is too large");
			return {
				mcpToolId: newMcpToolId(),
				tenantId,
				mcpServerId,
				mcpRevision,
				name: tool.name,
				description: tool.description ?? null,
				inputSchema,
				inputSchemaHash: sha256Hex(canonicalSchema),
				createdAt: new Date(),
			};
		});
	}

	private mcpToolView(tool: McpToolRecord): McpToolRef {
		return {
			id: toPublicId("McpToolId", tool.mcpToolId),
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			inputSchemaHash: tool.inputSchemaHash,
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
		skills: readonly { readonly skillId: SkillId; readonly skillRevision: number }[],
		mcpServers: readonly {
			readonly mcpServerId: McpServerId;
			readonly mcpRevision: number;
			readonly toolAllowlist: readonly string[];
		}[],
	): AgentDefinitionDetail {
		const snapshot = this.draftToSnapshot(record.draftConfig);
		const draft = (record.draftConfig ?? {}) as Partial<AgentDraftConfig>;
		return {
			id: toPublicId("AgentDefinitionId", record.agentDefinitionId) as AgentDefinitionDetail["id"],
			name: record.name,
			description: typeof draft.description === "string" ? draft.description : null,
			currentRevision: record.revision,
			modelId: snapshot.modelId,
			systemPrompt: snapshot.systemPrompt,
			parameters: snapshot.parameters,
			toolIds: snapshot.toolIds,
			knowledgeBaseIds: snapshot.knowledgeBaseIds,
			capabilities: snapshot.capabilities,
			skills: skills.map((binding) => ({
				skillId: toPublicId("SkillId", binding.skillId),
				revision: binding.skillRevision,
			})),
			mcpServers: mcpServers.map((binding) => ({
				mcpServerId: toPublicId("McpServerId", binding.mcpServerId),
				revision: binding.mcpRevision,
				toolNames: binding.toolAllowlist,
			})),
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
		skills?: readonly { readonly skillId: SkillId; readonly skillRevision: number }[],
		mcpServers?: readonly {
			readonly mcpServerId: McpServerId;
			readonly mcpRevision: number;
			readonly toolAllowlist: readonly string[];
		}[],
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
			...(skills === undefined
				? {}
				: {
						skills: skills.map((binding) => ({
							skillId: toPublicId("SkillId", binding.skillId),
							revision: binding.skillRevision,
						})),
					}),
			...(mcpServers === undefined
				? {}
				: {
						mcpServers: mcpServers.map((binding) => ({
							mcpServerId: toPublicId("McpServerId", binding.mcpServerId),
							revision: binding.mcpRevision,
							toolNames: binding.toolAllowlist,
						})),
					}),
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
			newConversations: d.conversations?.allowNew !== false,
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
		const matchingModels = this.catalog.models.filter((model) => model.modelId === (request.modelId ?? ""));
		// The current editor request carries a model id, not a provider id. Preserve
		// the catalog provider when that id is unambiguous; otherwise retain the
		// sentinel so publishing rejects an ambiguous or unknown model instead of
		// silently selecting one.
		const provider = matchingModels.length === 1 ? matchingModels[0]!.provider : "platform";
		return {
			description: request.description ?? "",
			prompt: request.systemPrompt,
			model: {
				provider,
				modelId: request.modelId ?? "",
				params: request.parameters as unknown as Readonly<Record<string, unknown>>,
			},
			tools: request.toolIds.map((id) => ({ id })),
			knowledgeBases: request.knowledgeBaseIds.map((id) => ({ id })),
			uploads: { enabled: request.capabilities.attachments },
			speech: { enabled: request.capabilities.liveSpeech },
			avatar: { enabled: request.capabilities.avatar },
			conversations: { allowNew: request.capabilities.newConversations !== false },
		};
	}

	/** Shared validation for Agent creation and immutable revision saves. */
	private async validateAgentDraftRequest(request: SaveAgentRevisionRequest): Promise<ControlResult<undefined>> {
		const name = request.name?.trim() ?? "";
		if (name.length === 0 || name.length > 100) {
			return fail("INVALID_AGENT_NAME", 400, "name must contain 1 to 100 characters");
		}
		if ((request.description?.length ?? 0) > 300) {
			return fail("INVALID_AGENT_DESCRIPTION", 400, "description must contain at most 300 characters");
		}
		if (request.systemPrompt.length > PLATFORM_LIMITS.maxSystemPromptChars) {
			return fail(
				"INVALID_SYSTEM_PROMPT",
				400,
				`systemPrompt must contain at most ${PLATFORM_LIMITS.maxSystemPromptChars} characters`,
			);
		}
		const availableModels = this.llm === undefined ? [] : await this.llm.listAvailableModels();
		const selectedModel = availableModels.find((model) => model.id === request.modelId);
		const parameterCapabilities =
			selectedModel?.parameterCapabilities ??
			modelParameterCapabilities({
				id: request.modelId ?? "",
				api: "openai-completions",
				reasoning: /qwen[\s._-]*3[\s._-]*8/i.test(request.modelId ?? ""),
			});
		const parameterErrors = validateModelParameters(request.parameters, parameterCapabilities);
		if (parameterErrors.length > 0) {
			return fail("INVALID_MODEL_PARAMETERS", 400, parameterErrors.join("; "));
		}
		return { ok: true, data: undefined };
	}

	private skillBindingsFromRequest(
		refs: readonly { readonly skillId: string; readonly revision: number }[],
	): ControlResult<readonly { readonly skillId: SkillId; readonly skillRevision: number }[]> {
		const seen = new Set<string>();
		const bindings: { skillId: SkillId; skillRevision: number }[] = [];
		for (const ref of refs) {
			const skillId = fromPublicId("SkillId", ref.skillId);
			if (skillId === null || !Number.isInteger(ref.revision) || ref.revision < 1 || seen.has(ref.skillId)) {
				return fail("SKILL_INVALID", 422, "Skill bindings require unique skill_<uuid> ids and positive revisions");
			}
			seen.add(ref.skillId);
			bindings.push({ skillId, skillRevision: ref.revision });
		}
		return { ok: true, data: bindings };
	}

	private mcpBindingsFromRequest(
		refs: readonly {
			readonly mcpServerId: string;
			readonly revision: number;
			readonly toolNames: readonly string[];
		}[],
	): ControlResult<
		readonly {
			readonly mcpServerId: McpServerId;
			readonly mcpRevision: number;
			readonly toolAllowlist: readonly string[];
		}[]
	> {
		const seenServers = new Set<string>();
		const bindings: { mcpServerId: McpServerId; mcpRevision: number; toolAllowlist: readonly string[] }[] = [];
		for (const ref of refs) {
			const mcpServerId = fromPublicId("McpServerId", ref.mcpServerId);
			const uniqueTools = new Set(ref.toolNames);
			if (
				mcpServerId === null ||
				!Number.isInteger(ref.revision) ||
				ref.revision < 1 ||
				seenServers.has(ref.mcpServerId) ||
				ref.toolNames.length === 0 ||
				uniqueTools.size !== ref.toolNames.length ||
				ref.toolNames.some((name) => name.length < 1 || name.length > 128)
			) {
				return fail(
					"MCP_BINDING_VIOLATION",
					409,
					"MCP bindings require a unique Server, positive revision, and unique Tool names",
				);
			}
			seenServers.add(ref.mcpServerId);
			bindings.push({ mcpServerId, mcpRevision: ref.revision, toolAllowlist: [...uniqueTools].sort() });
		}
		return { ok: true, data: bindings };
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
			canonicalJson(p.model?.params ?? {}) !== canonicalJson(c.model?.params ?? {}) ||
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

	async updateConversationAdminStatus(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly status: "archived" | "deleted";
		readonly requestId?: string;
	}): Promise<ControlResult<{ readonly id: string; readonly status: "archived" | "deleted" }>> {
		const scope = { tenantId: input.tenantId };
		const conversation = await this.repos.conversations.getByTenant(scope, input.conversationId);
		if (conversation === undefined)
			return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		if (conversation.status === input.status) {
			return { ok: true, data: { id: toPublicId("ConversationId", input.conversationId), status: input.status } };
		}
		const allowedFrom: readonly ("active" | "archived" | "deleted")[] =
			input.status === "archived" ? ["active"] : ["active", "archived"];
		if (!allowedFrom.includes(conversation.status)) {
			return fail(
				"CONVERSATION_STATE_CONFLICT",
				409,
				`conversation cannot transition from ${conversation.status} to ${input.status}`,
			);
		}
		const update = this.repos.conversations.updateStatusByTenant;
		if (update === undefined)
			return fail("CONVERSATION_LIFECYCLE_UNAVAILABLE", 503, "conversation lifecycle storage is unavailable");
		const changed = await update(scope, input.conversationId, allowedFrom, input.status);
		if (!changed) return fail("CONVERSATION_STATE_CONFLICT", 409, "conversation state changed concurrently");
		await this.writeAudit({
			tenantId: input.tenantId,
			action: input.status === "archived" ? "conversation.archived" : "conversation.deleted",
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId: input.requestId === undefined ? undefined : (input.requestId as RequestId),
			metadata: { previousStatus: conversation.status, status: input.status },
		});
		return { ok: true, data: { id: toPublicId("ConversationId", input.conversationId), status: input.status } };
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
	 * Partial-update an existing PublishedApp — currently only `name` and
	 * `allowedOrigins`. Reuses `updateMutable` (coalesce semantics), so
	 * unprovided fields are preserved. An empty patch (both fields
	 * undefined) is a no-op: no DB write, no audit row.
	 *
	 * Origin list goes through the same `validateOriginList` policy as the
	 * create path (spec 27.4). The `name` length range matches the SQL
	 * CHECK constraint (1-200 chars after trimming).
	 */
	async updatePublishedApp(
		input: UpdatePublishedAppInput,
	): Promise<ControlResult<UpdatePublishedAppResult>> {
		const appScope = { tenantId: input.tenantId, publishedAppId: input.publishedAppId };
		const app = await this.repos.publishedApps.get(appScope, input.publishedAppId);
		if (app === undefined) return fail("APP_NOT_FOUND", 404, "published app not found in tenant scope");

		const patch: { name?: string; allowedOrigins?: readonly string[] } = {};

		if (input.name !== undefined) {
			const trimmed = input.name.trim();
			// Length range matches the SQL CHECK constraint on
			// `published_apps.name` (1-200 chars). HTTP layer also rejects
			// blanks up front; this is a defence-in-depth check.
			if (trimmed.length < 1 || trimmed.length > 200) {
				return fail("INVALID_AGENT_NAME", 400, "name must be 1-200 characters after trimming");
			}
			patch.name = trimmed;
		}

		if (input.allowedOrigins !== undefined) {
			const validation = validateOriginList(input.allowedOrigins);
			if (!validation.ok) {
				return fail("INVALID_ORIGINS", 400, `invalid allowedOrigins: ${validation.errors.join("; ")}`);
			}
			patch.allowedOrigins = input.allowedOrigins;
		}

		// No-op: empty patch keeps both DB row and audit log clean.
		if (patch.name === undefined && patch.allowedOrigins === undefined) {
			return { ok: true, data: { app, auditEventId: "" as AuditEventId } };
		}

		await this.repos.publishedApps.updateMutable(appScope, input.publishedAppId, patch);

		const auditEventId = await this.writeAudit({
			tenantId: input.tenantId,
			action: "published-app.updated",
			resourceType: "published_app",
			resourceId: input.publishedAppId,
			requestId: input.requestId,
			metadata: {
				fields: {
					name: input.name !== undefined,
					allowedOrigins: input.allowedOrigins !== undefined,
				},
			},
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

	/**
	 * GET conversation reasoning effort (Agent V2 §4.3). Reads the dedicated
	 * fact source `conversation_reasoning_state`; never the event journal, and
	 * it does not advance the conversation event sequence.
	 */
	async getConversationReasoning(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
	}): Promise<ControlResult<ConversationReasoningState>> {
		const conversation = await this.repos.conversations.getByTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		if (conversation === undefined)
			return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const state = await this.repos.conversationReasoning.get(
			{
				tenantId: conversation.tenantId,
				publishedAppId: conversation.publishedAppId,
				principalId: conversation.ownerPrincipalId,
			},
			input.conversationId,
		);
		const pinnedCapability = await reasoningCapabilitiesForVersion(
			this.repos,
			{ tenantId: conversation.tenantId, publishedAppId: conversation.publishedAppId },
			conversation.publishedAppVersionId,
		);
		return {
			ok: true,
			data: {
				conversationId: toPublicId("ConversationId", input.conversationId) as ConversationPublicId,
				effort: state?.effort ?? null,
				updatedAt: (state?.updatedAt ?? conversation.lastActiveAt).toISOString(),
				configurable: pinnedCapability !== null,
				pinnedCapability,
			},
		};
	}

	/**
	 * PUT conversation reasoning effort (Agent V2 §4.3; shared by control admin
	 * and embed owner, differing only in the authorization gate). Writes the
	 * fact source and appends the `conversation.reasoning-updated` audit entry.
	 *
	 * - cross-tenant / cross-owner → `CONVERSATION_NOT_FOUND` (404);
	 * - legal owner but policy forbids adjusting → `REASONING_NOT_CONFIGURABLE` (403);
	 * - effort not in the pinned model's declared tiers → `REASONING_INVALID_EFFORT` (422);
	 * - `effort: null` clears the override (falls back to the Agent Revision default).
	 */
	async setConversationSessionEffort(input: {
		readonly tenantId: TenantId;
		readonly conversationId: ConversationId;
		readonly request: ReasoningUpdateRequest;
		readonly principal: ReasoningPrincipal;
		readonly configurable?: boolean;
		readonly requestId?: RequestId;
	}): Promise<ControlResult<ConversationReasoningState>> {
		const conversation = await this.repos.conversations.getByTenant(
			{ tenantId: input.tenantId },
			input.conversationId,
		);
		if (conversation === undefined)
			return fail("CONVERSATION_NOT_FOUND", 404, "conversation not found in tenant scope");
		const result = await applyConversationReasoning({
			repos: this.repos,
			tenantId: conversation.tenantId,
			publishedAppId: conversation.publishedAppId,
			publishedAppVersionId: conversation.publishedAppVersionId,
			ownerPrincipalId: conversation.ownerPrincipalId,
			conversationId: input.conversationId,
			request: input.request,
			principal: input.principal,
			configurable: input.configurable !== false,
			requestId: input.requestId,
		});
		if (!result.ok) return fail(result.code as never, result.status, result.message);
		return { ok: true, data: result.data };
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

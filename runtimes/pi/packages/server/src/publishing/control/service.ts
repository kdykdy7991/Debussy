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

import { validateOriginList } from "../../embed/auth/origin.ts";
import type {
	AgentDefinitionId,
	AuditEventId,
	PublishedAppId,
	PublishedAppVersionId,
	RequestId,
	TenantId,
} from "../domain/ids.ts";
import {
	newAgentDefinitionId,
	newAuditEventId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newRequestId,
	newTenantId,
} from "../domain/ids.ts";
import type { AccessMode } from "../domain/states.ts";
import type {
	AgentDefinitionRecord,
	PublishedAppRecord,
	PublishedAppVersionRecord,
	PublishingRepositories,
	TenantRecord,
} from "../repositories.ts";
import { type AgentDraftConfig, type CapabilityCatalog, compileRuntimeSpec } from "../runtime-spec/compiler.ts";
import { canonicalJson, sha256Hex } from "../runtime-spec/hash.ts";

export interface ControlServiceOptions {
	readonly repositories: PublishingRepositories;
	readonly catalog: CapabilityCatalog;
	/** Base URL used to build the embedUrl returned on app creation. */
	readonly embedBaseUrl: string;
}

export type ControlErrorCode =
	| "BOOTSTRAP_MISMATCH" // tenant exists with different name/status (409)
	| "AGENT_NOT_FOUND" // agent/revision not visible in the tenant scope (404)
	| "SOURCE_HASH_MISMATCH" // expectedSourceHash differs from current (409)
	| "APP_NOT_FOUND" // app not visible in the tenant scope (404)
	| "VERSION_NOT_FOUND" // source agent revision not found (404)
	| "VERSION_UNAVAILABLE" // activate/rollback target not ready or not this app's (409)
	| "INVALID_ORIGINS" // allowedOrigins fails strict origin policy (400)
	| "CONFLICT"; // unexpected concurrent conflict (409)

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

	constructor(options: ControlServiceOptions) {
		this.repos = options.repositories;
		this.catalog = options.catalog;
		this.embedBaseUrl = options.embedBaseUrl.replace(/\/+$/, "");
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

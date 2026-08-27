/**
 * Publishing 管理控制台 HTTP 契约（PUBLISHING-ADMIN-CONSOLE §4）。
 *
 * 由协议包统一持有，Web 与 Server 共享。Server 端的 control/http.ts 当前
 * 仍使用自身 inline DTO，本模块为其补一份外部参考契约，便于 Web 端不再
 * 使用 `JSON.parse(...) as BusinessType`（ADMIN-000 完成条件）。
 *
 * 仅描述"形状"——鉴权、Idempotency-Key、错误信封、cursor 解析等运行时行为
 * 由调用方各自实现，避免在本模块引入运行时依赖。
 */

/** Cursor-paginated query response shared by every console list endpoint. */
export interface CursorPage<T> {
	readonly items: readonly T[];
	readonly nextCursor: string | null;
}

/** `GET /api/control/v1/agent-definitions` (§4.1). */
export interface AgentDefinitionSummary {
	/** `agent_<uuid>` — never a bare UUID in the wire format. */
	readonly id: string;
	readonly name: string;
	readonly revision: number;
	readonly sourceHash: string;
	readonly createdAt: string;
}

export type AgentDefinitionListResponse = CursorPage<AgentDefinitionSummary>;

/** `GET /api/control/v1/published-apps` (§4.2). */
export interface PublishedAppSummary {
	readonly id: string;
	readonly publicAppId: string;
	readonly name: string;
	readonly status: "draft" | "active" | "suspended" | "archived";
	readonly accessMode: "anonymous" | "signed_user" | "mixed";
	readonly allowedOrigins: readonly string[];
	readonly currentVersionId: string | null;
	readonly embedUrl: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export type PublishedAppListResponse = CursorPage<PublishedAppSummary>;

/** Allowlisted capabilities summary — never the full RuntimeSpec (§4.3). */
export interface VersionCapabilitiesSummary {
	readonly tools: readonly string[];
	readonly knowledgeBases: readonly string[];
	readonly uploads: { readonly enabled: boolean; readonly maxFiles: number; readonly maxFileBytes: number };
	readonly speech: { readonly enabled: boolean };
	readonly avatar: { readonly enabled: boolean };
}

export interface PublishedAppDetail {
	readonly id: string;
	readonly publicAppId: string;
	readonly name: string;
	readonly status: "draft" | "active" | "suspended" | "archived";
	readonly accessMode: "anonymous" | "signed_user" | "mixed";
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
		readonly status: "validating" | "ready" | "rejected" | "retired";
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

/** `GET /api/control/v1/published-apps/:appId/versions` (§4.4). */
export interface PublishedAppVersionSummary {
	readonly id: string;
	readonly versionNumber: number;
	readonly status: "validating" | "ready" | "rejected" | "retired";
	readonly sourceAgentRevision: number;
	readonly runtimeSpecHash: string | null;
	readonly validationErrors: readonly unknown[];
	readonly createdAt: string;
	readonly isCurrent: boolean;
}

export type PublishedAppVersionListResponse = CursorPage<PublishedAppVersionSummary>;

/** `GET /api/control/v1/published-apps/:appId/launch-keys` (§4.5). */
export interface LaunchKeySummary {
	readonly id: string;
	readonly keyId: string;
	readonly algorithm: string;
	readonly status: "active" | "retiring" | "revoked";
	readonly notBefore: string;
	readonly expiresAt: string | null;
	readonly createdAt: string;
}

export interface LaunchKeyListResponse {
	readonly items: readonly LaunchKeySummary[];
}

/** `GET /api/control/v1/audit-events` (§4.6). */
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

export type AuditEventListResponse = CursorPage<AuditEventSummary>;

/** Bootstrap tenant info (returned by `GET .../audit-events` and other reads via `X-Tenant-Name`). */
export interface TenantInfo {
	readonly id: string;
	readonly name: string;
}

/** Uniform error envelope shared by every control response (spec §3 / 33.2). */
export interface ControlError {
	readonly code: string;
	readonly message: string;
	readonly requestId: string;
	readonly retryable: boolean;
}

export interface ControlErrorEnvelope {
	readonly error: ControlError;
}

/** Wire DTO of the `POST .../agent-definitions/import-current` write response. */
export interface ImportAgentResponse {
	readonly agentDefinitionId: string;
	readonly revision: number;
	readonly sourceHash: string;
	readonly warnings: readonly { readonly code: string; readonly path: string; readonly message: string }[];
}

/** Wire DTO of the `POST .../published-apps` write response. */
export interface CreatePublishedAppResponse {
	readonly id: string;
	readonly publicAppId: string;
	readonly status: string;
	readonly currentVersionId: string | null;
	readonly embedUrl: string;
}

/** Wire DTO of the `POST .../versions` response — ready -> 201, rejected -> 422. */
export interface CreatePublishedAppVersionResponse {
	readonly version: {
		readonly id: string;
		readonly versionNumber: number;
		readonly status: "validating" | "ready" | "rejected" | "retired";
		readonly sourceAgentRevision: number;
		readonly validationErrors: readonly unknown[];
	};
}

/** Generic response of activate/rollback/suspend/launch-key mutations. */
export interface VersionTransitionResponse {
	readonly app: {
		readonly id: string;
		readonly publicAppId: string;
		readonly status: string;
		readonly currentVersionId: string | null;
	};
	readonly previousVersionId: string | null;
	readonly auditEventId: string;
}

export interface SuspendAppResponse {
	readonly app: {
		readonly id: string;
		readonly publicAppId: string;
		readonly status: string;
		readonly currentVersionId: string | null;
	};
	readonly auditEventId: string;
}

/**
 * Response of `PATCH /api/control/v1/published-apps/:appId`.
 *
 * Mirrors `SuspendAppResponse`: returns the slim `appView()` shape so the
 * client must re-fetch `PublishedAppDetail` to pick up the new `name` /
 * `allowedOrigins` for re-rendering. `auditEventId` is `null` for the
 * empty-body no-op case.
 */
export interface UpdatePublishedAppResponse {
	readonly app: {
		readonly id: string;
		readonly publicAppId: string;
		readonly status: string;
		readonly currentVersionId: string | null;
	};
	readonly auditEventId: string | null;
}

export interface CreateLaunchKeyResponse {
	readonly id: string;
	readonly keyId: string;
	readonly algorithm: string;
	readonly status: "active" | "retiring" | "revoked";
	readonly notBefore: string;
	readonly expiresAt: string | null;
	readonly retiredKeyIds: readonly string[];
	readonly auditEventId: string;
}

export interface RevokeLaunchKeyResponse {
	readonly id: string;
	readonly keyId: string;
	readonly status: "active" | "retiring" | "revoked";
	readonly auditEventId: string;
}

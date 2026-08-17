/**
 * Publishing 管理控制台前端类型（PUBLISHING-ADMIN-CONSOLE §3/4）。
 *
 * 单一来源：`@earendil-works/pi-protocol` 的 `publishing/control-http`。前端
 * 不得自己 `JSON.parse(...) as BusinessType`（ADMIN-000 完成条件）；只允许
 * 从这里或协议包 re-export。本文件只放视图模型、UI 相关的扩展与守卫函数。
 */
import type {
	AuditEventSummary,
	ControlError,
	LaunchKeySummary,
	PublishedAppDetail,
	PublishedAppVersionSummary,
} from "@earendil-works/pi-protocol";

export type {
	AgentDefinitionListResponse,
	AgentDefinitionSummary,
	AuditEventListResponse,
	AuditEventSummary,
	ControlError,
	ControlErrorEnvelope,
	CreateLaunchKeyResponse,
	CreatePublishedAppResponse,
	CreatePublishedAppVersionResponse,
	CursorPage,
	ImportAgentResponse,
	LaunchKeyListResponse,
	LaunchKeySummary,
	PublishedAppDetail,
	PublishedAppListResponse,
	PublishedAppSummary,
	PublishedAppVersionListResponse,
	PublishedAppVersionSummary,
	RevokeLaunchKeyResponse,
	SuspendAppResponse,
	TenantInfo,
	VersionCapabilitiesSummary,
	VersionTransitionResponse,
} from "@earendil-works/pi-protocol";

/** Aggregate view-model for the App detail page. */
export interface AppDetailSnapshot {
	readonly app: PublishedAppDetail;
	readonly versions: readonly PublishedAppVersionSummary[];
	readonly launchKeys: readonly LaunchKeySummary[];
	readonly audits: readonly AuditEventSummary[];
}

/** Allowed status filters on the published-app list endpoint. */
export type PublishedAppStatusFilter = "" | "draft" | "active" | "suspended" | "archived";

/** Allowed access mode values for create-app form (mirrors server union). */
export type AccessModeValue = "anonymous" | "signed_user" | "mixed";

export const PUBLISHED_APP_STATUSES = ["draft", "active", "suspended", "archived"] as const;
export const ACCESS_MODES = ["anonymous", "signed_user", "mixed"] as const;
export const LAUNCH_KEY_STATUSES = ["active", "retiring", "revoked"] as const;

/** A typed error returned from every Publishing API call. */
export class PublishingApiError extends Error {
	readonly code: string;
	readonly requestId: string;
	readonly retryable: boolean;
	readonly httpStatus: number;
	constructor(error: ControlError, httpStatus: number) {
		super(error.message);
		this.name = "PublishingApiError";
		this.code = error.code;
		this.requestId = error.requestId;
		this.retryable = error.retryable;
		this.httpStatus = httpStatus;
	}
}

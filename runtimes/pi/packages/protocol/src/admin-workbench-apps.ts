/**
 * Admin Workbench — Apps & Publishing workspace DTOs (WB-004).
 *
 * Adds workbench-flat admin views that extend the existing publishing control
 * DTOs (`publishing/control-http.ts`) without duplicating them.  The existing
 * `PublishedAppSummary`, `PublishedAppDetail`, `PublishedAppVersionSummary`,
 * `LaunchKeySummary`, `AuditEventSummary`, and `CursorPage<T>` wire types are
 * the single source of truth for the wire; this module only adds shapes that
 * the admin workbench needs beyond the raw wire responses.
 */

import type { KnownPublishedAppStatus, KnownPublishedAppVersionStatus } from "./admin-workbench.ts";

/** Dashboard summary returned by `GET /api/control/v1/dashboard/summary`. */
export interface DashboardSummary {
	readonly appCount: number;
	/** Number of distinct principals with `status = 'active'` in the tenant. */
	readonly activeUserCount: number;
	/** Number of active conversations in the tenant. */
	readonly activeSessionCount: number;
	/** Count of error-type events (`turn.failed`, `tool.error`) in the tenant. */
	readonly errorEventCount: number;
	/** Apps that have a ready, non-current version (newest one per app). */
	readonly pendingApps: readonly PendingVersionApp[];
}

/** One app + its newest ready, non-current version. */
export interface PendingVersionApp {
	readonly appId: string;
	readonly publicAppId: string;
	readonly name: string;
	readonly status: KnownPublishedAppStatus;
	readonly pendingVersionNumber: number;
	readonly pendingVersionStatus: KnownPublishedAppVersionStatus;
}

/** `POST /api/control/v1/published-apps/:appId/preview-ticket` body (WB-005). */
export interface CreatePreviewTicketRequest {
	readonly versionId: string;
	/** Optional TTL in seconds; default 300 (5 min), clamped to 60..3600. */
	readonly ttlSeconds?: number;
}

/** `POST /api/control/v1/published-apps/:appId/preview-ticket` response (WB-005). */
export interface PreviewTicket {
	/** Opaque, single-use JWT. Never logged or written to URL/storage. */
	readonly ticket: string;
	/** Absolute expiry (ISO-8601). */
	readonly expiresAt: string;
	/** Ticket-free preview page. The admin window passes `ticket` in memory by postMessage. */
	readonly previewUrl: string;
}

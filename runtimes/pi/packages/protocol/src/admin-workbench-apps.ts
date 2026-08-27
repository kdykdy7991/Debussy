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

/**
 * `POST /api/control/v1/published-apps` request body (MVP-03). The server
 * rejects unknown access modes (400 INVALID_REQUEST) and per-origin policy
 * violations (400 INVALID_ORIGINS). Private launch key material is
 * intentionally NOT part of this DTO — the browser must never see the
 * server-side PEM.
 *
 * The response shape lives in `publishing/control-http.ts` as
 * `CreatePublishedAppResponse` (re-exported from the protocol root) — we
 * intentionally do not duplicate it here.
 */
export interface CreatePublishedAppRequest {
	readonly agentDefinitionId: string;
	readonly name: string;
	readonly accessMode: "anonymous" | "signed_user" | "mixed";
	readonly allowedOrigins?: readonly string[];
	readonly theme?: { readonly primaryColor?: string; readonly welcomeMessage?: string };
}

/**
 * Partial-update request for `PATCH /api/control/v1/published-apps/:appId`.
 * All fields optional — undefined keys leave the existing column value intact
 * (coalesce semantics at the repository layer). Currently limited to `name`
 * and `allowedOrigins`; `accessMode`, `theme`, and `status` are deliberately
 * excluded — status changes go through dedicated `/suspend` etc. routes, and
 * the others are not yet wired through the UI.
 */
export interface UpdatePublishedAppRequest {
	readonly name?: string;
	readonly allowedOrigins?: readonly string[];
}

/**
 * Admin Apps HTTP client (WB-004).
 *
 * Mirrors `agent-api.ts` pattern: reads token from AdminAuthController,
 * sets Authorization header, propagates 401 to lock state.
 *
 * Protocol DTOs from `@earendil-works/pi-protocol` root; this file only does
 * fetch + JSON serialization, no shape inference.
 */
import type {
	AuditEventListResponse,
	CreatePreviewTicketRequest,
	CreatePublishedAppVersionResponse,
	CursorPage,
	DashboardSummary,
	LaunchKeyListResponse,
	PreviewTicket,
	PublishedAppDetail,
	PublishedAppSummary,
	PublishedAppVersionSummary,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";

export class AppApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;
	constructor(message: string, httpStatus: number, requestId: string | null, code: string | null) {
		super(message);
		this.name = "AppApiError";
		this.httpStatus = httpStatus;
		this.requestId = requestId;
		this.code = code;
	}
}

export interface AppApiOptions {
	readonly auth: AdminAuthController;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}

interface RequestOptions {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

interface Envelope<T> {
	readonly data: T;
	readonly requestId: string;
}
interface ErrorEnvelope {
	readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

export class AppApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: AppApiOptions) {
		this.auth = options.auth;
		this.baseUrl = (options.baseUrl ?? options.auth.getSnapshot().baseUrl).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
	}

	private async request<T>(opts: RequestOptions): Promise<T> {
		const token = this.auth.getToken();
		if (token === null || token === "") {
			throw new AppApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
		const url = `${this.baseUrl}${opts.path}`;
		const response = await this.fetchImpl(url, {
			method: opts.method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		});
		if (response.status === 401) {
			this.auth.failConnection("Admin token rejected by server");
			throw new AppApiError("Admin token rejected", 401, null, "UNAUTHORIZED");
		}
		const text = await response.text();
		const parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
		if (!response.ok) {
			const env = parsed as ErrorEnvelope | null;
			const errInfo = env?.error;
			const message = errInfo?.message ?? `HTTP ${response.status}`;
			this.auth.handleApiError({
				name: "AppApiError",
				code: errInfo?.code ?? "HTTP_ERROR",
				message,
				requestId: errInfo?.requestId ?? "",
				retryable: false,
				httpStatus: response.status,
			});
			throw new AppApiError(message, response.status, errInfo?.requestId ?? null, errInfo?.code ?? null);
		}
		if (parsed === null) {
			throw new AppApiError("Empty response", response.status, null, "EMPTY_RESPONSE");
		}
		const envelope = parsed as Envelope<T>;
		return envelope.data;
	}

	private randomKey(): string {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
		return `ik_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
	}

	getDashboardSummary(): Promise<DashboardSummary> {
		return this.request({ method: "GET", path: "/api/control/v1/dashboard/summary" });
	}

	listPublishedApps(input: {
		limit: number;
		cursor?: string;
		status?: string;
	}): Promise<CursorPage<PublishedAppSummary>> {
		const params = new URLSearchParams({ limit: String(input.limit) });
		if (input.cursor !== undefined) params.set("cursor", input.cursor);
		if (input.status !== undefined && input.status !== "") params.set("status", input.status);
		return this.request({
			method: "GET",
			path: `/api/control/v1/published-apps?${params.toString()}`,
		});
	}

	getPublishedApp(appId: string): Promise<PublishedAppDetail> {
		return this.request({
			method: "GET",
			path: `/api/control/v1/published-apps/${encodeURIComponent(appId)}`,
		});
	}

	listVersions(
		appId: string,
		input: { limit: number; cursor?: string },
	): Promise<CursorPage<PublishedAppVersionSummary>> {
		const params = new URLSearchParams({ limit: String(input.limit) });
		if (input.cursor !== undefined) params.set("cursor", input.cursor);
		return this.request({
			method: "GET",
			path: `/api/control/v1/published-apps/${encodeURIComponent(appId)}/versions?${params.toString()}`,
		});
	}

	createVersion(input: { appId: string; sourceAgentRevision: number }): Promise<CreatePublishedAppVersionResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/versions`,
			body: { sourceAgentRevision: input.sourceAgentRevision },
			idempotencyKey: this.randomKey(),
		});
	}

	activateVersion(input: { appId: string; versionId: string }): Promise<unknown> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/activate`,
			body: { versionId: input.versionId },
			idempotencyKey: this.randomKey(),
		});
	}

	rollbackVersion(input: { appId: string; versionId: string }): Promise<unknown> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/rollback`,
			body: { versionId: input.versionId },
			idempotencyKey: this.randomKey(),
		});
	}

	suspendApp(input: { appId: string; reason?: string }): Promise<unknown> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/suspend`,
			body: input.reason === undefined ? {} : { reason: input.reason },
			idempotencyKey: this.randomKey(),
		});
	}

	listLaunchKeys(appId: string): Promise<LaunchKeyListResponse> {
		return this.request({
			method: "GET",
			path: `/api/control/v1/published-apps/${encodeURIComponent(appId)}/launch-keys`,
		});
	}

	createLaunchKey(input: {
		appId: string;
		keyId: string;
		publicKeyPem: string;
		expiresAt?: string | null;
	}): Promise<unknown> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/launch-keys`,
			body: { keyId: input.keyId, publicKeyPem: input.publicKeyPem, expiresAt: input.expiresAt ?? null },
			idempotencyKey: this.randomKey(),
		});
	}

	revokeLaunchKey(input: { appId: string; keyId: string }): Promise<unknown> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/launch-keys/${encodeURIComponent(input.keyId)}/revoke`,
			body: {},
			idempotencyKey: this.randomKey(),
		});
	}

	createPreviewTicket(input: { appId: string; versionId: string; ttlSeconds?: number }): Promise<PreviewTicket> {
		return this.request<PreviewTicket>({
			method: "POST",
			path: `/api/control/v1/published-apps/${encodeURIComponent(input.appId)}/preview-ticket`,
			body: {
				versionId: input.versionId,
				...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
			} satisfies CreatePreviewTicketRequest,
			idempotencyKey: this.randomKey(),
		});
	}

	listAuditEvents(input: { appId?: string; limit: number; cursor?: string }): Promise<AuditEventListResponse> {
		const params = new URLSearchParams({ limit: String(input.limit) });
		if (input.appId !== undefined) params.set("appId", input.appId);
		if (input.cursor !== undefined) params.set("cursor", input.cursor);
		return this.request({
			method: "GET",
			path: `/api/control/v1/audit-events?${params.toString()}`,
		});
	}
}

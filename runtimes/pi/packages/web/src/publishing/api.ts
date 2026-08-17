/**
 * Publishing 控制台 HTTP API 客户端（ADMIN-003）。
 *
 * 同源 `/api/control/v1/*`；统一解析错误信封（spec §3）；每个 mutation 都
 * 自动生成 `Idempotency-Key` 并对相同请求复用。Token 仅在内存中持有
 * （由 `auth-controller.ts` 持有，本类通过 `tokenProvider` 回调读取，不
 * 直接持久化 token）。
 */
import type {
	AgentDefinitionListResponse,
	AuditEventListResponse,
	ControlErrorEnvelope,
	CreateLaunchKeyResponse,
	CreatePublishedAppResponse,
	CreatePublishedAppVersionResponse,
	ImportAgentResponse,
	LaunchKeyListResponse,
	PublishedAppDetail,
	PublishedAppListResponse,
	PublishedAppVersionListResponse,
	RevokeLaunchKeyResponse,
	SuspendAppResponse,
	TenantInfo,
	VersionTransitionResponse,
} from "./types.ts";
import { PublishingApiError } from "./types.ts";

const CONTROL_PREFIX = "/api/control/v1";

interface RequestInit {
	readonly method: "GET" | "POST";
	readonly headers?: Record<string, string>;
	readonly body?: unknown;
	/** When omitted for a POST, a fresh idempotency key is generated. */
	readonly idempotencyKey?: string;
}

export interface PublishingApiOptions {
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	/** Test injection for deterministic idempotency keys. */
	readonly randomUUID?: () => string;
	/** Lazy token reader: never stores the token. */
	readonly tokenProvider?: () => string | null;
}

export class PublishingApi {
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly randomUUID: () => string;
	private tokenProvider: () => string | null;
	/** Pending idempotency keys per (operation, bodyHash) so retries reuse. */
	private readonly idempotencyCache = new Map<string, string>();

	constructor(options: PublishingApiOptions = {}) {
		this.baseUrl = options.baseUrl ?? "";
		this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
		this.randomUUID = options.randomUUID ?? defaultRandomUUID;
		this.tokenProvider = options.tokenProvider ?? (() => null);
	}

	setTokenProvider(provider: () => string | null): void {
		this.tokenProvider = provider;
	}

	async listAgentDefinitions(input: {
		readonly limit?: number;
		readonly cursor?: string;
		readonly includeRevisions?: boolean;
	}): Promise<AgentDefinitionListResponse> {
		const query = new URLSearchParams();
		if (input.limit !== undefined) query.set("limit", String(input.limit));
		if (input.cursor !== undefined) query.set("cursor", input.cursor);
		if (input.includeRevisions !== undefined) query.set("includeRevisions", String(input.includeRevisions));
		return this.request<AgentDefinitionListResponse>({
			method: "GET",

			path: `${CONTROL_PREFIX}/agent-definitions?${query.toString()}`,
		});
	}

	async importCurrentAgent(): Promise<ImportAgentResponse> {
		return this.request<ImportAgentResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/agent-definitions/import-current`,
			operation: "agent-definitions.import-current",
			body: {},
		});
	}

	async listPublishedApps(input: {
		readonly limit?: number;
		readonly cursor?: string;
		readonly status?: string;
	}): Promise<PublishedAppListResponse> {
		const query = new URLSearchParams();
		if (input.limit !== undefined) query.set("limit", String(input.limit));
		if (input.cursor !== undefined) query.set("cursor", input.cursor);
		if (input.status !== undefined && input.status !== "") query.set("status", input.status);
		return this.request<PublishedAppListResponse>({
			method: "GET",

			path: `${CONTROL_PREFIX}/published-apps?${query.toString()}`,
		});
	}

	async getPublishedApp(appId: string): Promise<PublishedAppDetail> {
		return this.request<PublishedAppDetail>({
			method: "GET",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(appId)}`,
		});
	}

	async createPublishedApp(input: {
		readonly agentDefinitionId: string;
		readonly name: string;
		readonly accessMode: "anonymous" | "signed_user" | "mixed";
		readonly allowedOrigins?: readonly string[];
		readonly theme?: { readonly primaryColor?: string; readonly welcomeMessage?: string };
	}): Promise<CreatePublishedAppResponse> {
		return this.request<CreatePublishedAppResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps`,
			operation: "published-apps.create",
			body: input,
		});
	}

	async listVersions(input: {
		readonly appId: string;
		readonly limit?: number;
		readonly cursor?: string;
	}): Promise<PublishedAppVersionListResponse> {
		const query = new URLSearchParams();
		if (input.limit !== undefined) query.set("limit", String(input.limit));
		if (input.cursor !== undefined) query.set("cursor", input.cursor);
		return this.request<PublishedAppVersionListResponse>({
			method: "GET",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/versions?${query.toString()}`,
		});
	}

	async createVersion(input: {
		readonly appId: string;
		readonly sourceAgentRevision: number;
	}): Promise<CreatePublishedAppVersionResponse> {
		return this.request<CreatePublishedAppVersionResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/versions`,
			operation: "published-apps.create-version",
			body: { sourceAgentRevision: input.sourceAgentRevision },
		});
	}

	async activateVersion(input: {
		readonly appId: string;
		readonly versionId: string;
	}): Promise<VersionTransitionResponse> {
		return this.request<VersionTransitionResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/activate`,
			operation: "published-apps.activate",
			body: { versionId: input.versionId },
		});
	}

	async rollbackVersion(input: {
		readonly appId: string;
		readonly versionId: string;
	}): Promise<VersionTransitionResponse> {
		return this.request<VersionTransitionResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/rollback`,
			operation: "published-apps.rollback",
			body: { versionId: input.versionId },
		});
	}

	async suspendApp(input: { readonly appId: string; readonly reason?: string }): Promise<SuspendAppResponse> {
		return this.request<SuspendAppResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/suspend`,
			operation: "published-apps.suspend",
			body: input.reason === undefined ? {} : { reason: input.reason },
		});
	}

	async resumeApp(input: { readonly appId: string }): Promise<SuspendAppResponse> {
		// Resume uses activate (spec §5.4). Re-target the current ready version.
		const detail = await this.getPublishedApp(input.appId);
		if (detail.currentVersion === null) {
			throw new PublishingApiError(
				{ code: "NO_CURRENT_VERSION", message: "App 没有可激活的版本", requestId: "", retryable: false },
				409,
			);
		}
		return this.activateVersion({
			appId: input.appId,
			versionId: detail.currentVersion.id,
		}) as unknown as Promise<SuspendAppResponse>;
	}

	async listLaunchKeys(appId: string): Promise<LaunchKeyListResponse> {
		return this.request<LaunchKeyListResponse>({
			method: "GET",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(appId)}/launch-keys`,
		});
	}

	async createLaunchKey(input: {
		readonly appId: string;
		readonly keyId: string;
		readonly publicKeyPem: string;
		readonly notBefore?: string;
		readonly expiresAt?: string | null;
	}): Promise<CreateLaunchKeyResponse> {
		const body: Record<string, unknown> = {
			keyId: input.keyId,
			publicKeyPem: input.publicKeyPem,
		};
		if (input.notBefore !== undefined) body.notBefore = input.notBefore;
		if (input.expiresAt !== undefined) body.expiresAt = input.expiresAt;
		return this.request<CreateLaunchKeyResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/launch-keys`,
			operation: "published-apps.create-launch-key",
			body,
		});
	}

	async revokeLaunchKey(input: { readonly appId: string; readonly keyId: string }): Promise<RevokeLaunchKeyResponse> {
		return this.request<RevokeLaunchKeyResponse>({
			method: "POST",

			path: `${CONTROL_PREFIX}/published-apps/${encodeURIComponent(input.appId)}/launch-keys/${encodeURIComponent(input.keyId)}/revoke`,
			operation: "published-apps.revoke-launch-key",
			body: {},
		});
	}

	async listAuditEvents(input: {
		readonly appId?: string;
		readonly limit?: number;
		readonly cursor?: string;
	}): Promise<AuditEventListResponse> {
		const query = new URLSearchParams();
		if (input.limit !== undefined) query.set("limit", String(input.limit));
		if (input.cursor !== undefined) query.set("cursor", input.cursor);
		if (input.appId !== undefined) query.set("appId", input.appId);
		return this.request<AuditEventListResponse>({
			method: "GET",

			path: `${CONTROL_PREFIX}/audit-events?${query.toString()}`,
		});
	}

	/**
	 * Boot info: returns the bootstrap tenant id+name from a successful control
	 * request. The admin UI uses the first listPublishedApps response's
	 * requestId to render tenant info; the server surfaces `X-Tenant-Name` on
	 * every control response, so this reads the side-channel.
	 */
	async ping(): Promise<TenantInfo | null> {
		const result = await this.rawRequest<unknown>({
			method: "GET",

			path: `${CONTROL_PREFIX}/published-apps?limit=1`,
			operation: undefined,
		});
		const tenantId = result.headers.get("x-tenant-id");
		const tenantName = result.headers.get("x-tenant-name");
		if (tenantId === null || tenantName === null) return null;
		return { id: tenantId, name: tenantName };
	}

	private async request<T>(init: RequestInit & { readonly path: string; readonly operation?: string }): Promise<T> {
		const response = await this.rawRequest<T>(init);
		const envelope = response.body as { data?: T } | undefined;
		if (envelope?.data === undefined) {
			throw new PublishingApiError(
				{ code: "INVALID_RESPONSE", message: "响应缺少 data", requestId: response.requestId, retryable: false },
				response.status,
			);
		}
		return envelope.data;
	}

	private async rawRequest<T>(init: RequestInit & { readonly path: string; readonly operation?: string }): Promise<{
		status: number;
		body: T | ControlErrorEnvelope | undefined;
		requestId: string;
		headers: Headers;
	}> {
		const headers: Record<string, string> = {
			"x-request-id": this.randomUUID(),
			...(init.headers ?? {}),
		};
		const token = this.tokenProvider();
		if (token !== null && token !== "") headers.authorization = `Bearer ${token}`;
		if (init.method === "POST" && init.body !== undefined) headers["content-type"] = "application/json";
		let idempotencyFingerprint: string | undefined;
		if (init.method === "POST" && init.operation !== undefined) {
			idempotencyFingerprint = this.idempotencyFingerprint(init.operation, init.body);
			const key = this.lookupIdempotencyKey(idempotencyFingerprint);
			headers["idempotency-key"] = key;
		}

		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${init.path}`, {
				method: init.method,
				headers,
				body: init.method === "POST" && init.body !== undefined ? JSON.stringify(init.body) : undefined,
			});
		} catch {
			throw new PublishingApiError(
				{ code: "NETWORK_ERROR", message: "无法连接控制平面", requestId: "", retryable: true },
				0,
			);
		}
		const raw = await response.text().catch(() => "");
		const requestId = response.headers.get("x-request-id") ?? headers["x-request-id"] ?? "";
		let body: T | ControlErrorEnvelope | undefined;
		try {
			body = raw === "" ? undefined : (JSON.parse(raw) as unknown as T | ControlErrorEnvelope);
		} catch {
			body = undefined;
		}
		if (!response.ok) {
			const envelope = (body as ControlErrorEnvelope | undefined)?.error;
			const error = envelope ?? {
				code: "HTTP_ERROR",
				message: `HTTP ${response.status}`,
				requestId,
				retryable: response.status >= 500,
			};
			if (!error.retryable && idempotencyFingerprint !== undefined) {
				this.idempotencyCache.delete(idempotencyFingerprint);
			}
			throw new PublishingApiError(error, response.status);
		}
		if (idempotencyFingerprint !== undefined) this.idempotencyCache.delete(idempotencyFingerprint);
		return { status: response.status, body, requestId, headers: response.headers };
	}

	private idempotencyFingerprint(operation: string, body: unknown): string {
		return `${operation}|${stableStringify(body)}`;
	}

	private lookupIdempotencyKey(fingerprint: string): string {
		const cached = this.idempotencyCache.get(fingerprint);
		if (cached !== undefined) return cached;
		const key = this.randomUUID();
		this.idempotencyCache.set(fingerprint, key);
		// Cap the cache to avoid leaks.
		if (this.idempotencyCache.size > 64) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey !== undefined) this.idempotencyCache.delete(firstKey);
		}
		return key;
	}
}

function defaultRandomUUID(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `req_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

/** Deterministic JSON.stringify for idempotency body hashing (key order matters for replay). */
function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

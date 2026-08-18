/**
 * Admin Session API client (MVP-01).
 *
 * Single-purpose client: verify an admin token against
 * `GET /api/control/v1/session` and return the server-derived tenant
 * projection. The token itself never leaves the AdminAuthController memory
 * and never appears in URLs, storage, console output, or thrown error
 * messages. 401 routes through the controller's `failConnection` so the
 * workbench transitions back to the locked screen and the in-memory token
 * is wiped.
 */
import type { AdminCapability, AdminSession } from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";

export interface AdminSessionApiOptions {
	readonly auth: AdminAuthController;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}

export class AdminSessionApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;
	constructor(message: string, httpStatus: number, requestId: string | null, code: string | null) {
		super(message);
		this.name = "AdminSessionApiError";
		this.httpStatus = httpStatus;
		this.requestId = requestId;
		this.code = code;
	}
}

interface Envelope<T> {
	readonly data: T;
	readonly requestId: string;
}
interface ErrorEnvelope {
	readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

export class AdminSessionApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: AdminSessionApiOptions) {
		this.auth = options.auth;
		this.baseUrl = (options.baseUrl ?? options.auth.getSnapshot().baseUrl).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	/**
	 * Verify the in-memory token by calling the server-side session endpoint.
	 * Throws {@link AdminSessionApiError} on non-2xx responses; on 401 the
	 * controller's token is wiped and listeners transition to the locked
	 * state. Returns a frozen {@link AdminSession} projection.
	 */
	async fetchSession(): Promise<AdminSession> {
		const token = this.auth.getToken();
		if (token === null || token === "") {
			throw new AdminSessionApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		}
		const url = `${this.baseUrl}/api/control/v1/session`;
		const response = await this.fetchImpl(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
		});
		if (response.status === 401) {
			this.auth.failConnection("Admin token rejected by server");
			throw new AdminSessionApiError("Admin token rejected", 401, null, "UNAUTHORIZED");
		}
		const text = await response.text();
		const parsed = (() => {
			if (text.length === 0) return null;
			try {
				return JSON.parse(text) as unknown;
			} catch {
				return null;
			}
		})();
		if (!response.ok) {
			const env = parsed as ErrorEnvelope | null;
			const errInfo = env?.error;
			const message = errInfo?.message ?? `HTTP ${response.status}`;
			throw new AdminSessionApiError(message, response.status, errInfo?.requestId ?? null, errInfo?.code ?? null);
		}
		const envelope = parsed as Envelope<{
			tenantId: string;
			tenantName: string;
			tenantStatus: AdminSession["tenantStatus"];
			baseUrl: string;
			capabilities: readonly string[];
		}>;
		const capabilities = new Set<AdminCapability>(envelope.data.capabilities as readonly AdminCapability[]);
		return Object.freeze({
			tenantId: envelope.data.tenantId as AdminSession["tenantId"],
			tenantName: envelope.data.tenantName,
			tenantStatus: envelope.data.tenantStatus,
			baseUrl: envelope.data.baseUrl,
			capabilities,
		}) satisfies AdminSession;
	}
}

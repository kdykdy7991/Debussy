import type {
	McpSecretStatusResponse,
	McpServerDetail,
	McpServerListResponse,
	McpServerRevisionSummary,
	McpStreamableHttpConfig,
	McpSyncToolsResponse,
	McpTestResponse,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { newIdempotencyKey } from "./idempotency.ts";

export class McpApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;
	constructor(message: string, status: number, requestId: string | null, code: string | null) {
		super(message);
		this.name = "McpApiError";
		this.httpStatus = status;
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

export class McpApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	constructor(options: {
		readonly auth: AdminAuthController;
		readonly baseUrl?: string;
		readonly fetchImpl?: typeof fetch;
	}) {
		this.auth = options.auth;
		this.baseUrl = (options.baseUrl ?? options.auth.getSnapshot().baseUrl).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}
	private async request<T>(input: {
		readonly method: "GET" | "POST" | "PATCH" | "DELETE";
		readonly path: string;
		readonly body?: unknown;
		readonly write?: boolean;
	}): Promise<T> {
		const token = this.auth.getToken();
		if (!token) throw new McpApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		if (input.write) headers["Idempotency-Key"] = newIdempotencyKey({ operation: "mcp.write" });
		const response = await this.fetchImpl(`${this.baseUrl}${input.path}`, {
			method: input.method,
			headers,
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		});
		if (response.status === 401) this.auth.failConnection("Admin token rejected by server");
		const text = await response.text();
		const parsed = text ? (JSON.parse(text) as unknown) : null;
		if (!response.ok) {
			const error = (parsed as ErrorEnvelope | null)?.error;
			throw new McpApiError(
				error?.message ?? `HTTP ${response.status}`,
				response.status,
				error?.requestId ?? null,
				error?.code ?? null,
			);
		}
		if (parsed === null) throw new McpApiError("Empty response", response.status, null, "EMPTY_RESPONSE");
		return (parsed as Envelope<T>).data;
	}
	list(limit = 50): Promise<McpServerListResponse> {
		return this.request({ method: "GET", path: `/api/control/v1/mcp-servers?limit=${limit}` });
	}
	get(id: string): Promise<McpServerDetail> {
		return this.request({ method: "GET", path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}` });
	}
	create(name: string, config: McpStreamableHttpConfig): Promise<McpServerDetail> {
		return this.request({ method: "POST", path: "/api/control/v1/mcp-servers", body: { name, config }, write: true });
	}
	createRevision(id: string, config: McpStreamableHttpConfig): Promise<McpServerRevisionSummary> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}/revisions`,
			body: { config },
			write: true,
		});
	}
	replaceSecret(id: string, bearerToken: string): Promise<McpSecretStatusResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}/secret`,
			body: { bearerToken },
			write: true,
		});
	}
	test(id: string): Promise<McpTestResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}/test`,
			body: {},
			write: true,
		});
	}
	syncTools(id: string): Promise<McpSyncToolsResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}/sync-tools`,
			body: {},
			write: true,
		});
	}
	setEnabled(id: string, enabled: boolean): Promise<{ readonly id: string; readonly enabled: boolean }> {
		return this.request({
			method: "PATCH",
			path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}/status`,
			body: { enabled },
			write: true,
		});
	}
	delete(id: string): Promise<{ readonly deleted: true }> {
		return this.request({
			method: "DELETE",
			path: `/api/control/v1/mcp-servers/${encodeURIComponent(id)}`,
			write: true,
		});
	}
}

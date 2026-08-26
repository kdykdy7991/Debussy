/**
 * Admin Agent HTTP client（WB-003）。
 *
 * 通过 `AdminAuthController` 持有的内存 token 调 Control API。**不写任何
 * Storage、URL 或 console**；401 由 controller 自动清空 token 并把状态推到
 * `error`，上层 useAdminAuth 监听到后回到锁屏。
 *
 * 协议 DTO 来自 `@earendil-works/pi-protocol` 根入口；本文件只做 fetch +
 * JSON 序列化，不做 shape 推断。
 */
import type {
	AgentCapabilities,
	AgentDefinitionAssociatedApp,
	AgentDefinitionDetail,
	AgentDefinitionListResponse,
	AgentDefinitionRevision,
	AgentDefinitionRevisionListResponse,
	AgentModelParameters,
	AgentPublicId,
	ImportCurrentAgentResponse,
	SaveAgentRevisionResponse,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { newIdempotencyKey } from "./idempotency.ts";

export interface AgentApiOptions {
	readonly auth: AdminAuthController;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}

export class AgentApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;
	constructor(message: string, httpStatus: number, requestId: string | null, code: string | null) {
		super(message);
		this.name = "AgentApiError";
		this.httpStatus = httpStatus;
		this.requestId = requestId;
		this.code = code;
	}
}

interface RequestOptions {
	readonly method: "GET" | "POST" | "DELETE";
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

export class AgentApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: AgentApiOptions) {
		this.auth = options.auth;
		this.baseUrl = (options.baseUrl ?? options.auth.getSnapshot().baseUrl).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	private async request<T>(opts: RequestOptions): Promise<T> {
		const token = this.auth.getToken();
		if (token === null || token === "") {
			throw new AgentApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
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
			throw new AgentApiError("Admin token rejected", 401, null, "UNAUTHORIZED");
		}
		const text = await response.text();
		const parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
		if (!response.ok) {
			const env = parsed as ErrorEnvelope | null;
			const errInfo = env?.error;
			const message = errInfo?.message ?? `HTTP ${response.status}`;
			// Mirror the same handling the PublishingApi does: surface the
			// error via AdminAuthController.handleApiError so 401 transitions
			// to the locked state and other failures keep the token alive.
			this.auth.handleApiError({
				name: "AgentApiError",
				code: errInfo?.code ?? "HTTP_ERROR",
				message,
				requestId: errInfo?.requestId ?? "",
				retryable: false,
				httpStatus: response.status,
			});
			throw new AgentApiError(message, response.status, errInfo?.requestId ?? null, errInfo?.code ?? null);
		}
		if (parsed === null) {
			throw new AgentApiError("Empty response", response.status, null, "EMPTY_RESPONSE");
		}
		const envelope = parsed as Envelope<T>;
		return envelope.data;
	}

	listAgents(input: { limit: number; cursor?: string }): Promise<AgentDefinitionListResponse> {
		const params = new URLSearchParams({ limit: String(input.limit) });
		if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
		return this.request<AgentDefinitionListResponse>({
			method: "GET",
			path: `/api/control/v1/agent-definitions?${params.toString()}`,
		});
	}

	getAgentDetail(agentId: AgentPublicId): Promise<AgentDefinitionDetail> {
		return this.request({ method: "GET", path: `/api/control/v1/agent-definitions/${agentId}` });
	}

	deleteAgent(agentId: AgentPublicId, confirmName: string): Promise<{ readonly deleted: true }> {
		return this.request({
			method: "DELETE",
			path: `/api/control/v1/agent-definitions/${agentId}`,
			body: { confirmName },
			idempotencyKey: newIdempotencyKey({ operation: "agent.delete" }),
		});
	}

	listRevisions(
		agentId: AgentPublicId,
		input: { limit: number; cursor?: string },
	): Promise<AgentDefinitionRevisionListResponse> {
		const params = new URLSearchParams({ limit: String(input.limit) });
		if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
		return this.request({
			method: "GET",
			path: `/api/control/v1/agent-definitions/${agentId}/revisions?${params.toString()}`,
		});
	}

	getRevision(agentId: AgentPublicId, revision: number): Promise<AgentDefinitionRevision> {
		return this.request({
			method: "GET",
			path: `/api/control/v1/agent-definitions/${agentId}/revisions/${revision}`,
		});
	}

	saveRevision(
		agentId: AgentPublicId,
		draft: {
			name?: string;
			description?: string;
			modelId: string | null;
			systemPrompt: string;
			parameters: AgentModelParameters;
			toolIds: readonly string[];
			knowledgeBaseIds: readonly string[];
			capabilities: AgentCapabilities;
			changeSummary: string;
		},
		idempotencyKey: string,
	): Promise<SaveAgentRevisionResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agentId}/revisions`,
			body: draft,
			idempotencyKey,
		});
	}

	listAgentApps(agentId: AgentPublicId): Promise<{ readonly items: readonly AgentDefinitionAssociatedApp[] }> {
		return this.request({ method: "GET", path: `/api/control/v1/agent-definitions/${agentId}/apps` });
	}

	/**
	 * Freeze the current agent configuration into an AgentDefinition
	 * (MVP-03 / spec 33.3). The server is naturally idempotent on the source
	 * hash, but we still send an Idempotency-Key so a network retry does not
	 * race against an in-flight import.
	 */
	importCurrentAgent(input?: { readonly expectedSourceHash?: string | null }): Promise<ImportCurrentAgentResponse> {
		const body =
			input?.expectedSourceHash === undefined || input.expectedSourceHash === null
				? {}
				: { expectedSourceHash: input.expectedSourceHash };
		return this.request<ImportCurrentAgentResponse>({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			body,
			idempotencyKey: newIdempotencyKey({ operation: "agent.import" }),
		});
	}
}

/**
 * Admin Custom LLM provider HTTP client.
 *
 * Thin fetch wrapper over the control LLM-provider routes. Protocol DTOs come
 * from `@earendil-works/pi-protocol`; this file only does fetch + JSON.
 */
import type {
	CustomLlmApi,
	CustomLlmProvider,
	LlmAvailableModel,
	LlmProviderResponse,
	LlmProviderTestResponse,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { AgentApiError } from "./agent-api.ts";
import { newIdempotencyKey } from "./idempotency.ts";

export interface LlmApiOptions {
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

export class LlmApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: LlmApiOptions) {
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
		const response = await this.fetchImpl(`${this.baseUrl}${opts.path}`, {
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
			this.auth.handleApiError({
				name: "LlmApiError",
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
		return (parsed as Envelope<T>).data;
	}

	listProviders(): Promise<{ readonly items: readonly CustomLlmProvider[] }> {
		return this.request({ method: "GET", path: "/api/control/v1/llm-providers" });
	}

	listModels(): Promise<{ readonly items: readonly LlmAvailableModel[] }> {
		return this.request({ method: "GET", path: "/api/control/v1/llm-providers/models" });
	}

	upsertProvider(input: {
		readonly id: string;
		readonly name: string;
		readonly baseUrl: string;
		readonly api: CustomLlmApi;
		readonly models: readonly string[];
		readonly apiKey?: string;
	}): Promise<LlmProviderResponse> {
		return this.request({
			method: "POST",
			path: "/api/control/v1/llm-providers",
			body: input,
			idempotencyKey: newIdempotencyKey({ operation: "llm-providers.upsert" }),
		});
	}

	deleteProvider(id: string): Promise<{ readonly removed: boolean }> {
		const safeId = encodeURIComponent(id);
		return this.request({
			method: "POST",
			path: `/api/control/v1/llm-providers/${safeId}/delete`,
			idempotencyKey: newIdempotencyKey({ operation: "llm-providers.delete" }),
		});
	}

	testProvider(input: {
		readonly baseUrl: string;
		readonly api: CustomLlmApi;
		readonly apiKey?: string;
	}): Promise<LlmProviderTestResponse> {
		return this.request({
			method: "POST",
			path: "/api/control/v1/llm-providers/test",
			body: input,
		});
	}
}

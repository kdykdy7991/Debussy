import type {
	SkillDetail,
	SkillImportResponse,
	SkillListResponse,
	SkillToggleResponse,
	SkillValidateResponse,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { newIdempotencyKey } from "./idempotency.ts";

export class SkillApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;

	constructor(message: string, httpStatus: number, requestId: string | null, code: string | null) {
		super(message);
		this.name = "SkillApiError";
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

export class SkillApi {
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
		if (!token) throw new SkillApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		if (input.write) headers["Idempotency-Key"] = newIdempotencyKey({ operation: "skill.write" });
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
			throw new SkillApiError(
				error?.message ?? `HTTP ${response.status}`,
				response.status,
				error?.requestId ?? null,
				error?.code ?? null,
			);
		}
		if (parsed === null) throw new SkillApiError("Empty response", response.status, null, "EMPTY_RESPONSE");
		return (parsed as Envelope<T>).data;
	}

	list(limit = 50, cursor?: string): Promise<SkillListResponse> {
		const params = new URLSearchParams({ limit: String(limit) });
		if (cursor) params.set("cursor", cursor);
		return this.request({ method: "GET", path: `/api/control/v1/skills?${params}` });
	}

	get(skillId: string): Promise<SkillDetail> {
		return this.request({ method: "GET", path: `/api/control/v1/skills/${encodeURIComponent(skillId)}` });
	}

	import(filename: string, contentBase64: string): Promise<SkillImportResponse> {
		return this.request({
			method: "POST",
			path: "/api/control/v1/skills/import",
			body: { filename, contentBase64 },
			write: true,
		});
	}

	createRevision(skillId: string, filename: string, contentBase64: string): Promise<SkillImportResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/skills/${encodeURIComponent(skillId)}/revisions`,
			body: { filename, contentBase64 },
			write: true,
		});
	}

	validate(skillId: string): Promise<SkillValidateResponse> {
		return this.request({
			method: "POST",
			path: `/api/control/v1/skills/${encodeURIComponent(skillId)}/validate`,
			body: {},
			write: true,
		});
	}

	setEnabled(skillId: string, enabled: boolean): Promise<SkillToggleResponse> {
		return this.request({
			method: "PATCH",
			path: `/api/control/v1/skills/${encodeURIComponent(skillId)}/status`,
			body: { enabled },
			write: true,
		});
	}

	delete(skillId: string): Promise<{ readonly deleted: true }> {
		return this.request({
			method: "DELETE",
			path: `/api/control/v1/skills/${encodeURIComponent(skillId)}`,
			write: true,
		});
	}
}

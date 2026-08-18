/**
 * Admin user-conversation HTTP client (WB-006 / SPEC §5.4).
 *
 * Mirrors `app-api.ts`: reads the admin token from `AdminAuthController`,
 * sets the Authorization header, and propagates 401 to the lock state. It
 * only fetches + JSON-serialises — no shape inference. All DTOs come from
 * `@earendil-works/pi-protocol`.
 *
 * The endpoints the client talks to never return raw `externalUserId` /
 * `visitorId` / PEM; the list is always redacted (`redacted: true`) and the
 * caller must fetch `/events` to see message bodies.
 */
import type {
	ConversationAdminEventListResponse,
	ConversationAdminListResponse,
	ConversationAdminSummaryListResponse,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";

export interface ConversationsApiOptions {
	readonly auth: AdminAuthController;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}

export class ConversationsApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;
	constructor(message: string, httpStatus: number, requestId: string | null, code: string | null) {
		super(message);
		this.name = "ConversationsApiError";
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

/** Filters accepted by the admin conversation list endpoint (WB-006). */
export interface ConversationListArgs {
	readonly limit?: number;
	readonly cursor?: string;
	readonly status?: "active" | "archived" | "deleted" | "";
	readonly hasErrors?: boolean;
	readonly appId?: string;
	readonly agentId?: string;
	readonly principalType?: "external_user" | "anonymous_visitor" | "";
	readonly publishedAppVersionId?: string;
}

export class ConversationsApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ConversationsApiOptions) {
		this.auth = options.auth;
		this.baseUrl = (options.baseUrl ?? options.auth.getSnapshot().baseUrl).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
	}

	private async request<T>(path: string): Promise<T> {
		const token = this.auth.getToken();
		if (token === null || token === "") {
			throw new ConversationsApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		}
		const url = `${this.baseUrl}${path}`;
		const response = await this.fetchImpl(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
		});
		const text = await response.text();
		const parsed: unknown = text === "" ? null : safeParse(text);
		if (!response.ok) {
			const errInfo = (parsed as ErrorEnvelope | null)?.error ?? null;
			const message = errInfo?.message ?? `HTTP ${response.status}`;
			this.auth.handleApiError({
				name: "ConversationsApiError",
				code: errInfo?.code ?? "HTTP_ERROR",
				message,
				requestId: errInfo?.requestId ?? "",
				retryable: false,
				httpStatus: response.status,
			});
			throw new ConversationsApiError(message, response.status, errInfo?.requestId ?? null, errInfo?.code ?? null);
		}
		if (parsed === null) {
			throw new ConversationsApiError("Empty response", response.status, null, "EMPTY_RESPONSE");
		}
		const envelope = parsed as Envelope<T>;
		return envelope.data;
	}

	list(input: ConversationListArgs): Promise<ConversationAdminListResponse> {
		const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
		if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
		if (input.status !== undefined && input.status !== "") params.set("status", input.status);
		if (input.hasErrors !== undefined) params.set("hasErrors", String(input.hasErrors));
		if (input.appId !== undefined && input.appId !== "") params.set("appId", input.appId);
		if (input.agentId !== undefined && input.agentId !== "") params.set("agentId", input.agentId);
		if (input.principalType !== undefined && input.principalType !== "") {
			params.set("principalType", input.principalType);
		}
		if (input.publishedAppVersionId !== undefined && input.publishedAppVersionId !== "") {
			params.set("publishedAppVersionId", input.publishedAppVersionId);
		}
		return this.request<ConversationAdminListResponse>(`/api/control/v1/conversations?${params.toString()}`);
	}

	getDetail(conversationId: string): Promise<{
		readonly conversation: import("@earendil-works/pi-protocol").ConversationAdminSummary;
		readonly rollover: {
			readonly previousConversationId: string | null;
			readonly nextConversationId: string | null;
			readonly rolledOverAt: string | null;
		};
		readonly latestSummary: import("@earendil-works/pi-protocol").ConversationAdminSummaryEntry | null;
	}> {
		return this.request(`/api/control/v1/conversations/${encodeURIComponent(conversationId)}`);
	}

	listEvents(
		conversationId: string,
		args: { limit?: number; afterSequence?: number },
	): Promise<ConversationAdminEventListResponse> {
		const params = new URLSearchParams({ limit: String(args.limit ?? 50) });
		if (args.afterSequence !== undefined && args.afterSequence > 0) {
			params.set("afterSequence", String(args.afterSequence));
		}
		return this.request<ConversationAdminEventListResponse>(
			`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/events?${params.toString()}`,
		);
	}

	listSummaries(conversationId: string): Promise<ConversationAdminSummaryListResponse> {
		return this.request<ConversationAdminSummaryListResponse>(
			`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/summaries`,
		);
	}

	listAttachments(
		conversationId: string,
	): Promise<import("@earendil-works/pi-protocol").ConversationAdminAttachmentListResponse> {
		return this.request<import("@earendil-works/pi-protocol").ConversationAdminAttachmentListResponse>(
			`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/attachments`,
		);
	}
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

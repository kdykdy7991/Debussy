/**
 * Embed HTTP API 客户端（TASK-019）。
 *
 * 同源调用 `/api/embed/v1/*`（生产 iframe 与 API 同源；开发经 Vite 代理或
 * 手动配置 baseUrl）。统一错误信封解析（spec 8.3）：非 2xx 抛
 * `EmbedApiError`（带稳定 code 与 retryable）。
 */
import type {
	BootstrapResponse,
	ConversationDetailResponse,
	ConversationListResponse,
	ConversationSummary,
	DeleteAttachmentResponse,
	DevTurnResponse,
	EmbedAttachmentView,
	EmbedErrorEnvelope,
	ExchangeRequest,
	ExchangeResponse,
	WsTicketResponse,
} from "./types.ts";

export class EmbedApiError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	constructor(code: string, message: string, retryable: boolean) {
		super(message);
		this.name = "EmbedApiError";
		this.code = code;
		this.retryable = retryable;
	}
}

export interface EmbedApiOptions {
	/** API 基地址；默认同源（iframe 生产场景）。 */
	readonly baseUrl?: string;
	/** 测试注入。 */
	readonly fetchImpl?: typeof fetch;
}

export class EmbedApi {
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: EmbedApiOptions = {}) {
		this.baseUrl = options.baseUrl ?? "";
		this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
	}

	async bootstrap(publicAppId: string): Promise<BootstrapResponse> {
		return this.request<BootstrapResponse>(`/api/embed/v1/bootstrap?publicAppId=${encodeURIComponent(publicAppId)}`, {
			method: "GET",
		});
	}

	async exchange(request: ExchangeRequest): Promise<ExchangeResponse> {
		return this.request<ExchangeResponse>("/api/embed/v1/exchange", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
	}

	async listConversations(token: string, limit = 20, cursor?: string): Promise<ConversationListResponse> {
		const query = new URLSearchParams({ limit: String(limit) });
		if (cursor !== undefined) query.set("cursor", cursor);
		return this.request<ConversationListResponse>(`/api/embed/v1/conversations?${query.toString()}`, {
			method: "GET",
			token,
		});
	}

	async createConversation(token: string, title = ""): Promise<ConversationSummary> {
		return this.request<ConversationSummary>("/api/embed/v1/conversations", {
			method: "POST",
			token,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});
	}

	async getConversation(token: string, conversationId: string): Promise<ConversationDetailResponse> {
		return this.request<ConversationDetailResponse>(`/api/embed/v1/conversations/${conversationId}`, {
			method: "GET",
			token,
		});
	}

	/** 归档本人会话（spec 8.2）。 */
	async archiveConversation(token: string, conversationId: string): Promise<ConversationSummary> {
		return this.request<ConversationSummary>(`/api/embed/v1/conversations/${conversationId}/archive`, {
			method: "POST",
			token,
		});
	}

	/**
	 * 上传附件（spec 8.2 / 27.5）：raw body + `x-filename` 头；响应直接回公开
	 * `att_<uuid>`/`conv_<uuid>` id（TASK-033），可回填 DELETE/GET 路径。
	 */
	async uploadAttachment(
		token: string,
		conversationId: string,
		input: {
			readonly filename: string;
			readonly contentType: string;
			readonly checksumSha256?: string;
			readonly data: Uint8Array;
		},
	): Promise<EmbedAttachmentView> {
		const headers: Record<string, string> = {
			"content-type": input.contentType,
			"x-filename": input.filename,
		};
		if (input.checksumSha256 !== undefined) headers["x-checksum-sha256"] = input.checksumSha256;
		return this.request<EmbedAttachmentView>(`/api/embed/v1/conversations/${conversationId}/uploads`, {
			method: "POST",
			token,
			headers,
			body: input.data,
		});
	}

	/** 删除本人附件（幂等）。 */
	async deleteAttachment(
		token: string,
		conversationId: string,
		attachmentId: string,
	): Promise<DeleteAttachmentResponse> {
		return this.request<DeleteAttachmentResponse>(
			`/api/embed/v1/conversations/${conversationId}/uploads/${attachmentId}`,
			{ method: "DELETE", token },
		);
	}

	/** 申请一次性 WebSocket Ticket（spec 27.6；TASK-026）。 */
	async getWsTicket(token: string, conversationId: string): Promise<WsTicketResponse> {
		return this.request<WsTicketResponse>(`/api/embed/v1/conversations/${conversationId}/ws-ticket`, {
			method: "POST",
			token,
		});
	}

	/** TASK-018 临时文本 Turn 路径（最终由 Realtime 取代）。 */
	async sendTurn(token: string, conversationId: string, text: string): Promise<DevTurnResponse> {
		return this.request<DevTurnResponse>(`/api/embed/v1/dev/conversations/${conversationId}/turn`, {
			method: "POST",
			token,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
	}

	private async request<T>(
		path: string,
		init: { method: string; token?: string; headers?: Record<string, string>; body?: string | Uint8Array },
	): Promise<T> {
		const headers: Record<string, string> = { ...(init.headers ?? {}) };
		if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: init.method,
				headers,
				body: init.body as BodyInit | undefined,
			});
		} catch {
			throw new EmbedApiError("NETWORK_ERROR", "无法连接服务器", true);
		}
		const raw = await response.text().catch(() => "");
		let body: unknown;
		try {
			body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
		} catch {
			body = raw;
		}
		if (!response.ok) {
			const envelope = (body as EmbedErrorEnvelope | undefined)?.error;
			throw new EmbedApiError(
				envelope?.code ?? "HTTP_ERROR",
				envelope?.message ?? `HTTP ${response.status}`,
				envelope?.retryable ?? response.status >= 500,
			);
		}
		const data = (body as { data?: T }).data;
		if (data === undefined) throw new EmbedApiError("INVALID_RESPONSE", "响应缺少 data", false);
		return data;
	}
}

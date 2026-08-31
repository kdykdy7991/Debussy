/**
 * Embed HTTP API 客户端（TASK-019）。
 *
 * 同源调用 `/api/embed/v1/*`（生产 iframe 与 API 同源；开发经 Vite 代理或
 * 手动配置 baseUrl）。统一错误信封解析（spec 8.3）：非 2xx 抛
 * `EmbedApiError`（带稳定 code 与 retryable）。
 *
 * # reasoning 端点
 *
 * `getConversationReasoning` / `putConversationReasoning` 走
 * `/api/embed/v1/conversations/:id/reasoning`：
 * - PUT 已冻结（契约 §11）；`null` 清除会话覆盖；错误码透传；
 * - GET 由后端 Q5 补齐（契约 §11 Q5 决策），复用 `ConversationReasoningState`；
 *   SDK consumer 已就绪，待 BE Q5 合入即按最终返回 DTO 接入。
 *
 * 30 秒请求超时（与 stale guard 取消信号正交）通过 `withReasoningTimeout`
 * 包装——caller signal 由 `AbortSignal.any` 并联：caller abort 抛
 * `AbortError`（静默吞掉），30s 超时抛 `EmbedApiError.code =
 * "REQUEST_TIMEOUT"` `retryable=true`，由调用方引导手动重试（PUT 幂等）。
 */
import type { ConversationReasoningState, ReasoningUpdateRequest } from "@earendil-works/pi-protocol";
import type {
	BootstrapResponse,
	ConversationDetailResponse,
	ConversationListResponse,
	ConversationResumeResponse,
	ConversationSummary,
	CreateConversationResponse,
	DeleteAttachmentResponse,
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

/**
 * Embed 推理端点稳定错误码（admin + embed 共享 `AGENT_V2_REASONING_ERROR_CODES`）；
 * "REQUEST_TIMEOUT" 是前端 transport code（契约 §11 Q4：embed 不再细分）。
 *
 * 这里不重复列出，只在 timeout 包装里手工 throw 时使用同一字面量字符串。
 */

export interface EmbedApiOptions {
	/** API 基地址；默认同源（iframe 生产场景）。 */
	readonly baseUrl?: string;
	/** 测试注入。 */
	readonly fetchImpl?: typeof fetch;
}

export class EmbedApi {
	private static readonly REASONING_TIMEOUT_MS = 30_000 as const;

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

	async createConversation(token: string, title = ""): Promise<CreateConversationResponse> {
		return this.request<CreateConversationResponse>("/api/embed/v1/conversations", {
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

	/**
	 * P2 public-chat resume: `POST /conversations/:id/resume`. When the
	 * conversation's pinned version went stale the server returns a NEW
	 * conversation on the CURRENT version (preserving the old one); when the
	 * version is still current it returns the same conversation (`resumed`).
	 */
	async resumeConversation(token: string, conversationId: string): Promise<ConversationResumeResponse> {
		return this.request<ConversationResumeResponse>(`/api/embed/v1/conversations/${conversationId}/resume`, {
			method: "POST",
			token,
			headers: { "content-type": "application/json" },
			body: "{}",
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

	private async request<T>(
		path: string,
		init: {
			method: string;
			token?: string;
			headers?: Record<string, string>;
			body?: string | Uint8Array;
			signal?: AbortSignal;
		},
	): Promise<T> {
		const headers: Record<string, string> = { ...(init.headers ?? {}) };
		if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: init.method,
				headers,
				body: init.body as BodyInit | undefined,
				signal: init.signal,
			});
		} catch (err) {
			// AbortError 透传：caller signal 取消时让上层（如 reasoning 超时包装）
			// 自己决定如何映射（EmbedApiError / 静默吞掉）。
			if (err instanceof DOMException && err.name === "AbortError") throw err;
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

	/**
	 * 读取会话级 thinking effort 覆盖（契约 §11）。
	 *
	 * ⚠️ 后端 Q5 待合入——当前 embed 平面**不**提供 GET（dbe175e）。
	 * SDK consumer 已就绪（与 admin `ConversationsApi.getReasoning` 同型，
	 * 返回 `ConversationReasoningState`），Q5 合入即生效。前端业务代码
	 * 不要在 Q5 落地前调用本方法，避免期望与后端不一致。
	 */
	async getConversationReasoning(
		token: string,
		conversationId: string,
		signal?: AbortSignal,
	): Promise<ConversationReasoningState> {
		return this.withReasoningTimeout(signal, (combined) =>
			this.request<ConversationReasoningState>(
				`/api/embed/v1/conversations/${encodeURIComponent(conversationId)}/reasoning`,
				{ method: "GET", token, signal: combined },
			),
		);
	}

	/**
	 * 设置会话级 thinking effort 覆盖（PUT 幂等；契约 §11）。
	 *
	 * `effort: null` 清除会话覆盖，回到 Agent Revision 默认；错误码透传
	 * （`REASONING_INVALID_EFFORT` 422 / `REASONING_NOT_CONFIGURABLE` 403
	 * / `CONVERSATION_NOT_FOUND` 404），UI 应展示错误码 + 当前 draft，
	 * 不进入 loading 态。
	 */
	async putConversationReasoning(
		token: string,
		conversationId: string,
		body: ReasoningUpdateRequest,
		signal?: AbortSignal,
	): Promise<ConversationReasoningState> {
		return this.withReasoningTimeout(signal, (combined) =>
			this.request<ConversationReasoningState>(
				`/api/embed/v1/conversations/${encodeURIComponent(conversationId)}/reasoning`,
				{
					method: "PUT",
					token,
					signal: combined,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			),
		);
	}

	/**
	 * Embed 推理端点的 30 秒超时；与 caller signal 正交组合（与 admin
	 * `ConversationsApi.withReasoningTimeout` 同型）。区分两种 abort：
	 * - caller signal（stale guard / 卸载）→ 原 `AbortError`；
	 * - 30s timeout → `EmbedApiError{ code: "REQUEST_TIMEOUT", retryable: true }`。
	 */
	private async withReasoningTimeout<T>(
		callerSignal: AbortSignal | undefined,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => {
			timeoutController.abort(new DOMException("reasoning request timed out", "TimeoutError"));
		}, EmbedApi.REASONING_TIMEOUT_MS);
		try {
			const combinedSignal =
				callerSignal !== undefined
					? AbortSignal.any([callerSignal, timeoutController.signal])
					: timeoutController.signal;
			return await fn(combinedSignal);
		} catch (err) {
			if (timeoutController.signal.aborted && err instanceof DOMException && err.name === "AbortError") {
				throw new EmbedApiError("REQUEST_TIMEOUT", "reasoning 请求超时（30s），请重试", true);
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

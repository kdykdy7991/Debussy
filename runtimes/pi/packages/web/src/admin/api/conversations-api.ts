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
import {
	AGENT_V2_METRICS_ERRORS,
	AGENT_V2_REASONING_ERRORS,
	type AgentV2MetricsErrorCode,
	type AgentV2ReasoningErrorCode,
	type ConversationAdminEventListResponse,
	type ConversationAdminListResponse,
	type ConversationAdminSummaryListResponse,
	type ConversationContextResponse,
	type ConversationExportMode,
	type ConversationMetricsQuery,
	type ConversationMetricsResponse,
	type ConversationReasoningState,
	type ReasoningUpdateRequest,
} from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { newIdempotencyKey } from "./idempotency.ts";

export interface ConversationsApiOptions {
	readonly auth: AdminAuthController;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}

/**
 * 服务端 `code` 是已知协议码时返回其协议元数据；否则按 HTTP 状态推断重试性。
 *
 * 已知协议错误码（metrics + reasoning 联合）：
 * - `AGENT_V2_METRICS_ERRORS[code].retryable` — metrics 错误码；
 * - `AGENT_V2_REASONING_ERRORS[code].retryable` — reasoning 错误码。
 *
 * 未知码：
 * - 401/403 → 不可重试（凭证/权限错误，再试一次也不会变）；
 * - 408/425/429/5xx → 可重试；
 * - 其它 4xx → 不可重试。
 *
 * 这里**不**只依赖 HTTP 兜底：reasoning 错误码 `REASONING_INVALID_EFFORT`
 * (422) / `REASONING_NOT_CONFIGURABLE` (403) 当前恰好都不可重试，但**协议表是
 * 权威**——如果未来某个码被改成可重试，前端会跟随；HTTP 兜底只对真正未知的
 * 码生效。
 */
function resolveRetryable(code: string | null, httpStatus: number): boolean {
	if (code !== null && code in AGENT_V2_METRICS_ERRORS) {
		return AGENT_V2_METRICS_ERRORS[code as AgentV2MetricsErrorCode].retryable;
	}
	if (code !== null && code in AGENT_V2_REASONING_ERRORS) {
		return AGENT_V2_REASONING_ERRORS[code as AgentV2ReasoningErrorCode].retryable;
	}
	if (httpStatus === 408 || httpStatus === 425 || httpStatus === 429) return true;
	if (httpStatus >= 500 && httpStatus <= 599) return true;
	return false;
}

export class ConversationsApiError extends Error {
	readonly httpStatus: number;
	readonly requestId: string | null;
	readonly code: string | null;
	/** 来自协议 `AGENT_V2_METRICS_ERRORS` 或 HTTP 状态推断；UI 直接使用，不需要再查表。 */
	readonly retryable: boolean;
	constructor(
		message: string,
		httpStatus: number,
		requestId: string | null,
		code: string | null,
		retryable?: boolean,
	) {
		super(message);
		this.name = "ConversationsApiError";
		this.httpStatus = httpStatus;
		this.requestId = requestId;
		this.code = code;
		this.retryable = retryable ?? resolveRetryable(code, httpStatus);
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
	readonly createdAfter?: string;
	readonly createdBefore?: string;
}

export class ConversationsApi {
	/** reasoning 端点的请求超时（与 stale guard 取消信号正交）。 */
	private static readonly REASONING_TIMEOUT_MS = 30_000 as const;
	/** 超时错误的稳定 transport code（前端 API 层；非协议码）。 */
	private static readonly REQUEST_TIMEOUT_CODE = "REQUEST_TIMEOUT" as const;

	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ConversationsApiOptions) {
		this.auth = options.auth;
		this.baseUrl = (options.baseUrl ?? options.auth.getSnapshot().baseUrl).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	private async request<T>(path: string, init: { readonly signal?: AbortSignal } = {}): Promise<T> {
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
			...(init.signal !== undefined ? { signal: init.signal } : {}),
		});
		const text = await response.text();
		const parsed: unknown = text === "" ? null : safeParse(text);
		if (!response.ok) {
			const errInfo = (parsed as ErrorEnvelope | null)?.error ?? null;
			const code = errInfo?.code ?? "HTTP_ERROR";
			const message = errInfo?.message ?? `HTTP ${response.status}`;
			const requestId = errInfo?.requestId ?? null;
			// 重试性按协议表 + HTTP 状态统一计算一次，handleApiError 和抛出的
			// ConversationsApiError 必须**拿到同一个值**，否则 UI 与认证控制器会
			// 出现两套重试语义。
			const retryable = resolveRetryable(code, response.status);
			this.auth.handleApiError({
				name: "ConversationsApiError",
				code,
				message,
				requestId: requestId ?? "",
				retryable,
				httpStatus: response.status,
			});
			throw new ConversationsApiError(message, response.status, requestId, code, retryable);
		}
		if (parsed === null) {
			throw new ConversationsApiError("Empty response", response.status, null, "EMPTY_RESPONSE");
		}
		const envelope = parsed as Envelope<T>;
		return envelope.data;
	}

	/**
	 * 写操作（PUT/POST）的统一入口。复用与 GET 相同的：
	 *   - token 取自 AdminAuthController；
	 *   - 401 → controller 自动清空 + 锁屏；
	 *   - 错误 envelope 解析（`{ error: { code, message, requestId } }`）；
	 *   - `retryable` 由 `resolveRetryable` 单一计算；
	 *   - 成功 envelope 解析（`{ data: T, requestId }`）。
	 */
	private async requestWithBody<T>(
		path: string,
		init: { readonly method: "PUT" | "POST" | "DELETE"; readonly body: unknown; readonly signal?: AbortSignal },
	): Promise<T> {
		const token = this.auth.getToken();
		if (token === null || token === "") {
			throw new ConversationsApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		}
		const url = `${this.baseUrl}${path}`;
		const response = await this.fetchImpl(url, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				"Idempotency-Key": newIdempotencyKey({ operation: "conversation.write" }),
			},
			body: JSON.stringify(init.body),
			...(init.signal !== undefined ? { signal: init.signal } : {}),
		});
		const text = await response.text();
		const parsed: unknown = text === "" ? null : safeParse(text);
		if (!response.ok) {
			const errInfo = (parsed as ErrorEnvelope | null)?.error ?? null;
			const code = errInfo?.code ?? "HTTP_ERROR";
			const message = errInfo?.message ?? `HTTP ${response.status}`;
			const requestId = errInfo?.requestId ?? null;
			const retryable = resolveRetryable(code, response.status);
			this.auth.handleApiError({
				name: "ConversationsApiError",
				code,
				message,
				requestId: requestId ?? "",
				retryable,
				httpStatus: response.status,
			});
			throw new ConversationsApiError(message, response.status, requestId, code, retryable);
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
		if (input.createdAfter !== undefined && input.createdAfter !== "") params.set("createdAfter", input.createdAfter);
		if (input.createdBefore !== undefined && input.createdBefore !== "")
			params.set("createdBefore", input.createdBefore);
		return this.request<ConversationAdminListResponse>(`/api/control/v1/conversations?${params.toString()}`);
	}

	async downloadExport(conversationId: string, mode: ConversationExportMode, signal?: AbortSignal): Promise<Blob> {
		const token = this.auth.getToken();
		if (token === null || token === "") {
			throw new ConversationsApiError("Admin token is not set", 401, null, "UNAUTHORIZED");
		}
		const params = new URLSearchParams({ mode });
		const response = await this.fetchImpl(
			`${this.baseUrl}/api/control/v1/conversations/${encodeURIComponent(conversationId)}/export?${params.toString()}`,
			{
				headers: { Authorization: `Bearer ${token}`, Accept: "application/jsonl+gzip" },
				...(signal !== undefined ? { signal } : {}),
			},
		);
		if (!response.ok) {
			const parsed = safeParse(await response.text()) as ErrorEnvelope | null;
			const error = parsed?.error;
			const code = error?.code ?? "HTTP_ERROR";
			const message = error?.message ?? `HTTP ${response.status}`;
			const requestId = error?.requestId ?? null;
			// 与 `request()` 同一规则：retryable 仅计算一次，handleApiError 与
			// 抛出的 ConversationsApiError 看到同一个值。
			const retryable = resolveRetryable(code, response.status);
			this.auth.handleApiError({
				name: "ConversationsApiError",
				code,
				message,
				requestId: requestId ?? "",
				retryable,
				httpStatus: response.status,
			});
			throw new ConversationsApiError(message, response.status, requestId, code, retryable);
		}
		return response.blob();
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

	archive(conversationId: string): Promise<{ readonly id: string; readonly status: "archived" }> {
		return this.requestWithBody(`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/archive`, {
			method: "POST",
			body: {},
		});
	}

	delete(conversationId: string): Promise<{ readonly id: string; readonly status: "deleted" }> {
		return this.requestWithBody(`/api/control/v1/conversations/${encodeURIComponent(conversationId)}`, {
			method: "DELETE",
			body: {},
		});
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

	/**
	 * M1: 单会话指标（分页 + 全会话 stats）。
	 * 参数顺序：先 `conversationId`，再 `query`，避免可选字段顺序错位。
	 * 第三个可选参数 `signal` 用于取消过期请求（tab 切换 / 翻页 / 卸载）。
	 */
	getMetrics(
		conversationId: string,
		query: ConversationMetricsQuery,
		signal?: AbortSignal,
	): Promise<ConversationMetricsResponse> {
		const params = new URLSearchParams();
		if (query.afterSequence !== undefined && query.afterSequence > 0) {
			params.set("afterSequence", String(query.afterSequence));
		}
		if (query.limit !== undefined) params.set("limit", String(query.limit));
		const qs = params.toString();
		return this.request<ConversationMetricsResponse>(
			`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/metrics${qs.length > 0 ? `?${qs}` : ""}`,
			signal !== undefined ? { signal } : {},
		);
	}

	/** M1: 单会话最新一帧上下文快照；不存在时返回 `available=false, latest=null`。 */
	getContext(conversationId: string, signal?: AbortSignal): Promise<ConversationContextResponse> {
		return this.request<ConversationContextResponse>(
			`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/context`,
			signal !== undefined ? { signal } : {},
		);
	}

	/**
	 * M1 reasoning：读取单会话级 thinking effort 覆盖。
	 *
	 * 返回 `ConversationReasoningState`：含 `effort`（`null` = 使用 Agent Revision
	 * 默认值）与审计 `updatedAt`（ISO）。404 = 跨租户（`CONVERSATION_NOT_FOUND`，
	 * 不暴露归属）。
	 *
	 * 不复制 DTO——直接 import `ConversationReasoningState` / `ReasoningUpdateRequest`
	 * 给上层组件。
	 *
	 * 请求受 **30 秒超时** 守护；超时（与 caller signal 来自 stale guard
	 * 的取消正交）以 `ConversationsApiError.code = "REQUEST_TIMEOUT"` 抛出，
	 * `retryable=true`，由 UI 引导用户手动重试。
	 */
	getReasoning(conversationId: string, signal?: AbortSignal): Promise<ConversationReasoningState> {
		return this.withReasoningTimeout(signal, (combined) =>
			this.request<ConversationReasoningState>(
				`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/reasoning`,
				{ signal: combined },
			),
		);
	}

	/**
	 * M1 reasoning：设置单会话级 thinking effort 覆盖（PUT 幂等）。
	 *
	 * 请求体即 `ReasoningUpdateRequest`：传 `null` 清除会话覆盖，回到 Agent
	 * Revision 默认。422 `REASONING_INVALID_EFFORT` 表示档位不在模型能力目录
	 * 声明的档位内；403 `REASONING_NOT_CONFIGURABLE` 表示策略禁止调整。
	 * 两者都不可重试，UI 应展示错误码 + 当前 draft，不进入 loading 态。
	 *
	 * 第三个参数 `signal` 用于过期保存保护（tab 切换 / 卸载 / 重新打开表单
	 * 时取消旧保存，避免旧请求覆盖新会话状态）；与 30s 超时并联工作（任一
	 * 触发即取消），超时时映射为 `REQUEST_TIMEOUT`。
	 */
	putReasoning(
		conversationId: string,
		body: ReasoningUpdateRequest,
		signal?: AbortSignal,
	): Promise<ConversationReasoningState> {
		return this.withReasoningTimeout(signal, (combined) =>
			this.requestWithBody<ConversationReasoningState>(
				`/api/control/v1/conversations/${encodeURIComponent(conversationId)}/reasoning`,
				{ method: "PUT", body, signal: combined },
			),
		);
	}

	/**
	 * reasoning 端点的 30 秒超时；与 caller 的 `signal`（来自 `createStaleResponseGuard`）
	 * **并联** 组合——任一触发即取消 fetch。
	 *
	 * 取消语义区分：
	 * - **stale guard / 切换会话 / 卸载** → 抛 `DOMException("AbortError")`，
	 *   透传，UI 静默吞掉；
	 * - **30 秒超时** → 抛 `ConversationsApiError{ code: "REQUEST_TIMEOUT",
	 *   retryable: true }`，UI 展示手动重试。
	 *
	 * 不直接以 timeout signal 替换 caller signal：切会话仍是 stale guard
	 * 的语义，超时是另一条独立触发路径；两者通过 `AbortSignal.any` 合并。
	 */
	private async withReasoningTimeout<T>(
		callerSignal: AbortSignal | undefined,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => {
			timeoutController.abort(new DOMException("reasoning request timed out", "TimeoutError"));
		}, ConversationsApi.REASONING_TIMEOUT_MS);
		try {
			const combinedSignal =
				callerSignal !== undefined
					? AbortSignal.any([callerSignal, timeoutController.signal])
					: timeoutController.signal;
			return await fn(combinedSignal);
		} catch (err) {
			// 只把"我们启用的 timeout"翻译成 REQUEST_TIMEOUT；stale guard /
			// 卸载产生的 abort 不归我们所有，原样抛出让调用方静默吞掉。
			if (timeoutController.signal.aborted && err instanceof DOMException && err.name === "AbortError") {
				throw new ConversationsApiError(
					"reasoning 请求超时（30s），请重试",
					408,
					null,
					ConversationsApi.REQUEST_TIMEOUT_CODE,
					true,
				);
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

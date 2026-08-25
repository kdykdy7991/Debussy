/**
 * Embed Chat 控制器（TASK-033）：Web 展示层状态机。
 *
 * 统一持有 Embed 最终用户的会话/消息/发送/上传/引用/连接状态，React 组件只做
 * 渲染（`useSyncExternalStore` 订阅）。可测试性优先：所有状态迁移都在本模块，
 * 不依赖 DOM；Realtime 传输（TASK-026）与 API（TASK-019）注入。
 *
 * 安全边界（与 server 一致）：
 *  - 消息发送走 Realtime（一次性 Ticket + sequence；TASK-033 切换 dev turn）。
 *  - `message.delta` 是瞬时流式事件（sequence 0）；`message.completed` 才是持久
 *    真相（断线补齐靠它，spec 9.2）。
 *  - `citation.updated` 只做实时展示，不持久化（TASK-032 记录）。
 *  - 附件只在本会话内展示；服务端全 scope 授权，猜 ID 不可探测。
 */
import { type EmbedApi, EmbedApiError } from "./api.ts";
import { messagesFromEvents } from "./conversation-controller.ts";
import { EmbedRealtimeTransport, type WebSocketLike } from "./realtime-transport.ts";
import type { ChatAttachment, ChatMessage, ChatToolCall, Citation, ConversationSummary, EmbedServerEvent } from "./types.ts";

export type EmbedConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface EmbedChatError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface EmbedChatState {
	readonly conversations: readonly ConversationSummary[];
	readonly activeId: string | null;
	readonly messages: readonly ChatMessage[];
	readonly sending: boolean;
	readonly uploading: boolean;
	readonly connectionStatus: EmbedConnectionStatus;
	/** 当前会话本次会话期间上传的附件（展示用；MVP 无附件列表 API，刷新后不恢复）。 */
	readonly attachments: readonly ChatAttachment[];
	/** 来自 bootstrap 的 uploads 能力开关（RuntimeSpec 控制，spec 5.5）。 */
	readonly uploadsEnabled: boolean;
	readonly error: EmbedChatError | null;
	/** WB-008: last rollover notice surfaced to the embed UI. */
	readonly rolloverNotice: EmbedRolloverNotice | null;
}

/** WB-008: lightweight rollover descriptor consumed by the embed banner. */
export interface EmbedRolloverNotice {
	readonly previousConversationId: string | null;
	readonly rolledOverAtSequence: number | null;
	readonly summaryId: string | null;
}

export interface EmbedChatControllerOptions {
	readonly api: EmbedApi;
	/** 返回有效 Access Token；匿名模式可透明刷新（同 visitor 同 Principal）。 */
	readonly getToken: () => Promise<string>;
	/** 认证不可恢复（signed_user 过期，PD-18 无法静默刷新)时回调：宿主需重新 init。 */
	readonly onAuthFailure?: (error: EmbedApiError) => void;
	/** WB-010: 内嵌聊天可把「新会话已建立」上报给宿主（conversation-created）。 */
	readonly onConversationCreated?: (conversationId: string) => void;
	/** 测试注入 WebSocket 工厂（TASK-026）。 */
	readonly wsFactory?: (url: string) => WebSocketLike;
	readonly maxRetries?: number;
	readonly backoffBaseMs?: number;
}

const AUTH_RETRY_CODES = new Set(["TOKEN_EXPIRED", "TOKEN_INVALID"]);

let idCounter = 0;
function nextLocalId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

function newRequestId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	idCounter += 1;
	return `req-${Date.now()}-${idCounter}`;
}

/** SHA-256 hex（webcrypto；node 22 / 现代浏览器全局可用）。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** 引用展示只信任 title/excerpt 等展示字段；结构不合法条目丢弃（防御解码）。 */
function asCitations(value: readonly unknown[]): readonly Citation[] {
	return value.filter((entry) => typeof entry === "object" && entry !== null) as readonly Citation[];
}

export class EmbedChatController {
	private readonly options: EmbedChatControllerOptions;
	private readonly transport: EmbedRealtimeTransport;
	private state: EmbedChatState;
	private readonly listeners = new Set<() => void>();
	/** 主动关闭（宿主 logout / 无会话）时抑制连接失败错误。 */
	private closing = false;
	/** 流式中的 assistant 消息 id（message.delta 未终结）。 */
	private streamingId: string | null = null;
	/** citation.updated 先于 message.delta 到达时的暂存（挂到下一个 assistant 消息）。 */
	private pendingCitations: readonly Citation[] | null = null;
	/** 工具事件可能先于第一段 assistant 文本到达，暂存到本次回复创建时再挂载。 */
	private pendingTools: readonly ChatToolCall[] = [];

	constructor(options: EmbedChatControllerOptions) {
		this.options = options;
		this.state = {
			conversations: [],
			activeId: null,
			messages: [],
			sending: false,
			uploading: false,
			connectionStatus: "idle",
			attachments: [],
			uploadsEnabled: false,
			error: null,
			rolloverNotice: null,
		};
		this.transport = new EmbedRealtimeTransport({
			getTicket: (conversationId) => this.withToken((token) => this.options.api.getWsTicket(token, conversationId)),
			onEvent: (event) => this.handleEvent(event),
			onStatus: (status) => {
				this.setState({
					connectionStatus: status,
					...(status === "closed" && !this.closing
						? { error: { code: "DISCONNECTED", message: "实时连接已断开，请刷新页面重试", retryable: true } }
						: {}),
				});
			},
			wsFactory: options.wsFactory,
			maxRetries: options.maxRetries,
			backoffBaseMs: options.backoffBaseMs,
		});
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getState(): EmbedChatState {
		return this.state;
	}

	/** 初始化：读能力开关 + 会话列表 + 恢复最近会话（PD-02）。 */
	async initialize(features?: { readonly uploads?: boolean }): Promise<void> {
		this.setState({ uploadsEnabled: features?.uploads ?? false, error: null });
		const response = await this.withToken((token) => this.options.api.listConversations(token));
		this.setState({ conversations: response.items });
		if (response.items.length > 0) await this.openConversation(response.items[0]!.id);
	}

	/** 新建会话并打开（服务端固定当前版本）。 */
	async newConversation(): Promise<void> {
		try {
			const created = await this.withToken((token) => this.options.api.createConversation(token));
			this.setState({ conversations: [created.conversation, ...this.state.conversations] });
			await this.openConversation(created.conversation.id);
			this.options.onConversationCreated?.(created.conversation.id);
			// WB-008: surface rollover to the embed UI so the user knows the
			// previous conversation was sealed and this one continues it.
			if (created.rollover.rolledOver) {
				this.setState({
					rolloverNotice: {
						previousConversationId: created.rollover.previousConversationId,
						rolledOverAtSequence: created.rollover.rolledOverAtSequence,
						summaryId: created.rollover.rolloverSummaryId,
					},
				});
			}
		} catch (error) {
			this.handleError(error);
		}
	}

	/** 切换会话：加载消息 + 重连 Realtime（取消旧订阅，TASK-026）。 */
	async openConversation(conversationId: string): Promise<void> {
		if (conversationId === this.state.activeId) return;
		try {
			const detail = await this.withToken((token) => this.options.api.getConversation(token, conversationId));
			const messages = messagesFromEvents(detail.events).map((message) => ({
				...message,
				id: `evt-${message.sequence}`,
			}));
			this.streamingId = null;
			this.pendingCitations = null;
			this.pendingTools = [];
			this.closing = false;
			this.setState({
				activeId: conversationId,
				messages,
				attachments: [],
				sending: false,
				error: null,
			});
			this.transport.connect(conversationId, detail.conversation.lastEventSequence);
		} catch (error) {
			this.handleError(error);
		}
	}

	/**
	 * 发送文本：本地回显 user 消息 -> Realtime `turn.start`（单次发送，重连
	 * 绝不重发，TASK-026 禁止条件）；`message.completed` 到达后终结流式回复。
	 */
	send(text: string): void {
		const trimmed = text.trim();
		const conversationId = this.state.activeId;
		if (trimmed === "" || conversationId === null || this.state.sending) return;
		if (this.state.connectionStatus !== "connected") {
			this.setState({ error: { code: "NOT_CONNECTED", message: "正在连接，请稍候再试", retryable: true } });
			return;
		}
		const echo: ChatMessage = { id: nextLocalId("user"), role: "user", text: trimmed, sequence: -1 };
		this.streamingId = null;
		this.setState({ messages: [...this.state.messages, echo], sending: true, error: null });
		const sent = this.transport.sendTurn(newRequestId(), conversationId, trimmed);
		if (!sent) {
			// ws 恰好关闭：移除本地回显（消息并未发送），提示重试。
			this.setState({
				messages: this.state.messages.filter((message) => message.id !== echo.id),
				sending: false,
				error: { code: "NOT_CONNECTED", message: "连接已断开，请稍后重试", retryable: true },
			});
		}
	}

	/** Stop 只发送取消命令；界面仍保持运行态，直到服务端确认真正中止。 */
	cancel(): void {
		const conversationId = this.state.activeId;
		if (conversationId === null || !this.state.sending) return;
		if (!this.transport.cancelTurn(conversationId)) {
			this.setState({ error: { code: "NOT_CONNECTED", message: "连接已断开，无法停止生成", retryable: true } });
		}
	}

	/** 上传附件（会话固定版本能力 + 服务端全 scope/配额校验）。 */
	async uploadFile(input: {
		readonly filename: string;
		readonly contentType: string;
		readonly data: Uint8Array;
	}): Promise<void> {
		const conversationId = this.state.activeId;
		if (conversationId === null) return;
		if (!this.state.uploadsEnabled) {
			this.setState({ error: { code: "UPLOAD_DISABLED", message: "该应用未启用文件上传", retryable: false } });
			return;
		}
		this.setState({ uploading: true, error: null });
		try {
			const checksum = await sha256Hex(input.data);
			const view = await this.withToken((token) =>
				this.options.api.uploadAttachment(token, conversationId, {
					filename: input.filename,
					contentType: input.contentType,
					checksumSha256: checksum,
					data: input.data,
				}),
			);
			const attachment: ChatAttachment = {
				attachmentId: view.attachmentId,
				filename: view.filename,
				contentType: view.contentType,
				sizeBytes: view.sizeBytes,
				status: view.status,
			};
			this.setState({ attachments: [...this.state.attachments, attachment] });
		} catch (error) {
			this.handleError(error);
		} finally {
			this.setState({ uploading: false });
		}
	}

	/** 删除本人附件（服务端幂等）；UI 附件列表立即移除（展示层）。 */
	async removeAttachment(attachmentId: string): Promise<void> {
		const conversationId = this.state.activeId;
		if (conversationId === null) return;
		try {
			await this.withToken((token) => this.options.api.deleteAttachment(token, conversationId, attachmentId));
		} catch (error) {
			this.handleError(error);
		}
		this.setState({ attachments: this.state.attachments.filter((item) => item.attachmentId !== attachmentId) });
	}

	/** 归档当前会话并切换到下一个可用会话。 */
	async archiveActive(): Promise<void> {
		const conversationId = this.state.activeId;
		if (conversationId === null) return;
		try {
			await this.withToken((token) => this.options.api.archiveConversation(token, conversationId));
		} catch (error) {
			this.handleError(error);
			return;
		}
		const remaining = this.state.conversations.filter((item) => item.id !== conversationId);
		this.setState({ conversations: remaining });
		if (remaining.length > 0) {
			await this.openConversation(remaining[0]!.id);
		} else {
			this.close();
			this.setState({ activeId: null, messages: [], attachments: [], sending: false });
		}
	}

	/** 主动关闭（宿主 logout）：停止重连并清理连接状态。 */
	close(): void {
		this.closing = true;
		this.streamingId = null;
		this.pendingCitations = null;
		this.pendingTools = [];
		this.transport.close();
		this.setState({ connectionStatus: "closed", sending: false });
	}

	/** 认证失败（signed_user 无法刷新）时由调用方重置。 */
	reset(): void {
		this.closing = true;
		this.streamingId = null;
		this.pendingCitations = null;
		this.pendingTools = [];
		this.transport.close();
		this.setState({
			conversations: [],
			activeId: null,
			messages: [],
			sending: false,
			uploading: false,
			connectionStatus: "closed",
			attachments: [],
			error: null,
		});
	}

	private handleEvent(event: EmbedServerEvent): void {
		switch (event.type) {
			case "message.delta": {
				const messages = [...this.state.messages];
				if (this.streamingId === null) {
					this.streamingId = nextLocalId("assistant");
					const streamed: ChatMessage = {
						id: this.streamingId,
						role: "assistant",
						text: event.text,
						sequence: 0,
						streaming: true,
						...(this.pendingCitations !== null ? { citations: this.pendingCitations } : {}),
						...(this.pendingTools.length > 0 ? { tools: this.pendingTools } : {}),
					};
					this.pendingCitations = null;
					this.pendingTools = [];
					messages.push(streamed);
				} else {
					for (let i = 0; i < messages.length; i += 1) {
						const message = messages[i];
						if (message?.id === this.streamingId) messages[i] = { ...message, text: event.text };
					}
				}
				this.setState({ messages });
				break;
			}
			case "message.completed": {
				const finalized = this.streamingId !== null;
				const messages = finalized
					? this.state.messages.map((message) =>
							message.id === this.streamingId
								? { ...message, text: event.text, sequence: event.sequence, streaming: false }
								: message,
						)
					: [
							...this.state.messages,
							{
								id: `evt-${event.sequence}`,
								role: "assistant" as const,
								text: event.text,
								sequence: event.sequence,
							},
						];
				this.streamingId = null;
				this.pendingCitations = null;
				this.pendingTools = [];
				this.setState({ messages, sending: false });
				break;
			}
			case "turn.failed": {
				this.streamingId = null;
				this.pendingCitations = null;
				this.pendingTools = [];
				this.setState({
					messages: [
						...this.state.messages,
						{ id: nextLocalId("system"), role: "system", text: `回复失败：${event.error}`, sequence: 0 },
					],
					sending: false,
				});
				break;
			}
			case "turn.cancelled": {
				this.streamingId = null;
				this.pendingCitations = null;
				this.setState({
					messages: [
						...this.state.messages,
						{ id: nextLocalId("system"), role: "system", text: "已取消", sequence: 0 },
					],
					sending: false,
				});
				break;
			}
			case "citation.updated": {
				const citations = asCitations(event.citations);
				if (this.streamingId !== null) {
					this.setState({
						messages: this.state.messages.map((message) =>
							message.id === this.streamingId ? { ...message, citations } : message,
						),
					});
				} else {
					this.pendingCitations = citations;
				}
				break;
			}
			case "tool.started": {
				this.updateTools(event.eventId, event.tool, "running");
				break;
			}
			case "tool.completed": {
				this.updateTools(event.eventId, event.tool, event.ok ? "completed" : "failed");
				break;
			}
			case "turn.accepted":
				this.setState({ sending: true });
				break;
			default:
				// conversation.snapshot / tool.* / usage.updated / runtime.status：
				// MVP 展示层忽略（传输层已按 sequence 处理）。
				break;
		}
	}

	private updateTools(id: string, name: string, status: ChatToolCall["status"]): void {
		const apply = (tools: readonly ChatToolCall[]): readonly ChatToolCall[] => {
			const existing = tools.findIndex((tool) => tool.id === id || (tool.name === name && tool.status === "running"));
			if (existing < 0) return [...tools, { id, name, status }];
			return tools.map((tool, index) => (index === existing ? { ...tool, id, name, status } : tool));
		};
		if (this.streamingId === null) {
			this.pendingTools = apply(this.pendingTools);
			return;
		}
		this.setState({
			messages: this.state.messages.map((message) =>
				message.id === this.streamingId ? { ...message, tools: apply(message.tools ?? []) } : message,
			),
		});
	}

	/** Token 失效时透明重试一次（匿名可刷新；signed_user 抛 AUTH_EXPIRED 由上层处理）。 */
	private async withToken<T>(action: (token: string) => Promise<T>): Promise<T> {
		try {
			return await action(await this.options.getToken());
		} catch (error) {
			if (error instanceof EmbedApiError && AUTH_RETRY_CODES.has(error.code)) {
				return await action(await this.options.getToken());
			}
			throw error;
		}
	}

	private handleError(error: unknown): void {
		if (error instanceof EmbedApiError) {
			if (error.code === "AUTH_EXPIRED" || error.code === "NOT_SIGNED_IN") {
				this.options.onAuthFailure?.(error);
				this.setState({ sending: false, uploading: false });
				return;
			}
			this.setState({
				error: { code: error.code, message: error.message, retryable: error.retryable },
				sending: false,
				uploading: false,
			});
			return;
		}
		this.setState({
			error: { code: "UNKNOWN", message: "操作失败，请稍后重试", retryable: true },
			sending: false,
			uploading: false,
		});
	}

	private setState(partial: Partial<EmbedChatState>): void {
		this.state = { ...this.state, ...partial };
		for (const listener of this.listeners) listener();
	}
}

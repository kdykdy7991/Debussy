/**
 * Embed Realtime 传输层（TASK-026）。
 *
 * 管理一条 embed Realtime WebSocket 连接：申请一次性 Ticket（HTTP
 * ws-ticket 端点）-> 连接 -> 订阅；断线指数退避重连，重连后带
 * `lastSeenSequence` 同步（服务端从持久事件补齐，spec 9.2）；按 sequence
 * 去重（乱序/重复事件丢弃）；切换 Conversation 时关闭旧连接并取消旧订阅；
 * 重连绝不自动重发用户消息（禁止继续条件——消息只在用户动作时发送一次）。
 *
 * WebSocket 可注入（`wsFactory`），测试用假连接驱动 open/message/close。
 */
import { decodeServerEvent, type EmbedServerEvent } from "@earendil-works/pi-protocol";

export interface RealtimeTicket {
	readonly ticket: string;
	readonly realtimeUrl: string;
}

export interface RealtimeTransportOptions {
	/** 申请一次性 Ticket（HTTP POST ws-ticket）。 */
	getTicket(conversationId: string): Promise<RealtimeTicket>;
	/** 事件回调（已去重、已按序）。 */
	onEvent(event: EmbedServerEvent): void;
	onStatus?: (status: "connecting" | "connected" | "reconnecting" | "closed", attempt: number) => void;
	/** 测试注入的 WebSocket 工厂；缺省用全局 WebSocket。 */
	wsFactory?: (url: string) => WebSocketLike;
	/** 重连尝试上限；默认 5。 */
	maxRetries?: number;
	/** 指数退避基数（ms）；默认 1000。 */
	backoffBaseMs?: number;
}

export interface WebSocketLike {
	send(data: string): void;
	close(): void;
	addEventListener(
		type: "open" | "message" | "close" | "error",
		listener: (event: { readonly data?: unknown }) => void,
	): void;
	removeEventListener(
		type: "open" | "message" | "close" | "error",
		listener: (event: { readonly data?: unknown }) => void,
	): void;
}

type Listener = (event: { readonly data?: unknown }) => void;

export class EmbedRealtimeTransport {
	private readonly options: RealtimeTransportOptions;
	private ws: WebSocketLike | undefined;
	private conversationId: string | null = null;
	private lastSeenSequence = 0;
	private closed = false;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onOpen: Listener;
	private readonly onMessage: Listener;
	private readonly onClose: Listener;

	constructor(options: RealtimeTransportOptions) {
		this.options = options;
		this.onOpen = () => void this.handleOpen();
		this.onMessage = (event) => this.handleMessage(event);
		this.onClose = () => this.handleClose();
	}

	/** 连接（或切换）到指定 Conversation；取消旧订阅。 */
	connect(conversationId: string, lastSeenSequence = 0): void {
		if (this.conversationId === conversationId && this.ws !== undefined) return;
		this.teardown();
		this.conversationId = conversationId;
		this.lastSeenSequence = lastSeenSequence;
		this.attempt = 0;
		this.closed = false;
		void this.openSocket();
	}

	/** 发送用户消息（仅用户动作调用；重连绝不自动重发）。 */
	sendTurn(requestId: string, conversationId: string, text: string): boolean {
		const ws = this.ws;
		if (ws === undefined || this.conversationId !== conversationId) return false;
		const payload = JSON.stringify({
			type: "turn.start",
			requestId,
			conversationId,
			message: { text, attachmentIds: [] },
			lastSeenSequence: this.lastSeenSequence,
		});
		ws.send(payload);
		return true;
	}

	/** 主动关闭：停止重连、关闭连接、清理订阅。 */
	close(): void {
		this.closed = true;
		this.teardown();
		this.options.onStatus?.("closed", this.attempt);
	}

	private async openSocket(): Promise<void> {
		const conversationId = this.conversationId;
		if (conversationId === null || this.closed) return;
		this.options.onStatus?.(this.attempt === 0 ? "connecting" : "reconnecting", this.attempt);
		let ticket: RealtimeTicket;
		try {
			ticket = await this.options.getTicket(conversationId);
		} catch {
			this.scheduleReconnect();
			return;
		}
		if (this.closed || conversationId !== this.conversationId) return;
		const realtimeUrl = new URL(ticket.realtimeUrl);
		realtimeUrl.searchParams.set("ticket", ticket.ticket);
		const ws = (this.options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike))(
			realtimeUrl.toString(),
		);
		this.ws = ws;
		ws.addEventListener("open", this.onOpen);
		ws.addEventListener("message", this.onMessage);
		ws.addEventListener("close", this.onClose);
	}

	private handleOpen(): void {
		this.attempt = 0;
		this.options.onStatus?.("connected", 0);
		if (this.conversationId !== null) {
			// 订阅 + 断线补齐：带 lastSeenSequence 的 sync，服务端从持久事件
			// 补发已完成的消息再进实时流（spec 9.2）。
			this.ws?.send(
				JSON.stringify({
					type: "conversation.sync",
					conversationId: this.conversationId,
					lastSeenSequence: this.lastSeenSequence,
				}),
			);
		}
	}

	private handleMessage(event: { readonly data?: unknown }): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data ?? ""));
		} catch {
			return; // 非 JSON 帧忽略（协议错误由服务端 close）
		}
		const decoded = decodeServerEvent(parsed);
		if (!decoded.ok) return;
		const serverEvent = decoded.value;
		// 只接受本会话事件。
		if (this.conversationId !== null && serverEvent.conversationId !== this.conversationId) return;
		// TASK-033：sequence 0 的事件是瞬时流式事件（turn.accepted / message.delta /
		// citation.updated / turn.failed 等，不可恢复），全部放行且不推进恢复游标；
		// sequence > 0 的是持久事件（message.completed），按 sequence 去重/乱序保护。
		if (serverEvent.sequence > 0) {
			if (serverEvent.sequence <= this.lastSeenSequence) return;
			this.lastSeenSequence = serverEvent.sequence;
		}
		this.options.onEvent(serverEvent);
	}

	private handleClose(): void {
		if (this.ws !== undefined) {
			this.ws.removeEventListener("open", this.onOpen);
			this.ws.removeEventListener("message", this.onMessage);
			this.ws.removeEventListener("close", this.onClose);
			this.ws = undefined;
		}
		if (!this.closed) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer !== undefined) return;
		const maxRetries = this.options.maxRetries ?? 5;
		if (this.attempt >= maxRetries) {
			this.closed = true;
			this.options.onStatus?.("closed", this.attempt);
			return;
		}
		this.attempt += 1;
		const delay = (this.options.backoffBaseMs ?? 1000) * 2 ** (this.attempt - 1);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.openSocket();
		}, delay);
	}

	private teardown(): void {
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.ws !== undefined) {
			this.ws.removeEventListener("open", this.onOpen);
			this.ws.removeEventListener("message", this.onMessage);
			this.ws.removeEventListener("close", this.onClose);
			this.ws.close();
			this.ws = undefined;
		}
	}
}

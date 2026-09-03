/**
 * Embed 同源 Voice Engine WS 传输层（spec：MVP §4.2 / §5.1）。
 *
 * 管理一条浏览器同源 WebSocket：申请一次性 ticket（同源 `POST
 * /api/embed/v1/voice-engine/ws-ticket`）→ 用 `voiceEngineUrl`（相对路径）
 * 拼出当前 origin 的 ws/wss URL → 附加一次性 ticket → 连接。
 *
 * 反代只做透明转发,本 transport 只负责浏览器侧的最小生命周期：
 * connect / send / close,不解析 VoxEMW 业务帧、不做重连、不接麦克风。
 *
 * 任务范围：本 Task 只实现 transport；UI 按钮与 controller 在后续 Task 接入。
 */
import type { VoiceEngineWsTicketResponse } from "./types.ts";

export type VoiceEngineStatus = "disconnected" | "connecting" | "connected" | "closed";

export interface VoiceEngineTransportOptions {
	/** 申请一次性 Voice Engine WS ticket（同源 HTTP POST）。 */
	readonly getTicket: (token: string) => Promise<VoiceEngineWsTicketResponse>;
	/** 状态变化回调（disconnected / connecting / connected / closed）。 */
	readonly onStatus?: (status: VoiceEngineStatus) => void;
	/** VoxEMW JSON text frame callback. Parsing remains in the ASR lifecycle. */
	readonly onMessage?: (data: string) => void;
	/** 测试注入的 WebSocket 工厂；缺省用全局 WebSocket。 */
	readonly wsFactory?: (url: string) => WebSocketLike;
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

/**
 * Embed 同源 Voice Engine WS 传输层。
 *
 * 不做自动重连:用户主动重连由 UI 重新调用 `connect()` 实现。任何一次 close /
 * error 都让 status 进入 `closed`,必须通过再次 `connect()` 才能恢复。
 */
export class VoiceEngineTransport {
	private readonly options: VoiceEngineTransportOptions;
	private ws: WebSocketLike | undefined;
	private status: VoiceEngineStatus = "disconnected";
	private readonly onOpen: Listener;
	private readonly onClose: Listener;
	private readonly onError: Listener;
	private readonly onMessage: Listener;

	constructor(options: VoiceEngineTransportOptions) {
		this.options = options;
		this.onOpen = () => this.setStatus("connected");
		this.onClose = () => this.setStatus("closed");
		this.onError = () => this.setStatus("closed");
		this.onMessage = (event) => {
			if (typeof event.data === "string") this.options.onMessage?.(event.data);
		};
	}

	get currentStatus(): VoiceEngineStatus {
		return this.status;
	}

	/**
	 * 申请 ticket 并建立同源 WS 连接。`token` 是当前 Embed Access Token（用于
	 * 服务端确认调用方已通过 exchange 鉴权）。同一实例只允许持有一条连接;重复
	 * 调用 `connect` 时旧的 ws 会被关闭。
	 */
	async connect(token: string): Promise<void> {
		this.teardown();
		this.setStatus("connecting");
		let ticketInfo: VoiceEngineWsTicketResponse;
		try {
			ticketInfo = await this.options.getTicket(token);
		} catch {
			this.setStatus("closed");
			return;
		}
		// If `close()` was invoked while we awaited the ticket, abandon the
		// upgrade: do not open a socket we will immediately discard.
		if (this.status === "closed") return;
		// voiceEngineUrl 是相对路径（由服务端 ticket 端点返回，例如
		// `/api/voice-engine/v1/ws`），按当前 origin 拼出 ws/wss。
		const url = new URL(ticketInfo.voiceEngineUrl, window.location.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("ticket", ticketInfo.ticket);

		const factory = this.options.wsFactory ?? defaultWebSocketFactory();
		let ws: WebSocketLike;
		try {
			ws = factory(url.toString());
		} catch {
			this.setStatus("closed");
			return;
		}
		this.ws = ws;
		ws.addEventListener("open", this.onOpen);
		ws.addEventListener("close", this.onClose);
		ws.addEventListener("error", this.onError);
		ws.addEventListener("message", this.onMessage);
	}

	/**
	 * 发送一帧文本数据。仅在 `connected` 时成功;其它状态返回 false。
	 * 不做缓冲/重发:这是 raw 透传层,业务协议解析留到 UI Task。
	 */
	send(frame: string): boolean {
		const ws = this.ws;
		if (ws === undefined || this.status !== "connected") return false;
		try {
			ws.send(frame);
		} catch {
			this.setStatus("closed");
			return false;
		}
		return true;
	}

	/** 主动关闭:进入 closed 状态。idempotent。 */
	close(): void {
		if (this.status === "closed" && this.ws === undefined) return;
		this.setStatus("closed");
		this.teardown();
	}

	private setStatus(next: VoiceEngineStatus): void {
		if (this.status === next) return;
		this.status = next;
		this.options.onStatus?.(next);
	}

	private teardown(): void {
		if (this.ws !== undefined) {
			this.ws.removeEventListener("open", this.onOpen);
			this.ws.removeEventListener("close", this.onClose);
			this.ws.removeEventListener("error", this.onError);
			this.ws.removeEventListener("message", this.onMessage);
			try {
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = undefined;
		}
	}
}

function defaultWebSocketFactory(): (url: string) => WebSocketLike {
	return (url) => new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Compose the click-toggle behavior shared by the release-chat composer
 * button (Task 5). Given the current transport status, returns whether
 * the toggle should request `close` (true) or `connect` (false). This is
 * the inverse of "should we open a new connection right now".
 *
 * Pure helper so the UI handler does not need DOM-driven tests to verify
 * the rule: connect when idle/closed, disconnect when busy/live.
 */
export function shouldVoiceEngineToggleConnect(status: VoiceEngineStatus): boolean {
	return status === "disconnected" || status === "closed";
}

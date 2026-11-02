/**
 * Embed postMessage v1 通道（spec 7.2 + 27.5，TASK-029）。
 *
 * iframe 侧实现：监听宿主消息、校验来源、分发。安全不变量：
 *
 * - `event.source` 必须等于宿主窗口（`window.parent`）——伪造窗口丢弃；
 * - `event.origin` 必须属于 App 的 allowlist（来自 bootstrap）——错误 Origin
 *   丢弃，且**不**记入 targetOrigin；
 * - 信封必须通过 `decodeEmbedHostMessage`（protocol/version/type/payload）；
 * - 所有回发使用明确的 `targetOrigin`（最近一次合法宿主消息的 Origin），
 *   禁止 `postMessage("*")`（TASK-029 禁止继续条件）；
 * - bootstrap 未完成时仅暂存一条 init；获取白名单后校验来源并立即清除，
 *   停止通道时也清除；EmbedApp 在 Exchange 后丢弃凭据（PD-18）。
 *
 * Window/Parent 接口化以便 node 环境测试（与 realtime-transport 同风格）。
 */
import {
	decodeEmbedHostMessage,
	type EmbedIframePostMessage,
	encodeEmbedIframeMessage,
} from "@earendil-works/pi-protocol";

export interface MessageEventLike {
	readonly source: unknown;
	readonly origin: string;
	readonly data: unknown;
}

export interface WindowLike {
	addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

export interface ParentWindowLike {
	postMessage(message: unknown, targetOrigin: string): void;
}

export interface EmbedPostMessageChannelOptions {
	/** 当前 iframe 的 window。 */
	readonly window: WindowLike;
	/** `window.parent`（宿主窗口；独立打开时为 null/自身）。 */
	readonly parent: ParentWindowLike;
	/** 宿主 Origin 白名单（来自 bootstrap；公开策略，非凭据）。 */
	readonly allowedOrigins: readonly string[];
	/** Delay dispatch until bootstrap has supplied the origin allowlist. */
	readonly deferUntilAllowedOrigins?: boolean;
	/** 收到合法 `init`；`launchToken` 为 undefined 表示匿名 init。 */
	readonly onInit: (launchToken: string | undefined, hostOrigin: string) => void;
	readonly onTrustedInit?: (exchangeCode: string, hostOrigin: string) => void;
	/** 收到合法 `logout`：宿主登出，iframe 清理凭据并停止访问。 */
	readonly onLogout: () => void;
	/** 收到 `focus`（TASK-033，spec 12.1）：聚焦输入框。 */
	readonly onFocus?: () => void;
	/** 收到 `resize-request`（TASK-033，spec 12.1）：重新上报尺寸。 */
	readonly onResizeRequest?: () => void;
}

/** 校验 `origin` 是否属于 App 的宿主 Origin 白名单（spec 13.1 同源策略）。 */
export function isAllowedHostOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
	return allowedOrigins.includes(origin);
}

export class EmbedPostMessageChannel {
	private readonly window: WindowLike;
	private readonly parent: ParentWindowLike;
	private allowedOrigins: readonly string[];
	private waitingForOrigins: boolean;
	private pendingInit: MessageEventLike | null = null;
	private readonly onInit: (launchToken: string | undefined, hostOrigin: string) => void;
	private readonly onTrustedInit: ((exchangeCode: string, hostOrigin: string) => void) | undefined;
	private readonly onLogout: () => void;
	private readonly onFocus: (() => void) | undefined;
	private readonly onResizeRequest: (() => void) | undefined;
	/** 最近一次合法宿主消息的 Origin；未收到前不向宿主发送任何消息。 */
	private targetOrigin: string | null = null;
	private started = false;

	constructor(options: EmbedPostMessageChannelOptions) {
		this.window = options.window;
		this.parent = options.parent;
		this.allowedOrigins = options.allowedOrigins;
		this.waitingForOrigins = options.deferUntilAllowedOrigins === true;
		this.onInit = options.onInit;
		this.onTrustedInit = options.onTrustedInit;
		this.onLogout = options.onLogout;
		this.onFocus = options.onFocus;
		this.onResizeRequest = options.onResizeRequest;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.window.addEventListener("message", this.handleMessage);
	}

	stop(): void {
		this.pendingInit = null;
		if (!this.started) return;
		this.started = false;
		this.window.removeEventListener("message", this.handleMessage);
	}

	setAllowedOrigins(origins: readonly string[]): void {
		this.allowedOrigins = origins;
		this.waitingForOrigins = false;
		const pending = this.pendingInit;
		this.pendingInit = null;
		if (this.started && pending !== null) this.handleMessage(pending);
	}

	/** 回发 iframe -> host 消息；无合法宿主（独立打开）时静默不发送。 */
	send(message: EmbedIframePostMessage): void {
		if (this.targetOrigin === null) return;
		this.parent.postMessage(encodeEmbedIframeMessage(message), this.targetOrigin);
	}

	private readonly handleMessage = (event: MessageEventLike): void => {
		// 1. 伪造窗口：source 必须等于宿主窗口（window.parent）。
		if (event.source !== this.parent) return;
		if (this.waitingForOrigins) {
			const decoded = decodeEmbedHostMessage(event.data);
			if (decoded.ok && decoded.message.type === "init") this.pendingInit = event;
			else if (decoded.ok && decoded.message.type === "logout") this.pendingInit = null;
			return;
		}
		// 2. 错误 Origin：不记 targetOrigin，不处理。
		if (!isAllowedHostOrigin(event.origin, this.allowedOrigins)) return;
		// 3. 协议/版本/类型/payload 校验。
		const decoded = decodeEmbedHostMessage(event.data);
		if (!decoded.ok) return;
		// 4. 只有通过全部校验的消息才更新 targetOrigin（明确 targetOrigin）。
		this.targetOrigin = event.origin;
		switch (decoded.message.type) {
			case "init":
				if (decoded.message.exchangeCode !== undefined)
					this.onTrustedInit?.(decoded.message.exchangeCode, event.origin);
				else this.onInit(decoded.message.launchToken, event.origin);
				break;
			case "logout":
				this.onLogout();
				break;
			case "focus":
				this.onFocus?.();
				break;
			case "resize-request":
				this.onResizeRequest?.();
				break;
		}
	};
}

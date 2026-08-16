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
 * - Launch Token 只经 `onInit` 回调传递，本通道不保存；EmbedApp 在 Exchange
 *   后立即丢弃（PD-18）。
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
	/** 收到合法 `init`；`launchToken` 为 undefined 表示匿名 init。 */
	readonly onInit: (launchToken: string | undefined) => void;
	/** 收到合法 `logout`：宿主登出，iframe 清理凭据并停止访问。 */
	readonly onLogout: () => void;
}

/** 校验 `origin` 是否属于 App 的宿主 Origin 白名单（spec 13.1 同源策略）。 */
export function isAllowedHostOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
	return allowedOrigins.includes(origin);
}

export class EmbedPostMessageChannel {
	private readonly window: WindowLike;
	private readonly parent: ParentWindowLike;
	private readonly allowedOrigins: readonly string[];
	private readonly onInit: (launchToken: string | undefined) => void;
	private readonly onLogout: () => void;
	/** 最近一次合法宿主消息的 Origin；未收到前不向宿主发送任何消息。 */
	private targetOrigin: string | null = null;
	private started = false;

	constructor(options: EmbedPostMessageChannelOptions) {
		this.window = options.window;
		this.parent = options.parent;
		this.allowedOrigins = options.allowedOrigins;
		this.onInit = options.onInit;
		this.onLogout = options.onLogout;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.window.addEventListener("message", this.handleMessage);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.window.removeEventListener("message", this.handleMessage);
	}

	/** 回发 iframe -> host 消息；无合法宿主（独立打开）时静默不发送。 */
	send(message: EmbedIframePostMessage): void {
		if (this.targetOrigin === null) return;
		this.parent.postMessage(encodeEmbedIframeMessage(message), this.targetOrigin);
	}

	private readonly handleMessage = (event: MessageEventLike): void => {
		// 1. 伪造窗口：source 必须等于宿主窗口（window.parent）。
		if (event.source !== this.parent) return;
		// 2. 错误 Origin：不记 targetOrigin，不处理。
		if (!isAllowedHostOrigin(event.origin, this.allowedOrigins)) return;
		// 3. 协议/版本/类型/payload 校验。
		const decoded = decodeEmbedHostMessage(event.data);
		if (!decoded.ok) return;
		// 4. 只有通过全部校验的消息才更新 targetOrigin（明确 targetOrigin）。
		this.targetOrigin = event.origin;
		switch (decoded.message.type) {
			case "init":
				this.onInit(decoded.message.launchToken);
				break;
			case "logout":
				this.onLogout();
				break;
		}
	};
}

/**
 * Embed postMessage v1 协议（spec 7.2 + 27.5 + 25.3，TASK-029）。
 *
 * iframe 与宿主页之间的最小消息协议。**身份边界（AD-11）**：Launch Token 只
 * 经此通道进入 iframe，URL 参数或普通 postMessage 字段不构成身份；Token 仅
 * 留在内存，Exchange 后立即丢弃（PD-18）。
 *
 * 信封统一为 `{ protocol: "skdy-embed", version: 1, type, payload }`。
 *
 * - host -> iframe：`init`（signed_user 时携带 `launchToken`；匿名 init 不带）、
 *   `logout`（宿主登出，iframe 清理凭据并停止访问，WP-07 验收）。
 * - iframe -> host：`ready`、`error`、`resize`。
 *
 * 双方都必须校验 `event.source`（必须等于对端窗口）、`event.origin`（必须属于
 * App allowlist）和协议版本；发送必须使用明确的 `targetOrigin`，禁止
 * `postMessage("*")`（TASK-029 禁止继续条件）。错误消息绝不回显
 * launchToken / externalUserId。
 */
import { EMBED_PROTOCOL_NAME, EMBED_PROTOCOL_VERSION } from "./common.ts";

export const POST_MESSAGE_VERSION = EMBED_PROTOCOL_VERSION as 1;
export const POST_MESSAGE_PROTOCOL = EMBED_PROTOCOL_NAME;

/** Launch Token 长度上限（与 Server exchange-http 一致，16 KiB）。 */
export const POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS = 16384;
/** resize 高度上限（像素），防止恶意宿主/iframe 注入任意值。 */
export const POST_MESSAGE_RESIZE_MAX_HEIGHT = 100000;

/** host -> iframe 消息（spec 12.1；TASK-033 补 focus/resize-request）。 */
export type EmbedHostPostMessage =
	| {
			readonly type: "init";
			/** signed_user：宿主后端签发的 Launch Token；匿名 init 省略。 */
			readonly launchToken?: string;
	  }
	| { readonly type: "logout" }
	/** 宿主请求 iframe 聚焦输入框。 */
	| { readonly type: "focus" }
	/** 宿主请求 iframe 重新上报尺寸（iframe 回发 `resize`）。 */
	| { readonly type: "resize-request" };

/** iframe -> host 消息。 */
export type EmbedIframePostMessage =
	| {
			readonly type: "ready";
			readonly publicAppId: string;
			readonly mode: "anonymous" | "signed_user";
	  }
	| { readonly type: "error"; readonly code: string; readonly message: string }
	| { readonly type: "resize"; readonly height: number }
	/** iframe 报告 `publicAppId` 下已新建会话（WB-010 宿主事件）。 */
	| {
			readonly type: "conversation-created";
			readonly publicAppId: string;
			readonly conversationId: string;
	  };

/** 统一信封（双方收发都使用）。 */
export interface EmbedPostMessageEnvelope {
	readonly protocol: typeof POST_MESSAGE_PROTOCOL;
	readonly version: typeof POST_MESSAGE_VERSION;
	readonly type: string;
	readonly payload?: unknown;
}

/** 拒绝原因（稳定、可测试）。 */
export type PostMessageRejectReason =
	| "NOT_OBJECT"
	| "WRONG_PROTOCOL"
	| "WRONG_VERSION"
	| "UNKNOWN_TYPE"
	| "INVALID_PAYLOAD";

export type PostMessageDecodeResult =
	| { readonly ok: true; readonly message: EmbedHostPostMessage }
	| { readonly ok: false; readonly reason: PostMessageRejectReason };

/** iframe 端校验宿主消息；协议/版本/类型/payload 任一不合法即拒绝。 */
export function decodeEmbedHostMessage(raw: unknown): PostMessageDecodeResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reason: "NOT_OBJECT" };
	}
	const envelope = raw as Record<string, unknown>;
	if (envelope.protocol !== POST_MESSAGE_PROTOCOL) return { ok: false, reason: "WRONG_PROTOCOL" };
	if (envelope.version !== POST_MESSAGE_VERSION) return { ok: false, reason: "WRONG_VERSION" };
	const type = envelope.type;
	const payload = envelope.payload;
	if (type === "init") {
		if (payload === undefined || payload === null) {
			return { ok: true, message: { type: "init" } };
		}
		if (typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "INVALID_PAYLOAD" };
		const launchToken = (payload as Record<string, unknown>).launchToken;
		if (launchToken === undefined) return { ok: true, message: { type: "init" } };
		if (
			typeof launchToken !== "string" ||
			launchToken === "" ||
			launchToken.length > POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS
		) {
			return { ok: false, reason: "INVALID_PAYLOAD" };
		}
		return { ok: true, message: { type: "init", launchToken } };
	}
	if (type === "logout") {
		return { ok: true, message: { type: "logout" } };
	}
	if (type === "focus") {
		return { ok: true, message: { type: "focus" } };
	}
	if (type === "resize-request") {
		return { ok: true, message: { type: "resize-request" } };
	}
	return { ok: false, reason: "UNKNOWN_TYPE" };
}

/** iframe -> host 消息信封（发送方构造；发送仍须限定 targetOrigin）。 */
export function encodeEmbedIframeMessage(message: EmbedIframePostMessage): EmbedPostMessageEnvelope {
	const payload =
		message.type === "ready"
			? { publicAppId: message.publicAppId, mode: message.mode }
			: message.type === "error"
				? { code: message.code, message: message.message }
				: message.type === "conversation-created"
					? { publicAppId: message.publicAppId, conversationId: message.conversationId }
					: { height: message.height };
	return {
		protocol: POST_MESSAGE_PROTOCOL,
		version: POST_MESSAGE_VERSION,
		type: message.type,
		payload,
	};
}

/** iframe -> host 校验结果。 */
export type EmbedPayloadDecodeResult =
	| { readonly ok: true; readonly message: EmbedIframePostMessage }
	| { readonly ok: false; readonly reason: PostMessageRejectReason };

/**
 * 宿主端校验 iframe 消息的 `event.data`：协议/版本/类型/payload 任一不合法即
 * 拒绝。宿主仍须在调用前自校验 `event.source == iframe.contentWindow` 与
 * `event.origin` 属于 App allowlist（WB-010 #5）。
 */
export function decodeEmbedIframeMessage(raw: unknown): EmbedPayloadDecodeResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reason: "NOT_OBJECT" };
	}
	const envelope = raw as Record<string, unknown>;
	if (envelope.protocol !== POST_MESSAGE_PROTOCOL) return { ok: false, reason: "WRONG_PROTOCOL" };
	if (envelope.version !== POST_MESSAGE_VERSION) return { ok: false, reason: "WRONG_VERSION" };
	const type = envelope.type;
	const payload = envelope.payload;
	if (type === "ready") {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload))
			return { ok: false, reason: "INVALID_PAYLOAD" };
		const { publicAppId, mode } = payload as Record<string, unknown>;
		if (typeof publicAppId !== "string" || publicAppId === "") return { ok: false, reason: "INVALID_PAYLOAD" };
		if (mode !== "anonymous" && mode !== "signed_user") return { ok: false, reason: "INVALID_PAYLOAD" };
		return { ok: true, message: { type: "ready", publicAppId, mode } };
	}
	if (type === "error") {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload))
			return { ok: false, reason: "INVALID_PAYLOAD" };
		const { code, message } = payload as Record<string, unknown>;
		if (typeof code !== "string" || typeof message !== "string") return { ok: false, reason: "INVALID_PAYLOAD" };
		return { ok: true, message: { type: "error", code, message } };
	}
	if (type === "resize") {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload))
			return { ok: false, reason: "INVALID_PAYLOAD" };
		const { height } = payload as Record<string, unknown>;
		if (
			typeof height !== "number" ||
			!Number.isInteger(height) ||
			height <= 0 ||
			height > POST_MESSAGE_RESIZE_MAX_HEIGHT
		) {
			return { ok: false, reason: "INVALID_PAYLOAD" };
		}
		return { ok: true, message: { type: "resize", height } };
	}
	if (type === "conversation-created") {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload))
			return { ok: false, reason: "INVALID_PAYLOAD" };
		const { publicAppId, conversationId } = payload as Record<string, unknown>;
		if (
			typeof publicAppId !== "string" ||
			publicAppId === "" ||
			typeof conversationId !== "string" ||
			conversationId === ""
		) {
			return { ok: false, reason: "INVALID_PAYLOAD" };
		}
		return { ok: true, message: { type: "conversation-created", publicAppId, conversationId } };
	}
	return { ok: false, reason: "UNKNOWN_TYPE" };
}

/**
 * Embed 协议公共常量与信封（spec 12.2 / 25.3）。
 *
 * `protocol`/`version` 用于 iframe 与宿主页 postMessage（TASK-029）以及
 * Realtime 帧的版本协商；错误信封与 embed HTTP 端点一致（spec 8.3）。
 */

/** postMessage / Realtime 消息的统一协议名。 */
export const EMBED_PROTOCOL_NAME = "skdy-embed" as const;
/** Embed 协议 v1。 */
export const EMBED_PROTOCOL_VERSION = 1 as const;

/** 统一错误信封（spec 8.3）：HTTP 与 Realtime 共用。 */
export interface EmbedErrorEnvelope {
	readonly error: {
		readonly code: string;
		readonly message: string;
		readonly requestId: string;
		readonly retryable: boolean;
	};
}

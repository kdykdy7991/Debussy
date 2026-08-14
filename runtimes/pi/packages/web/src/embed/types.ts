/**
 * Embed Web 端类型（TASK-023）。
 *
 * Wire 契约类型统一来自协议包（spec 25.3）：`@earendil-works/pi-protocol` 的
 * embed 子模块（common/realtime/public-http），Web 与 Server 不各自复制。
 * 仅保留 Web 展示层专用类型（ChatMessage）。
 */
export type {
	BootstrapResponse,
	ClientCommand,
	ConversationDetailResponse,
	ConversationEvent,
	ConversationListResponse,
	ConversationSummary,
	DevTurnResponse,
	EMBED_PROTOCOL_NAME,
	EMBED_PROTOCOL_VERSION,
	EmbedErrorEnvelope,
	EmbedServerEvent,
	ExchangeRequest,
	ExchangeResponse,
	RealtimeDecodeError,
	RealtimeDecodeResult,
	RecoverableEventBase,
} from "@earendil-works/pi-protocol";

/** 会话内展示用消息（由事件推导；Web 展示层专用）。 */
export interface ChatMessage {
	readonly role: "user" | "assistant" | "system";
	readonly text: string;
	readonly sequence: number;
}

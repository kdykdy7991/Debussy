/**
 * Embed Web 端类型（TASK-023/033）。
 *
 * Wire 契约类型统一来自协议包（spec 25.3）：`@earendil-works/pi-protocol` 的
 * embed 子模块（common/realtime/public-http），Web 与 Server 不各自复制。
 * 仅保留 Web 展示层专用类型（ChatMessage/ChatAttachment）。
 */
import type { Citation } from "@earendil-works/pi-protocol";

export type { Citation };

export type {
	BootstrapResponse,
	ClientCommand,
	ConversationDetailResponse,
	ConversationEvent,
	ConversationListResponse,
	ConversationResumeResponse,
	ConversationSummary,
	CreateConversationResponse,
	DeleteAttachmentResponse,
	DevTurnResponse,
	EMBED_PROTOCOL_NAME,
	EMBED_PROTOCOL_VERSION,
	EmbedAttachmentView,
	EmbedErrorEnvelope,
	EmbedServerEvent,
	ExchangeRequest,
	ExchangeResponse,
	RealtimeDecodeError,
	RealtimeDecodeResult,
	RecoverableEventBase,
	WsTicketResponse,
} from "@earendil-works/pi-protocol";

/** 会话内展示用附件（上传响应视图；公开 att_/conv_ id）。 */
export interface ChatAttachment {
	readonly attachmentId: string;
	readonly filename: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly status: string;
	readonly checksumSha256: string;
	readonly createdAt: string;
}

/** 由 Embed Realtime 的真实 tool 事件驱动；不从 UI 侧虚构调用记录。 */
export interface ChatToolCall {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "failed";
}

/** 会话内展示用消息（由事件推导；Web 展示层专用）。 */
export interface ChatMessage {
	readonly role: "user" | "assistant" | "system";
	readonly text: string;
	/** 模型真实提供的可展示思考内容；缺失时不渲染。 */
	readonly thinking?: string;
	readonly sequence: number;
	/** React key 与流式更新定位；由控制器生成，事件推导消息为 `evt-<sequence>`。 */
	readonly id?: string;
	/** 流式进行中的 assistant 消息（message.delta 未终结）。 */
	readonly streaming?: boolean;
	/** 本 turn 实际使用的引用（citation.updated；仅实时展示，不持久化）。 */
	readonly citations?: readonly Citation[];
	/** 本轮 Realtime 实际收到的工具执行轨迹。 */
	readonly tools?: readonly ChatToolCall[];
}

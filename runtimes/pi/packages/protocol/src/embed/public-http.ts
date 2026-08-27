/**
 * Embed 公开 HTTP 契约类型（spec 8.2 / 27.4 / 27.5，TASK-023）。
 *
 * 由协议包统一持有，Web 与 Server 不再各自复制（spec 25.3）。当前 Server
 * HTTP 层仍使用自身 inline 类型（TASK-015/016 记录的历史偏差），TASK-025
 * Realtime 接线时一并收敛；Web 端已改为从本模块 re-export。
 */

/** `POST /api/embed/v1/exchange`（spec 27.4 / WB-005）：匿名 / signed_user / preview。 */
export type ExchangeRequest =
	| {
			readonly publicAppId: string;
			readonly mode: "anonymous";
			readonly anonymousVisitorId: string;
			readonly hostOrigin: string;
	  }
	| {
			readonly publicAppId: string;
			readonly mode: "signed_user";
			readonly launchToken: string;
			readonly hostOrigin: string;
	  }
	| { readonly publicAppId: string; readonly mode: "preview"; readonly ticket: string };

/** Preview exchange response (WB-005). */
export interface PreviewExchangeResponse extends ExchangeResponse {
	readonly pinnedVersionId: string;
}

export interface ExchangeResponse {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principal: { readonly id: string; readonly type: string };
	readonly app: {
		readonly publicAppId: string;
		readonly name: string;
		readonly currentVersionId: string | null;
		readonly features: {
			readonly uploads: boolean;
			readonly speech: boolean;
			readonly avatar: boolean;
			readonly newConversations?: boolean;
		};
	};
}

/**
 * `GET /api/embed/v1/bootstrap?publicAppId=...`（公开主题摘要）。
 * `accessMode` 决定 iframe 的 init 模式（signed_user 必须等待宿主 init）；
 * `allowedOrigins` 是 postMessage 通道允许的宿主 Origin 白名单（公开策略，
 * 非凭据，spec 13.1）——iframe 只接受来自这些 Origin 的消息并只向其发送。
 */
export interface BootstrapResponse {
	readonly publicAppId: string;
	readonly name: string;
	readonly status: string;
	readonly accessMode: "anonymous" | "signed_user" | "mixed";
	readonly allowedOrigins: readonly string[];
	readonly currentVersionId: string | null;
	readonly features: {
		readonly uploads: boolean;
		readonly speech: boolean;
		readonly avatar: boolean;
		readonly newConversations?: boolean;
	};
	readonly theme: { readonly primaryColor?: string; readonly welcomeMessage?: string };
}

/** Conversation 摘要（spec 27.5 响应形状）。 */
export interface ConversationSummary {
	readonly id: string;
	readonly publishedAppVersionId: string;
	readonly status: string;
	readonly title: string;
	readonly lastEventSequence: number;
	readonly createdAt: string;
}

/**
 * WB-008: response envelope for `POST /api/embed/v1/conversations`. Always
 * returns both the created `conversation` and a `rollover` descriptor so
 * the client never has to infer rollover from error text or guess.
 */
export interface CreateConversationResponse {
	readonly conversation: ConversationSummary;
	readonly rollover: {
		readonly conversationId: string;
		readonly rolledOver: boolean;
		readonly previousConversationId: string | null;
		readonly rolledOverAtSequence: number | null;
		readonly rolloverSummaryId: string | null;
	};
}

export interface ConversationListResponse {
	readonly items: readonly ConversationSummary[];
	readonly nextCursor: string | null;
}

export interface ConversationEvent {
	readonly id: string;
	readonly sequence: number;
	readonly eventType: string;
	readonly turnId: string | null;
	readonly payload: unknown;
	readonly createdAt: string;
}

export interface ConversationDetailResponse {
	readonly conversation: ConversationSummary;
	readonly events: readonly ConversationEvent[];
}

/** `POST /api/embed/v1/dev/conversations/:id/turn`（TASK-018 临时路径）。 */
export interface DevTurnResponse {
	readonly turnId: string;
	readonly userMessageSequence: number;
	readonly assistantSequence: number | null;
	readonly outputText: string;
}

/**
 * `POST /api/embed/v1/conversations/:id/uploads` 响应（TASK-030/033）。
 * `attachmentId`/`conversationId` 为公开表示（`att_<uuid>` / `conv_<uuid>`），
 * 可直接回填到 DELETE/GET 路径；对象存储路径对客户端透明（不回显 objectKey）。
 */
export interface EmbedAttachmentView {
	readonly attachmentId: string;
	readonly conversationId: string;
	readonly status: string;
	readonly filename: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly checksumSha256: string;
	readonly createdAt: string;
}

/** `DELETE /api/embed/v1/conversations/:id/uploads/:attachmentId` 响应（幂等）。 */
export interface DeleteAttachmentResponse {
	readonly attachmentId: string;
	readonly deleted: boolean;
}

/** `POST /api/embed/v1/conversations/:id/ws-ticket` 响应（spec 27.6）。 */
export interface WsTicketResponse {
	readonly ticket: string;
	readonly expiresAt: string;
	readonly realtimeUrl: string;
}

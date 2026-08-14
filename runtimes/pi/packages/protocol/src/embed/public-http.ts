/**
 * Embed 公开 HTTP 契约类型（spec 8.2 / 27.4 / 27.5，TASK-023）。
 *
 * 由协议包统一持有，Web 与 Server 不再各自复制（spec 25.3）。当前 Server
 * HTTP 层仍使用自身 inline 类型（TASK-015/016 记录的历史偏差），TASK-025
 * Realtime 接线时一并收敛；Web 端已改为从本模块 re-export。
 */

/** `POST /api/embed/v1/exchange`（匿名模式，spec 27.4）。 */
export interface ExchangeRequest {
	readonly publicAppId: string;
	readonly mode: "anonymous";
	readonly anonymousVisitorId: string;
}

export interface ExchangeResponse {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principal: { readonly id: string; readonly type: string };
	readonly app: {
		readonly publicAppId: string;
		readonly name: string;
		readonly currentVersionId: string | null;
		readonly features: { readonly uploads: boolean; readonly speech: boolean; readonly avatar: boolean };
	};
}

/** `GET /api/embed/v1/bootstrap?publicAppId=...`（公开主题摘要）。 */
export interface BootstrapResponse {
	readonly publicAppId: string;
	readonly name: string;
	readonly status: string;
	readonly currentVersionId: string | null;
	readonly features: { readonly uploads: boolean; readonly speech: boolean; readonly avatar: boolean };
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

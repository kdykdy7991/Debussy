/**
 * 用户会话列表与详情（WB-002 路由 + WB-006 实施）。
 *
 * - `/conversations`          → 用户会话列表（跨主体、筛选、脱敏）
 * - `/conversations/:convId`  → 会话详情（概览 / 事件日志 / Summary / 续接导航）
 *
 * Spec §5.4 与 WB-006。详情与事件端点会产生 `conversation.read-*` 审计事件。
 */
import type { AdminRoute } from "../router.ts";
import { AdminConversationDetail } from "../user-conversations/conversation-detail.tsx";
import { AdminConversationsIndex } from "../user-conversations/conversations-index.tsx";

export function AdminUserConversationsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "user-conversation-detail") {
		const conversationId = route.params.conversationId;
		if (conversationId === undefined) return <p role="alert">缺少 conversationId</p>;
		return <AdminConversationDetail conversationId={conversationId} />;
	}
	return <AdminConversationsIndex />;
}

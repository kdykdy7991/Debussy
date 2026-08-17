/**
 * 用户会话列表与详情占位（WB-002 / SPEC §5.4）。
 *
 * 任务单范围仅交付 Shell 框架与路由；用户会话管理由 WB-006（依赖
 * WB-007/WB-008）实施。Event Log 与 Summary 契约由 WB-007/WB-008 稳定。
 */
import type { AdminRoute } from "../router.ts";

export function AdminUserConversationsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "user-conversation-detail") {
		return (
			<section>
				<h1>用户会话详情：{route.params.conversationId ?? ""}</h1>
				<div className="admin-shell__placeholder">用户会话详情由 WB-006 实施。</div>
			</section>
		);
	}
	return (
		<section>
			<h1>用户会话</h1>
			<div className="admin-shell__placeholder">用户会话列表由 WB-006 实施。</div>
		</section>
	);
}

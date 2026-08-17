/**
 * 对话页占位（WB-002 / SPEC §5.1）。
 *
 * 任务单范围仅交付 Shell 框架与路由；真实的「管理员调试对话」功能
 * （含 WebSocket、Agent 切换、Tool/Attachment/Citation 等）将在 WB-003
 * 实施。当前显示一个明确的「即将提供」占位，避免被误用为工作能力。
 */
import { useAdminAuth } from "../auth/admin-auth-context.tsx";

export function AdminChatPage(): React.ReactElement {
	const { snapshot } = useAdminAuth();
	return (
		<section>
			<h1>对话（管理员调试）</h1>
			<p style={{ color: "#6b665b" }}>
				当前登录租户：{snapshot.tenant?.name ?? "未关联"}。本模块将作为管理员 调试当前 Agent
				的入口；WebSocket、Agent 选择、DebugSession 恢复与 历史记录由 WB-003 实施。
			</p>
			<output className="admin-shell__placeholder">对话模块即将由 WB-003 提供。</output>
		</section>
	);
}

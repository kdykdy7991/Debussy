/**
 * 右侧抽屉容器（WB-002 / SPEC §4.1）。
 *
 * 抽屉当前为「通用上下文占位」，WB-003 实施时将根据 route 注入 Agent
 * 配置、发布管理或工具调用详情。组件接口稳定，避免后续模块改 Shell。
 */

import { ADMIN_WORKBENCH_TERMS } from "@earendil-works/pi-protocol";
import type { AdminRoute } from "../router.ts";

export interface RightDrawerProps {
	readonly route: AdminRoute;
}

export function AdminRightDrawer({ route }: RightDrawerProps): React.ReactElement {
	const heading: string = (() => {
		switch (route.id) {
			case "chat":
				return `${ADMIN_WORKBENCH_TERMS.conversation} · 上下文`;
			case "agents":
			case "agent-detail":
				return `${ADMIN_WORKBENCH_TERMS.agent} · 配置`;
			case "apps":
			case "app-detail":
				return `${ADMIN_WORKBENCH_TERMS.app} · 发布`;
			case "user-conversations":
			case "user-conversation-detail":
				return `${ADMIN_WORKBENCH_TERMS.userConversations} · 详情`;
			case "settings":
				return "系统设置";
		}
	})();
	return (
		<aside className="admin-shell__right-drawer" aria-label="right drawer">
			<h2 style={{ fontSize: 14, margin: "0 0 12px" }}>{heading}</h2>
			<div className="admin-shell__placeholder">抽屉内容由对应模块填充。</div>
		</aside>
	);
}

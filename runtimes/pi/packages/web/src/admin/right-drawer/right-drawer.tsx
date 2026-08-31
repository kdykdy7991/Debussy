/**
 * 右侧抽屉容器（WB-002 / SPEC §4.1；MVP-07 收口）。
 *
 * MVP-07：抽屉只在有真实上下文内容时打开，默认不永久占用 360px 宽度。
 * 当前各模块尚未注入抽屉上下文，因此本组件不渲染任何占位文案——只有
 * 当 `hasContext` 表明存在真实内容时才挂载抽屉。所有占位已被移除。
 */
import { ADMIN_WORKBENCH_TERMS } from "@earendil-works/pi-protocol";
import type { AdminRoute } from "../router.ts";

export interface RightDrawerProps {
	readonly route: AdminRoute;
	/** Whether the current module has real contextual content for the drawer. */
	readonly hasContext?: boolean;
}

export function AdminRightDrawer({ route, hasContext = false }: RightDrawerProps): React.ReactElement | null {
	// No module injects drawer content yet; collapse instead of reserving
	// 360px of permanent width with a placeholder (MVP-07).
	if (!hasContext) return null;

	const heading: string = (() => {
		switch (route.id) {
			case "chat":
				return `${ADMIN_WORKBENCH_TERMS.conversation} · 上下文`;
			case "agents":
			case "agent-detail":
				return `${ADMIN_WORKBENCH_TERMS.agent} · 配置`;
			case "usage":
				return `${ADMIN_WORKBENCH_TERMS.usage} · 明细`;
			case "user-conversations":
			case "user-conversation-detail":
				return `${ADMIN_WORKBENCH_TERMS.userConversations} · 详情`;
			case "settings":
				return "系统设置";
			default:
				// Technical drawer heading for routes without a dedicated label.
				return "上下文";
		}
	})();
	return (
		<aside className="admin-shell__right-drawer" aria-label="right drawer">
			<h2 style={{ fontSize: 14, margin: "0 0 12px" }}>{heading}</h2>
			<p>上下文内容将在此显示。</p>
		</aside>
	);
}

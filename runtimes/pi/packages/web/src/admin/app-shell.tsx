/**
 * Admin Workbench 主 Shell（WB-002）。
 *
 * - 一级标签栏（5 个固定 tab）
 * - 模块侧栏（次级列表占位）
 * - 主工作区（5 个模块的占位页）
 * - 右侧抽屉容器
 * - 解锁对话框叠加层
 *
 * 锁屏时只显示解锁对话框，背景仍渲染 Shell 框架以便视觉衔接。
 */

import { AdminAuthProvider } from "./auth/admin-auth-context.tsx";
import { AdminUnlockDialog } from "./auth/unlock-dialog.tsx";
import { AdminSecondaryPanel } from "./nav/secondary-panel.tsx";
import { AdminIconRail } from "./nav/sidebar.tsx";
import { AdminAgentsPage } from "./pages/agents-page.tsx";
import { AdminAppsPage } from "./pages/apps-page.tsx";
import { AdminChatPage } from "./pages/chat-page.tsx";
import { AdminSettingsPage } from "./pages/settings-page.tsx";
import { AdminUserConversationsPage } from "./pages/user-conversations-page.tsx";
import { AdminRightDrawer } from "./right-drawer/right-drawer.tsx";
import { useAdminRoute } from "./router.ts";

function MainArea({ route }: { route: ReturnType<typeof useAdminRoute> }): React.ReactElement {
	switch (route.id) {
		case "chat":
			return <AdminChatPage />;
		case "agents":
		case "agent-detail":
			return <AdminAgentsPage route={route} />;
		case "apps":
		case "app-detail":
			return <AdminAppsPage route={route} />;
		case "user-conversations":
		case "user-conversation-detail":
			return <AdminUserConversationsPage route={route} />;
		case "settings":
			return <AdminSettingsPage />;
	}
}

function Shell(): React.ReactElement {
	const route = useAdminRoute();
	return (
		<div className="admin-shell" data-route={route.id}>
			<AdminIconRail route={route} />
			<AdminSecondaryPanel route={route} />
			<main className="admin-shell__main">
				<MainArea route={route} />
			</main>
			<AdminRightDrawer route={route} />
		</div>
	);
}

export function AdminAppShell(): React.ReactElement {
	return (
		<AdminAuthProvider>
			<Shell />
			<AdminUnlockDialog />
		</AdminAuthProvider>
	);
}

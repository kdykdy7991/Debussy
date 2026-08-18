/**
 * Admin Workbench 主 Shell（设计收口 / MVP-15）。
 *
 * 视觉：左侧 240px 单一 Sidebar（构建 / 运营 / 平台三段）+ 主工作区。
 * 不再保留 64px icon-rail 与 secondary-panel 双列。
 * Chat 调试页保留路由（`/`），但当前阶段不进 Sidebar 一级菜单。
 *
 * 锁屏时只显示解锁对话框，背景仍渲染 Shell 框架以便视觉衔接。
 */

import { AdminAuthProvider } from "./auth/admin-auth-context.tsx";
import { AdminUnlockDialog } from "./auth/unlock-dialog.tsx";
import { Sidebar, type SidebarItem, type SidebarSection } from "./components/Sidebar.tsx";
import { AdminAgentsPage } from "./pages/agents-page.tsx";
import { AdminAppsPage } from "./pages/apps-page.tsx";
import { AdminChatPage } from "./pages/chat-page.tsx";
import { AdminSettingsPage } from "./pages/settings-page.tsx";
import { AdminUserConversationsPage } from "./pages/user-conversations-page.tsx";
import { type AdminRoute, type AdminRouteId, useAdminRoute } from "./router.ts";

type CurrentItemId = SidebarItem["id"];

const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
	{
		title: "构建",
		items: [
			{ id: "agents", label: "Agent", path: "/agents", icon: "◇" },
			{ id: "apps", label: "应用", path: "/apps", icon: "▢" },
		],
	},
	{
		title: "运营",
		items: [{ id: "user-conversations", label: "会话", path: "/conversations", icon: "☰" }],
	},
	{
		title: "平台",
		items: [{ id: "settings", label: "设置", path: "/settings", icon: "⚙" }],
	},
];

const CURRENT_FOR_CHAT: CurrentItemId | null = null;

function resolveCurrentItemId(route: AdminRoute): CurrentItemId | null {
	switch (route.id) {
		case "chat":
			return CURRENT_FOR_CHAT;
		case "agents":
		case "agent-detail":
			return "agents";
		case "apps":
		case "app-detail":
			return "apps";
		case "user-conversations":
		case "user-conversation-detail":
			return "user-conversations";
		case "settings":
			return "settings";
		default: {
			const exhaustive: never = route.id;
			return exhaustive;
		}
	}
}

function MainArea({ route }: { route: AdminRoute }): React.ReactElement {
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
		default: {
			const exhaustive: never = route.id;
			return exhaustive as unknown as React.ReactElement;
		}
	}
}

function Shell(): React.ReactElement {
	const route = useAdminRoute();
	return (
		<div className="admin-shell" data-route={route.id}>
			<Sidebar
				sections={SIDEBAR_SECTIONS}
				currentItemId={resolveCurrentItemId(route)}
				tenantName="Acme Corp"
				tenantRole="Admin"
				tenantInitial="A"
			/>
			<main className="admin-shell__main">
				<MainArea route={route} />
			</main>
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

// re-export for downstream consumers that need the route id set
export type { AdminRouteId };

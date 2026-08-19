/**
 * Admin Workbench 主 Shell（v5 = 去掉顶栏，brand 移入左 sidebar）。
 *
 * 视觉对齐 direction-b-aurora：
 *
 *   ┌─ 页面背景（aurora-bg #eef0f2，冷雾灰） ────────────────────────────────┐
 *   │  ┌─ AppSidebar（含 brand） ──┬─ admin-shell__main ──────────────┐  │
 *   │  │  ◇ Acme                   │                                 │  │
 *   │  │  ADMIN WORKBENCH          │   各业务页面                     │  │
 *   │  │  ─────────────            │   （agents / apps / conversations │  │
 *   │  │  Agent                    │    / settings）                  │  │
 *   │  │  应用                      │                                 │  │
 *   │  │  会话                      │                                 │  │
 *   │  │  设置                      │                                 │  │
 *   │  └────────────────────────────┴─────────────────────────────────┘  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * v3：AdminAuthProvider 挂载即自动连接，不再显示解锁对话框（鉴权由
 * vite dev proxy 或生产网关负责注入）。连接失败也只把 controller 推到
 * `error` 态继续渲染 Shell —— 各页面读 snapshot.state 决定是否提示。
 *
 * v4：把 v3 顶栏中心的模块 pill tabs 移到左侧竖排 AppSidebar。
 *
 * v5：删除顶栏 AuroraTopNav，brand（Acme / Admin Workbench）随模块
 * 导航一起沉到左侧 AppSidebar 顶部；整个 shell 现在只有 sidebar +
 * main 两栏水平并排，再无顶部独立一行。
 */

import { AuroraAppSidebar, type AuroraAppSidebarItem } from "./aurora/AppSidebar.tsx";
import { AdminAuthProvider } from "./auth/admin-auth-context.tsx";
import { AdminAgentsPage } from "./pages/agents-page.tsx";
import { AdminAppsPage } from "./pages/apps-page.tsx";
import { AdminChatPage } from "./pages/chat-page.tsx";
import { AdminSettingsPage } from "./pages/settings-page.tsx";
import { AdminUserConversationsPage } from "./pages/user-conversations-page.tsx";
import { type AdminRoute, type AdminRouteId, useAdminRoute } from "./router.ts";

type NavItemId = AuroraAppSidebarItem["id"];

const SIDEBAR_ITEMS: readonly AuroraAppSidebarItem[] = [
	{ id: "agents", label: "Agent", path: "/agents", icon: "◇" },
	{ id: "apps", label: "应用", path: "/apps", icon: "▤" },
	{ id: "user-conversations", label: "会话", path: "/conversations", icon: "◫" },
	{ id: "settings", label: "设置", path: "/settings", icon: "⚙" },
];

function resolveNavItemId(route: AdminRoute): NavItemId | null {
	switch (route.id) {
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
		case "chat":
			return null;
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
			<AuroraAppSidebar
				items={SIDEBAR_ITEMS}
				currentItemId={resolveNavItemId(route)}
				brandName="Acme"
				brandSubtitle="Admin Workbench"
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
		</AdminAuthProvider>
	);
}

// re-export for downstream consumers that need the route id set
export type { AdminRouteId };

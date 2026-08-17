/**
 * 一级标签图标栏（WB-002 / SPEC §4.1）。
 *
 * 严格固定为「对话 / Agent / 应用 / 用户会话 / 设置」五个标签：
 * 任务单要求术语来自 `ADMIN_WORKBENCH_TERMS`，`aria-current` 标识当前态。
 */
import { ADMIN_WORKBENCH_TERMS } from "@earendil-works/pi-protocol";
import type { AdminRoute } from "../router.ts";
import { navigate } from "../router.ts";

interface IconNavItem {
	readonly id: Exclude<AdminRoute["id"], "agent-detail" | "app-detail" | "user-conversation-detail">;
	readonly label: string;
	readonly path: string;
	readonly glyph: string;
}

const ICON_ITEMS: readonly IconNavItem[] = [
	{ id: "chat", label: ADMIN_WORKBENCH_TERMS.conversation, path: "/", glyph: "C" },
	{ id: "agents", label: ADMIN_WORKBENCH_TERMS.agent, path: "/agents", glyph: "A" },
	{ id: "apps", label: ADMIN_WORKBENCH_TERMS.app, path: "/apps", glyph: "P" },
	{ id: "user-conversations", label: ADMIN_WORKBENCH_TERMS.userConversations, path: "/conversations", glyph: "U" },
	{ id: "settings", label: ADMIN_WORKBENCH_TERMS.settings, path: "/settings", glyph: "S" },
];

function isCurrent(route: AdminRoute, itemId: IconNavItem["id"]): boolean {
	if (route.id === itemId) return true;
	if (itemId === "agents" && route.id === "agent-detail") return true;
	if (itemId === "apps" && route.id === "app-detail") return true;
	if (itemId === "user-conversations" && route.id === "user-conversation-detail") return true;
	return false;
}

export function AdminIconRail({ route }: { route: AdminRoute }): React.ReactElement {
	return (
		<nav className="admin-shell__icon-rail" aria-label="Admin primary navigation">
			{ICON_ITEMS.map((item) => (
				<button
					key={item.id}
					type="button"
					className="admin-shell__icon-button"
					aria-current={isCurrent(route, item.id) ? "true" : undefined}
					aria-label={item.label}
					title={item.label}
					onClick={() => navigate(item.path)}
				>
					<span aria-hidden="true">{item.glyph}</span>
					<span>{item.label}</span>
				</button>
			))}
		</nav>
	);
}

/**
 * 模块侧栏（WB-002 / SPEC §4.1；MVP-07 收口）。
 *
 * MVP-07：只显示真实内容，不展示占位文案。
 *
 * - agents 模块：显示真实 Agent 选择器（已解锁时）
 * - apps 模块：显示应用列表跳转
 * - chat / user-conversations / settings：次级栏无真实列表内容，折叠
 *   （保留标题，不渲染占位段落）
 */

import { ADMIN_WORKBENCH_TERMS } from "@earendil-works/pi-protocol";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import type { AdminRoute } from "../router.ts";
import { navigate } from "../router.ts";
import { AgentSelector, useSelectedAgentId } from "./agent-selector.tsx";

export function AdminSecondaryPanel({ route }: { route: AdminRoute }): React.ReactElement {
	const { controller, snapshot } = useAdminAuth();
	const selectedAgentId = useSelectedAgentId();
	const heading: string = (() => {
		switch (route.id) {
			case "chat":
				return ADMIN_WORKBENCH_TERMS.conversation;
			case "agents":
			case "agent-detail":
				return ADMIN_WORKBENCH_TERMS.agent;
			case "apps":
			case "app-detail":
				return ADMIN_WORKBENCH_TERMS.app;
			case "user-conversations":
			case "user-conversation-detail":
				return ADMIN_WORKBENCH_TERMS.userConversations;
			case "settings":
				return ADMIN_WORKBENCH_TERMS.settings;
		}
	})();

	return (
		<aside className="admin-shell__secondary-panel" aria-label={`${heading} secondary`}>
			<h2>{heading}</h2>
			{/* Agents: real selector when unlocked; collapse (no placeholder text) otherwise. */}
			{route.id === "agents" || route.id === "agent-detail" ? (
				<div style={{ padding: "0 16px 12px" }}>
					{snapshot.state === "connected" && <AgentSelector auth={controller} selectedAgentId={selectedAgentId} />}
				</div>
			) : null}
			{route.id === "apps" || route.id === "app-detail" ? (
				<nav className="secondary-list">
					<ul>
						<li>
							<button
								type="button"
								aria-current={route.id === "apps" ? "true" : undefined}
								onClick={() => navigate("/apps")}
							>
								应用列表
							</button>
						</li>
					</ul>
				</nav>
			) : null}
		</aside>
	);
}

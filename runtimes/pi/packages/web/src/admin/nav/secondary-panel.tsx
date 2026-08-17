/**
 * 模块侧栏（WB-002 / SPEC §4.1）。
 *
 * 每个模块的次级列表占位：WB-003 / WB-004 / WB-006 实施时填充真实列表。
 */

import { ADMIN_WORKBENCH_TERMS } from "@earendil-works/pi-protocol";
import type { AdminRoute } from "../router.ts";
import { navigate } from "../router.ts";

export function AdminSecondaryPanel({ route }: { route: AdminRoute }): React.ReactElement {
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
			<p style={{ padding: "0 16px", color: "#6b665b", fontSize: 13 }}>
				本模块的列表与筛选将在后续任务（WB-003 / WB-004 / WB-006）填充。
			</p>
			{route.id === "apps" || route.id === "app-detail" ? (
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
			) : null}
			{route.id === "agents" || route.id === "agent-detail" ? (
				<ul>
					<li>
						<button
							type="button"
							aria-current={route.id === "agents" ? "true" : undefined}
							onClick={() => navigate("/agents")}
						>
							Agent 列表
						</button>
					</li>
				</ul>
			) : null}
		</aside>
	);
}

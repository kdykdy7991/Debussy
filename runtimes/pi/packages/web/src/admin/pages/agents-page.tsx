/**
 * Agent 列表与详情入口（WB-003 / SPEC §5.2；MVP-15 设计收口）。
 *
 * - 列表：`AgentListView` 提供 mock-data 预览（设计稿收口用）
 * - 详情：`/agents/agent_<uuid>` 由 `AgentWorkspace` 接管
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { AgentListView } from "../agents/agent-list.tsx";
import { AgentWorkspace } from "../agents/agent-workspace.tsx";
import type { AdminRoute } from "../router.ts";

export function AdminAgentsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "agent-detail") {
		const id = route.params.agentId;
		if (id === undefined) return <p role="alert">缺少 agentId</p>;
		return <AgentWorkspace agentId={id as AgentPublicId} />;
	}
	return <AgentListView />;
}

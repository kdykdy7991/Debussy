/**
 * Agent 列表与详情入口（WB-003 / SPEC §5.2；MVP-15 设计收口；v2 = Aurora）。
 *
 * - 列表：Aurora 视觉版（v2 design direction-b-aurora），原 `agent-list.tsx`
 *   保留为 v1 fallback；当前路由直接走 Aurora 入口
 * - 详情：`/agents/agent_<uuid>` 由 `AgentWorkspace` 接管
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { AgentWorkspace } from "../agents/agent-workspace.tsx";
import { AgentListView } from "../aurora/agent-list-view.tsx";
import type { AdminRoute } from "../router.ts";

export function AdminAgentsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "agent-detail") {
		const id = route.params.agentId;
		if (id === undefined) return <p role="alert">缺少 agentId</p>;
		return <AgentWorkspace agentId={id as AgentPublicId} />;
	}
	return <AgentListView />;
}

/**
 * Agent 列表与详情入口（WB-003 / SPEC §5.2；MVP-15 设计收口；v2 = Aurora）。
 *
 * - 列表：Aurora 视觉版（v2 design direction-b-aurora），仅来自真实 Control API。
 * - 详情（Phase 3）：`/agents/agent_<uuid>` 由 `AgentDesignContent` 接管。
 *   旧的 `agent-workspace.tsx` 不再挂载 —— 它使用的视觉（aurora 方向）已被
 *   Phase 1 / Phase 2 的新白底工作台替代。代码保留在 `admin/agents/` 目录
 *   暂不删除以便回滚；左侧 `AppSidebar`（总览/Agent/Chat/...）完全没动。
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { AgentListView } from "../aurora/agent-list-view.tsx";
import { AgentDesignContent } from "../../ui-preview/agent-design.tsx";
import type { AdminRoute } from "../router.ts";

export function AdminAgentsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "agent-detail") {
		const id = route.params.agentId;
		if (id === undefined) return <p role="alert">缺少 agentId</p>;
		return <AgentDesignContent agentId={id as AgentPublicId} />;
	}
	return <AgentListView />;
}

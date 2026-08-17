/**
 * Agent 列表与详情入口（WB-003 / SPEC §5.2）。
 *
 * - 列表：当前租户的 AgentDefinition 列表，每行带 latest revision 与关联应用数
 * - 详情：`/agents/agent_<uuid>` 由 `AgentWorkspace` 接管
 */

import type { AgentDefinitionSummary, AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";
import { AgentWorkspace } from "../agents/agent-workspace.tsx";
import { AgentApi } from "../api/agent-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import type { AdminRoute } from "../router.ts";
import { navigate } from "../router.ts";

interface AgentListItem {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly revision: number;
	readonly createdAt: string;
}

function fromSummary(items: readonly AgentDefinitionSummary[]): readonly AgentListItem[] {
	return items.map((row) => ({
		id: row.id as AgentPublicId,
		name: row.name,
		revision: row.revision,
		createdAt: row.createdAt,
	}));
}

export function AdminAgentsPage({ route }: { route: AdminRoute }): React.ReactElement {
	const { controller } = useAdminAuth();
	if (route.id === "agent-detail") {
		const id = route.params.agentId;
		if (id === undefined) return <p role="alert">缺少 agentId</p>;
		return <AgentWorkspace agentId={id as AgentPublicId} />;
	}
	return <AgentListView api={new AgentApi({ auth: controller })} />;
}

function AgentListView({ api }: { api: AgentApi }): React.ReactElement {
	const [state, setState] = useState<
		{ kind: "loading" } | { kind: "loaded"; items: readonly AgentListItem[] } | { kind: "error"; message: string }
	>({ kind: "loading" });
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res = (await api.listAgents({ limit: 50 })) as { items: readonly AgentDefinitionSummary[] };
				if (!cancelled) setState({ kind: "loaded", items: fromSummary(res.items) });
			} catch (err) {
				if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [api]);
	if (state.kind === "loading") return <output>正在加载 Agent 列表…</output>;
	if (state.kind === "error")
		return (
			<output role="alert">
				<p>加载失败：{state.message}</p>
			</output>
		);
	if (state.items.length === 0) return <p>暂无 Agent。请先在控制台导入或创建 Agent。</p>;
	return (
		<section>
			<h1>Agent 列表</h1>
			<table>
				<thead>
					<tr>
						<th>名称</th>
						<th>Latest Revision</th>
						<th>创建时间</th>
					</tr>
				</thead>
				<tbody>
					{state.items.map((item) => (
						<tr key={item.id}>
							<td>
								<button
									type="button"
									onClick={() => navigate(`/agents/${item.id}`)}
									aria-label={`打开 Agent ${item.name}`}
								>
									{item.name}
								</button>
							</td>
							<td>#{item.revision}</td>
							<td>{item.createdAt}</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

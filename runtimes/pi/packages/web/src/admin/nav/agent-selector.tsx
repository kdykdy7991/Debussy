/**
 * Agent 选择器（MVP-05 / SPEC §5.2 / §5.3）。
 *
 * 渲染在 agent 模块次级栏顶部：从 Control API 拉取该租户的 Agent 列表，
 * 供管理员在 agent 间快速切换。覆盖 loading / empty / error / retry。
 *
 * 选择某个 Agent 后跳转到其详情页。光标分页未在此处展开（列表页已有
 * cursor 分页覆盖大量数据场景）；此选择器只加载第一页，足够“换 agent”
 * 的导航用途。
 */
import type { AgentDefinitionSummary, AgentPublicId } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { AgentApi } from "../api/agent-api.ts";
import { navigate, useAdminRoute } from "../router.ts";

interface AgentSelectorProps {
	readonly auth: AdminAuthController;
	/** Currently selected agent id, if on an agent-detail route. */
	readonly selectedAgentId: AgentPublicId | null;
}

type State =
	| { kind: "loading" }
	| { kind: "loaded"; items: readonly AgentDefinitionSummary[] }
	| { kind: "error"; message: string };

export function AgentSelector({ auth, selectedAgentId }: AgentSelectorProps): React.ReactElement {
	const apiRef = useRef<AgentApi | null>(null);
	if (apiRef.current === null) apiRef.current = new AgentApi({ auth });
	const api = apiRef.current;
	const [state, setState] = useState<State>({ kind: "loading" });

	const reload = useCallback(() => {
		setState({ kind: "loading" });
		void (async () => {
			try {
				const res = (await api.listAgents({ limit: 50 })) as {
					items: readonly AgentDefinitionSummary[];
				};
				setState({ kind: "loaded", items: res.items });
			} catch (err) {
				setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			}
		})();
	}, [api]);

	useEffect(() => {
		reload();
	}, [reload]);

	return (
		<div className="agent-selector">
			<label htmlFor="agent-selector-select">切换 Agent</label>
			{state.kind === "loading" ? (
				<output>加载 Agent…</output>
			) : state.kind === "error" ? (
				<div role="alert" className="agent-selector__error">
					<span>{state.message}</span>
					<button type="button" onClick={reload}>
						重试
					</button>
				</div>
			) : state.items.length === 0 ? (
				<p>暂无 Agent</p>
			) : (
				<select
					id="agent-selector-select"
					aria-label="选择 Agent"
					value={selectedAgentId ?? ""}
					onChange={(e) => {
						const id = e.target.value;
						if (id !== "") void navigate(`/agents/${id}`);
					}}
				>
					<option value="" disabled>
						选择一个 Agent…
					</option>
					{state.items.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}（#{agent.revision}）
						</option>
					))}
				</select>
			)}
		</div>
	);
}

/** Convenience hook that returns the current route's agent id when present. */
export function useSelectedAgentId(): AgentPublicId | null {
	const route = useAdminRoute();
	if (route.id === "agent-detail") {
		const id = route.params.agentId;
		return (id as AgentPublicId) ?? null;
	}
	return null;
}

/**
 * Agent Revision Tab（阶段二 §4.4）。
 *
 * 列表 + 按需详情加载；详见 `revision-list.tsx`。
 * 最新 Revision 已在 `RevisionList` 中突出（行高亮），Source Hash 只
 * 在详情抽屉里展示，避免铺满主表。
 */
import type { AgentDefinitionRevision, AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";
import { AgentApi } from "../api/agent-api.ts";
import { RevisionList } from "./revision-list.tsx";

export interface AgentRevisionTabProps {
	readonly agentId: AgentPublicId;
	readonly api: AgentApi;
}

type LoadState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentDefinitionRevision[] }
	| { readonly kind: "error"; readonly message: string };

export function AgentRevisionTab({ agentId, api }: AgentRevisionTabProps): React.ReactElement {
	const [load, setLoad] = useState<LoadState>({ kind: "loading" });
	useEffect(() => {
		let cancelled = false;
		void api
			.listRevisions(agentId, { limit: 50 })
			.then((res) => {
				if (!cancelled) setLoad({ kind: "loaded", items: res.items });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : String(err);
				setLoad({ kind: "error", message });
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, api]);

	if (load.kind === "loading") return <p aria-busy="true">正在加载 Revision…</p>;
	if (load.kind === "error")
		return (
			<div role="alert">
				<p>加载 Revision 失败：{load.message}</p>
				<button
					type="button"
					onClick={() => {
						setLoad({ kind: "loading" });
					}}
				>
					重试
				</button>
			</div>
		);
	if (load.items.length === 0) return <p>暂无 Revision 记录</p>;
	return <RevisionList items={load.items} agentId={agentId} api={api} />;
}
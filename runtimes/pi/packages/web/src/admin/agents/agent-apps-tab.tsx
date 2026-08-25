/**
 * Agent 发布应用 Tab（阶段三：Aurora UI 统一）。
 *
 * 真实 PublishedApp 列表：名称 / 状态 / 当前激活版本 / Public App ID /
 * 入口。空态提供"前往应用管理"入口；不在此处重复实现应用管理。
 *
 * 视觉与 aurora/apps-list-view 同源 — 复用 `agent-tables.module.css`
 * 的 .appsTable 样式，仅补充 Agent 上下文差异。
 */
import type { AgentDefinitionAssociatedApp, AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";
import { AgentApi } from "../api/agent-api.ts";
import { AppApi } from "../api/app-api.ts";
import { AuroraButton } from "../aurora/index.ts";
import { navigate } from "../router.ts";
import styles from "./agent-tables.module.css";

export interface AgentAppsTabProps {
	readonly agentId: AgentPublicId;
	readonly agentApi: AgentApi;
	readonly appApi: AppApi;
}

type LoadState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentDefinitionAssociatedApp[] }
	| { readonly kind: "error"; readonly message: string };

export function AgentAppsTab({ agentId, agentApi, appApi }: AgentAppsTabProps): React.ReactElement {
	const [load, setLoad] = useState<LoadState>({ kind: "loading" });

	useEffect(() => {
		let cancelled = false;
		void agentApi
			.listAgentApps(agentId)
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
	}, [agentId, agentApi]);

	if (load.kind === "loading") return <p aria-busy="true" className={styles.stateBox}>正在加载关联应用…</p>;
	if (load.kind === "error")
		return (
			<div role="alert" className={styles.errorBox}>
				<p>加载关联应用失败：{load.message}</p>
			</div>
		);
	if (load.items.length === 0)
		return (
			<section className={styles.appsEmpty} aria-label="发布应用">
				<strong>该 Agent 暂未关联任何已发布应用</strong>
				<p>先在「应用」模块创建一个应用并绑定此 Agent，再回来创建版本。</p>
				<AuroraButton variant="default" size="md" onClick={() => navigate("/apps")}>
					前往应用管理
				</AuroraButton>
			</section>
		);
	return (
		<section className={styles.shell} aria-label="发布应用">
			<div className={styles.tableScroll}>
				<table className={styles.appsTable}>
					<thead>
						<tr>
							<th>名称</th>
							<th>状态</th>
							<th>当前激活版本</th>
							<th>Public App ID</th>
							<th aria-label="操作" />
						</tr>
					</thead>
					<tbody>
						{load.items.map((app) => (
							<AppRow key={app.appId} app={app} appApi={appApi} />
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function AppRow({
	app,
	appApi,
}: {
	readonly app: AgentDefinitionAssociatedApp;
	readonly appApi: AppApi;
}): React.ReactElement {
	const [activeVersion, setActiveVersion] = useState<string | null>(null);
	const currentVersionId = app.currentVersionId;
	useEffect(() => {
		if (currentVersionId === null) {
			setActiveVersion(null);
			return;
		}
		// 只在父级需要 active version 字符串时拉一次。失败降级为显示 ID 头几位。
		let cancelled = false;
		void appApi
			.getPublishedApp(app.appId)
			.then((detail) => {
				if (cancelled) return;
				const v = detail.currentVersion?.versionNumber;
				setActiveVersion(typeof v === "number" ? `v${v}` : `${currentVersionId.slice(0, 12)}…`);
			})
			.catch(() => {
				if (cancelled) return;
				setActiveVersion(`${currentVersionId.slice(0, 12)}…`);
			});
		return () => {
			cancelled = true;
		};
	}, [app, appApi, currentVersionId]);
	return (
		<tr>
			<td className={styles.nameCell}>
				<strong>{app.name}</strong>
			</td>
			<td className={styles.statusCell}>
				<code>{app.status}</code>
			</td>
			<td>{activeVersion ?? "（未激活）"}</td>
			<td>
				<code className={styles.publicId}>{app.publicAppId}</code>
			</td>
			<td>
				<AuroraButton variant="ghost" size="sm" onClick={() => navigate(`/apps/${app.appId}`)}>
					进入应用详情 →
				</AuroraButton>
			</td>
		</tr>
	);
}
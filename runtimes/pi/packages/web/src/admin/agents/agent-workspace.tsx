/**
 * Agent Workspace 页面壳（WB-003 / SPEC §5.2；阶段三：Aurora UI 统一）。
 *
 * 视觉布局：
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ AuroraPageHeader: 名称 · 关联应用 · 「继续调试」/「发布」│
 *   ├──────────────────────────────────────────────────────────┤
 *   │ PillTabs: 设计 / Revision / 发布应用 / 最近调试           │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Tab 内容（设计 / Revision / Apps / Debug）                │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ SaveBar（吸底，仅 Design Tab 显示）                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * 阶段三行为：
 *   - 复用 Aurora PageHeader / Aurora Button / AuroraPillTabs；
 *   - Tabs 实现 role=tablist + 键盘 ← → 导航 + 焦点环；
 *   - 离开未保存提示（beforeunload）；切换 Tab 保留草稿；
 *   - 模型目录状态机 loading/loaded/error；失败时不静默回退；
 *   - 页面专属样式收敛到 `agent-workspace.module.css`，
 *     不再追加到 admin/styles.css。
 */
import type {
	AgentDefinitionDetail,
	AgentPublicId,
	LlmAvailableModel,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { AppApi } from "../api/app-api.ts";
import { LlmApi } from "../api/llm-api.ts";
import { PublishDrawer } from "../apps/publish-drawer.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { AuroraButton, AuroraPageHeader, AuroraPillTabs, type AuroraPillTabItem } from "../aurora/index.ts";
import { navigate } from "../router.ts";
import { AgentAppsTab } from "./agent-apps-tab.tsx";
import { AgentDebugTab } from "./agent-debug-tab.tsx";
import { AgentDesignTab } from "./agent-design-tab.tsx";
import { AgentRevisionTab } from "./agent-revision-tab.tsx";
import { AgentSaveBar } from "./agent-save-bar.tsx";
import {
	type AgentState,
	beginSave,
	buildSaveRequest,
	editDraft,
	initialAgentState,
	revertDraft,
	saveFailed,
	saveSucceeded,
} from "./agent-state.ts";
import type { ModelCatalogState } from "./agent-form.tsx";
import styles from "./agent-workspace.module.css";

type Tab = "design" | "revisions" | "apps" | "debug";

const TAB_ITEMS: readonly AuroraPillTabItem<Tab>[] = [
	{ value: "design", label: "设计" },
	{ value: "revisions", label: "Revision" },
	{ value: "apps", label: "发布应用" },
	{ value: "debug", label: "最近调试" },
];

export interface AgentWorkspaceProps {
	readonly agentId: AgentPublicId;
	readonly api?: AgentApi;
	readonly llmApi?: LlmApi;
	readonly appApi?: AppApi;
}

type LoadState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly detail: AgentDefinitionDetail; readonly state: AgentState }
	| { readonly kind: "error"; readonly message: string };

export function AgentWorkspace({ agentId, api, llmApi, appApi }: AgentWorkspaceProps): React.ReactElement {
	const { controller } = useAdminAuth();
	const resolvedApi = useMemo(() => api ?? new AgentApi({ auth: controller }), [api, controller]);
	const resolvedLlmApi = useMemo(
		() => llmApi ?? (api === undefined ? new LlmApi({ auth: controller }) : null),
		[api, controller, llmApi],
	);
	const resolvedAppApi = useMemo(
		() => appApi ?? new AppApi({ auth: controller }),
		[api, appApi, controller],
	);
	const [models, setModels] = useState<ModelCatalogState>({ kind: "loading" });
	const [load, setLoad] = useState<LoadState>({ kind: "loading" });
	const [tab, setTab] = useState<Tab>("design");
	const [changeSummary, setChangeSummary] = useState("");
	const idempotencyRef = useRef<string>("");
	const [publishDrawerMode, setPublishDrawerMode] = useState<"closed" | "open">("closed");

	const reload = useCallback(async () => {
		setLoad({ kind: "loading" });
		try {
			const detail = await resolvedApi.getAgentDetail(agentId);
			setLoad({ kind: "loaded", detail, state: initialAgentState(detail) });
			setChangeSummary("");
		} catch (err) {
			setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
		}
	}, [resolvedApi, agentId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	useEffect(() => {
		if (resolvedLlmApi === null) {
			setModels({ kind: "error", message: "LlmApi 不可用（api prop 注入但未传 llmApi）" });
			return;
		}
		let cancelled = false;
		setModels({ kind: "loading" });
		void resolvedLlmApi
			.listModels()
			.then((result) => {
				if (cancelled) return;
				const items: readonly LlmAvailableModel[] = result.items;
				setModels({ kind: "loaded", items });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : String(err);
				setModels({ kind: "error", message });
			});
		return () => {
			cancelled = true;
		};
	}, [resolvedLlmApi]);

	const onSave = useCallback(
		async (state: AgentState) => {
			if (idempotencyRef.current === "") {
				idempotencyRef.current = `agent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			}
			try {
				const result = await resolvedApi.saveRevision(
					agentId,
					buildSaveRequest(state, changeSummary),
					idempotencyRef.current,
				);
				const detail = await resolvedApi.getAgentDetail(agentId);
				const next = initialAgentState(detail);
				setLoad({ kind: "loaded", detail, state: saveSucceeded(next, next.saved, result.revision) });
				setChangeSummary("");
				idempotencyRef.current = "";
			} catch (err) {
				let message: string;
				if (err instanceof AgentApiError && err.code === "REASONING_INVALID_EFFORT") {
					message = `reasoning 档位被服务端拒绝（REASONING_INVALID_EFFORT）：${err.message}`;
				} else {
					message = err instanceof AgentApiError ? err.message : err instanceof Error ? err.message : String(err);
				}
				setLoad((prev) =>
					prev.kind === "loaded"
						? { kind: "loaded", detail: prev.detail, state: saveFailed(prev.state, message) }
						: prev,
				);
			}
		},
		[agentId, changeSummary, resolvedApi],
	);

	useEffect(() => {
		if (load.kind !== "loaded") return;
		const isUnsaved = load.state.status === "dirty" || load.state.status === "error";
		if (!isUnsaved) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [load]);

	if (load.kind === "loading") {
		return <output className={styles.stateBox}>正在加载 Agent {agentId}…</output>;
	}
	if (load.kind === "error") {
		return (
			<output role="alert" className={styles.stateBox}>
				<p>加载 Agent 失败：{load.message}</p>
				<button type="button" onClick={() => void reload()}>
					重试
				</button>
			</output>
		);
	}
	const { detail, state } = load;
	const isUnsaved = state.status === "dirty" || state.status === "error";
	const isSaving = state.status === "saving";

	const onEdit = (patch: Partial<AgentState["draft"]>) => {
		setLoad((prev) =>
			prev.kind === "loaded" ? { kind: "loaded", detail, state: editDraft(prev.state, patch) } : prev,
		);
	};
	const onRevert = () => {
		setLoad((prev) => (prev.kind === "loaded" ? { kind: "loaded", detail, state: revertDraft(prev.state) } : prev));
	};
	const onStartSave = () => {
		const next = beginSave(state);
		setLoad({ kind: "loaded", detail, state: next });
		void onSave(next);
	};

	return (
		<section
			className={styles.shell}
			aria-label={`Agent ${detail.name}`}
			data-unsaved={isUnsaved}
			data-saving={isSaving}
		>
			<AuroraPageHeader
				title={detail.name}
				meta={
					<div className={styles.headerNote}>
						<span>
							当前 Revision <code>#{state.display.currentRevision}</code>
						</span>
						<span className={styles.headerNoteSep} aria-hidden="true">·</span>
						<span>
							最近更新 <time dateTime={detail.updatedAt}>{detail.updatedAt}</time>
						</span>
						<span className={styles.headerNoteSep} aria-hidden="true">·</span>
						<span>
							关联应用 <strong>{detail.associatedAppCount}</strong>
						</span>
					</div>
				}
				actions={
					<div className={styles.headerActions}>
						<AuroraButton variant="default" size="md" onClick={() => navigate("/chat")}>
							继续调试
						</AuroraButton>
						<AuroraButton
							variant="primary"
							size="md"
							onClick={() => setPublishDrawerMode("open")}
							disabled={state.status !== "saved"}
						>
							{state.status === "saved" ? "发布" : "发布（请先保存草稿）"}
						</AuroraButton>
						{state.status !== "saved" ? (
							<div className={styles.publishBlockNote} role="note">
								当前有未保存的草稿；请先保存为新 Revision，才能创建应用版本（抽屉也会再次校验）。
							</div>
						) : null}
					</div>
				}
			/>

			<AuroraPillTabs<Tab>
				items={TAB_ITEMS}
				value={tab}
				onChange={setTab}
				ariaLabel="Agent Workspace"
			/>

			<div className={styles.body}>
				{tab === "design" ? (
					<AgentDesignTab detail={detail} draft={state.draft} onEdit={onEdit} catalog={models} />
				) : null}
				{tab === "revisions" ? <AgentRevisionTab agentId={agentId} api={resolvedApi} /> : null}
				{tab === "apps" ? (
					<AgentAppsTab agentId={agentId} agentApi={resolvedApi} appApi={resolvedAppApi} />
				) : null}
				{tab === "debug" ? <AgentDebugTab agentId={agentId} /> : null}
			</div>

			{tab === "design" ? (
				<AgentSaveBar
					state={state}
					changeSummary={changeSummary}
					onChangeSummary={setChangeSummary}
					onSave={onStartSave}
					onRevert={onRevert}
				/>
			) : null}

			<PublishDrawer
				agentId={agentId}
				hasDraft={state.status !== "saved"}
				mode={publishDrawerMode}
				onClose={() => setPublishDrawerMode("closed")}
				onPublished={() => {
					setPublishDrawerMode("closed");
					void reload();
				}}
			/>
		</section>
	);
}
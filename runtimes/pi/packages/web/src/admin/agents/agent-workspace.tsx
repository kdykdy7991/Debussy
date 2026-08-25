/**
 * Agent Workspace 页面壳（WB-003 / SPEC §5.2；阶段二：信息架构重构）。
 *
 * 阶段二职责：
 *
 *   - 顶部 header：名称 / 当前 Revision / 更新时间 / 关联应用数 /
 *     「继续调试」与「发布」按钮（草稿态禁用并附说明）。
 *   - 一级 Tab：设计 / Revision / 发布应用 / 最近调试。
 *   - 底部吸底 Save Bar（AgentSaveBar）：覆盖 saved / dirty / saving /
 *     error 四态，含变更摘要、放弃修改与"保存为新 Revision"。
 *   - 离开未保存提示（beforeunload）；切换 Tab 保留内存草稿。
 *   - 模型目录状态机：loading / loaded / error；失败时不静默回退。
 *
 * 设计 Tab 自身的 5 个分区由 `AgentDesignTab` 提供；Revision / 应用 /
 * 调试各 Tab 由对应组件负责。
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

type Tab = "design" | "revisions" | "apps" | "debug";

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

	// 离开未保存提示：仅 dirty / error 状态触发。
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
		return <output>正在加载 Agent {agentId}…</output>;
	}
	if (load.kind === "error") {
		return (
			<output role="alert">
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
			className="agent-workspace"
			aria-label={`Agent ${detail.name}`}
			data-unsaved={isUnsaved}
			data-saving={isSaving}
		>
			<header className="agent-workspace__header">
				<div className="agent-workspace__title">
					<h1>{detail.name}</h1>
					<p className="agent-workspace__meta">
						<span>
							当前 Revision <code>#{state.display.currentRevision}</code>
						</span>
						<span aria-hidden="true">·</span>
						<span>
							最近更新 <time dateTime={detail.updatedAt}>{detail.updatedAt}</time>
						</span>
						<span aria-hidden="true">·</span>
						<span>
							关联应用 <strong>{detail.associatedAppCount}</strong>
						</span>
					</p>
				</div>
				<div className="agent-workspace__actions">
					<button type="button" onClick={() => navigate("/chat")}>
						继续调试
					</button>
					<button
						type="button"
						className="agent-workspace__publish"
						onClick={() => setPublishDrawerMode("open")}
						disabled={state.status !== "saved"}
					>
						{state.status === "saved" ? "发布" : "发布（请先保存草稿）"}
					</button>
				</div>
			</header>

			<nav aria-label="Agent tabs" className="agent-workspace__tabs">
				{(
					[
						["design", "设计"],
						["revisions", "Revision"],
						["apps", "发布应用"],
						["debug", "最近调试"],
					] as const
				).map(([id, label]) => (
					<button
						key={id}
						type="button"
						className="agent-workspace__tab"
						aria-current={tab === id ? "true" : undefined}
						onClick={() => setTab(id)}
					>
						{label}
					</button>
				))}
			</nav>

			<div className="agent-workspace__body">
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
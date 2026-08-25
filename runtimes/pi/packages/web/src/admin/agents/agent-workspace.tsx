/**
 * Agent 详情页主体（WB-003 / SPEC §5.2）。
 *
 * 4 个 tab：
 *
 * 1. 配置：表单 + dirty/saving/saved/error 状态机
 * 2. Revision：历史 revision 列表 + Diff
 * 3. 关联应用：使用此 Agent 的 PublishedApp 列表
 * 4. 最近调试：本浏览器记住的管理员调试入口（阶段一收口）
 */

import type {
	AgentDefinitionAssociatedApp,
	AgentDefinitionDetail,
	AgentDefinitionRevision,
	AgentPublicId,
	LlmAvailableModel,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { LlmApi } from "../api/llm-api.ts";
import { PublishDrawer } from "../apps/publish-drawer.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { createDebugSessionStore } from "../conversation/debug-session-store.ts";
import { navigate } from "../router.ts";
import { AgentForm } from "./agent-form.tsx";
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
import { RevisionList } from "./revision-list.tsx";

type Tab = "config" | "revisions" | "apps" | "debug";

export interface AgentWorkspaceProps {
	readonly agentId: AgentPublicId;
	readonly api?: AgentApi;
	readonly llmApi?: LlmApi;
}

type LoadState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly detail: AgentDefinitionDetail; readonly state: AgentState }
	| { readonly kind: "error"; readonly message: string };

export function AgentWorkspace({ agentId, api, llmApi }: AgentWorkspaceProps): React.ReactElement {
	const { controller } = useAdminAuth();
	const resolvedApi = useMemo(() => api ?? new AgentApi({ auth: controller }), [api, controller]);
	const resolvedLlmApi = useMemo(
		() => llmApi ?? (api === undefined ? new LlmApi({ auth: controller }) : null),
		[api, controller, llmApi],
	);
	const [models, setModels] = useState<readonly LlmAvailableModel[]>([]);
	const [load, setLoad] = useState<LoadState>({ kind: "loading" });
	const [tab, setTab] = useState<Tab>("config");
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
		if (resolvedLlmApi === null) return;
		let cancelled = false;
		void resolvedLlmApi
			.listModels()
			.then((result) => {
				if (!cancelled) setModels(result.items);
			})
			.catch(() => {
				if (!cancelled) setModels([]);
			});
		return () => {
			cancelled = true;
		};
	}, [resolvedLlmApi]);

	useEffect(() => {
		if (load.kind !== "loaded" || window.location.hash !== "#model-parameters") return;
		window.requestAnimationFrame(() =>
			document.getElementById("model-parameters")?.scrollIntoView({ block: "start" }),
		);
	}, [load.kind]);

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
				// After save, reload to fetch the latest snapshot + diff.
				const detail = await resolvedApi.getAgentDetail(agentId);
				const next = initialAgentState(detail);
				setLoad({ kind: "loaded", detail, state: saveSucceeded(next, next.saved, result.revision) });
				setChangeSummary("");
				idempotencyRef.current = "";
			} catch (err) {
				// M1 reasoning：把 `REASONING_INVALID_EFFORT` 错误码单独标在错误信息里，
				// 让用户在保存草稿时能立刻看到是「档位被服务端拒绝」而非通用网络错误。
				// 不复制 DTO：错误码来自协议 `admin-workbench-reasoning.ts` 的
				// `AGENT_V2_REASONING_ERROR_CODES`，此处只是字符串比较。
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
		<section aria-label={`Agent ${detail.name}`}>
			<header>
				<h1>{detail.name}</h1>
				<p>
					最新 revision: {state.display.currentRevision} · 最后更新 {state.display.updatedAt} · 关联应用{" "}
					{detail.associatedAppCount}
				</p>
				<button type="button" onClick={() => setPublishDrawerMode("open")} disabled={state.status !== "saved"}>
					{state.status === "saved" ? "发布" : "发布（请先保存草稿）"}
				</button>
				{state.status !== "saved" ? (
					<p className="agent-publish__blocked" role="note">
						当前有未保存的草稿；请先保存为新 Revision，才能创建应用版本（抽屉也会再次校验）。
					</p>
				) : null}
			</header>
			<nav aria-label="Agent tabs">
				{(
					[
						["config", "配置"],
						["revisions", "Revision"],
						["apps", "关联应用"],
						["debug", "最近调试"],
					] as const
				).map(([id, label]) => (
					<button key={id} type="button" aria-current={tab === id ? "true" : undefined} onClick={() => setTab(id)}>
						{label}
					</button>
				))}
			</nav>
			{tab === "config" ? (
				<ConfigTab
					detail={detail}
					state={state}
					changeSummary={changeSummary}
					onChangeSummary={setChangeSummary}
					onEdit={onEdit}
					onRevert={onRevert}
					onSave={onStartSave}
					models={models}
				/>
			) : null}
			{tab === "revisions" ? <RevisionTab agentId={agentId} api={resolvedApi} /> : null}
			{tab === "apps" ? <AppsTab agentId={agentId} api={resolvedApi} /> : null}
			{tab === "debug" ? <DebugTab agentId={agentId} /> : null}
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

function ConfigTab({
	detail,
	state,
	changeSummary,
	onChangeSummary,
	onEdit,
	onRevert,
	onSave,
	models,
}: {
	readonly detail: AgentDefinitionDetail;
	readonly state: AgentState;
	readonly changeSummary: string;
	readonly onChangeSummary: (s: string) => void;
	readonly onEdit: (patch: Partial<AgentState["draft"]>) => void;
	readonly onRevert: () => void;
	readonly onSave: () => void;
	readonly models: readonly LlmAvailableModel[];
}): React.ReactElement {
	return (
		<div>
			<AgentForm draft={state.draft} onEdit={onEdit} models={models} />
			<div>
				<label htmlFor="agent-change-summary">变更摘要</label>
				<input
					id="agent-change-summary"
					type="text"
					value={changeSummary}
					onChange={(e) => onChangeSummary(e.currentTarget.value)}
					placeholder="简要描述本次修改"
				/>
			</div>
			<StatusBar state={state} />
			<div>
				<button type="button" onClick={onSave} disabled={state.status !== "dirty" && state.status !== "error"}>
					{state.status === "saving" ? "保存中…" : "保存为新 Revision"}
				</button>
				<button type="button" onClick={onRevert} disabled={state.status === "saved" || state.status === "saving"}>
					放弃修改
				</button>
			</div>
			<p>当前 latest revision: {detail.currentRevision}</p>
		</div>
	);
}

function StatusBar({ state }: { state: AgentState }): React.ReactElement | null {
	if (state.status === "saved") return null;
	if (state.status === "dirty") return <output data-status="dirty">有未保存修改</output>;
	if (state.status === "saving") return <output data-status="saving">保存中…</output>;
	return (
		<output role="alert" data-status="error">
			保存失败：{state.errorMessage ?? "未知错误"}
		</output>
	);
}

function RevisionTab({ agentId, api }: { agentId: AgentPublicId; api: AgentApi }): React.ReactElement {
	const [revisions, setRevisions] = useState<readonly AgentDefinitionRevision[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res = await api.listRevisions(agentId, { limit: 50 });
				if (!cancelled) setRevisions(res.items);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [agentId, api]);
	if (error !== null) return <output role="alert">{error}</output>;
	if (revisions === null) return <output>正在加载 Revision…</output>;
	if (revisions.length === 0) return <p>暂无 Revision 记录</p>;
	return <RevisionList items={revisions} agentId={agentId} api={api} />;
}

function AppsTab({ agentId, api }: { agentId: AgentPublicId; api: AgentApi }): React.ReactElement {
	const [apps, setApps] = useState<readonly AgentDefinitionAssociatedApp[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res = await api.listAgentApps(agentId);
				if (!cancelled) setApps(res.items);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [agentId, api]);
	if (error !== null) return <output role="alert">{error}</output>;
	if (apps === null) return <output>正在加载关联应用…</output>;
	if (apps.length === 0) return <p>暂无关联应用</p>;
	return (
		<ul>
			{apps.map((app) => (
				<li key={app.appId}>
					<strong>{app.name}</strong> ({app.status}) · {app.publicAppId}
				</li>
			))}
		</ul>
	);
}

/**
 * "最近调试" Tab（阶段一收口；MVP-05）。
 *
 * 这里**只**展示当前浏览器为该 Agent 记住的最近一次管理员调试入口，
 * 不展示历史日志，也不展示无法指导用户操作的内部 UUID。
 *
 * 设计取舍（M1）：
 *
 * - "继续上次调试"按钮只在有缓存会话时出现；点击跳到 Admin Chat。
 * - 当前 Chat 页路由不接受 `agentId` 形参，无法保证自动选中当前 Agent。
 *   因此按钮文案与说明明确"手动从下拉里选这个 Agent"。
 * - 没有缓存时给出空态：「该 Agent 在本浏览器还没有调试入口」+ 操作指引。
 *
 * 不展示：内部 sessionId UUID、企业用户会话（属于"用户会话"模块）。
 */
function DebugTab({ agentId }: { readonly agentId: AgentPublicId }): React.ReactElement {
	const [sessionId, setSessionId] = useState<string | null>(null);
	useEffect(() => {
		const store = createDebugSessionStore();
		setSessionId(store.get(agentId));
		return () => {
			// ephemeral store instance; no persistent handles to release.
		};
	}, [agentId]);

	const goToChat = () => navigate("/chat");
	const hasSession = sessionId !== null;

	return (
		<section className="debug-records" aria-label="最近调试">
			<header>
				<h3>最近调试</h3>
				<p className="debug-records__hint">
					这里只显示当前浏览器为本 Agent 记住的最近一次管理员调试入口，不是历史日志，也不是用户侧会话。
				</p>
			</header>
			{hasSession ? (
				<div className="debug-records__panel" data-state="has-session">
					<p>你最近在这个浏览器里调试过这个 Agent。</p>
					<p className="debug-records__caveat">
						管理台 Chat 路由暂不接收 agentId 参数，进入后请从 Agent 下拉里手动选择本 Agent。
					</p>
					<button type="button" onClick={goToChat}>
						继续调试（进入管理台 Chat）
					</button>
				</div>
			) : (
				<div className="debug-records__panel" data-state="empty">
					<p>该 Agent 在本浏览器还没有调试入口。</p>
					<p className="debug-records__caveat">
						请到「对话」页手动选择本 Agent 开启一次调试；之后这里会显示返回入口。
					</p>
					<button type="button" onClick={goToChat}>
						打开管理台 Chat
					</button>
				</div>
			)}
		</section>
	);
}

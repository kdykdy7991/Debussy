/**
 * Agent 详情页主体（WB-003 / SPEC §5.2）。
 *
 * 4 个 tab：
 *
 * 1. 配置：表单 + dirty/saving/saved/error 状态机
 * 2. Revision：历史 revision 列表 + Diff
 * 3. 关联应用：使用此 Agent 的 PublishedApp 列表
 * 4. 调试记录：占位（WB-006/WB-007 实施时填充）
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
				const message =
					err instanceof AgentApiError ? err.message : err instanceof Error ? err.message : String(err);
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
					发布
				</button>
			</header>
			<nav aria-label="Agent tabs">
				{(
					[
						["config", "配置"],
						["revisions", "Revision"],
						["apps", "关联应用"],
						["debug", "调试记录"],
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
	return <RevisionList items={revisions} />;
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
 * Debug records tab (MVP-05).
 *
 * Shows the administrator's own DebugSession mapping for this Agent, read
 * from `debug-session-store` (the same per-agent source used by the admin
 * chat page). It deliberately does NOT surface enterprise user sessions —
 * those live under the "用户会话" module, never here.
 *
 * Because the real Pi debug WebSocket round-trip is gated until MVP-08, the
 * tab reflects what the browser actually holds: a `agentId -> sessionId`
 * mapping. When no debug session has been opened for this Agent, it shows an
 * empty state with a link to the debug chat page.
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
	return (
		<div className="debug-records">
			<h3>管理员调试记录</h3>
			{sessionId === null ? (
				<p>该 Agent 还没有管理员调试会话。请到「对话」页为这个 Agent 开启一次调试。</p>
			) : (
				<ul>
					<li>
						<strong>最近 DebugSession</strong> · <code>{sessionId}</code>
					</li>
				</ul>
			)}
		</div>
	);
}

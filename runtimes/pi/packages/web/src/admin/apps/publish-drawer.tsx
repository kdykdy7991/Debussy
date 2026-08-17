/**
 * Publish drawer (WB-004 / SPEC §6.1).
 *
 * Force admin to explicitly select:
 * 1. A target PublishedApp from the agent's associated apps (no default)
 * 2. A saved AgentRevision
 * 3. Shows diff/config summary of the chosen revision
 * 4. Creates an immutable PublishedAppVersion (NOT auto-activating)
 *
 * If the agent has unsaved draft, publish is disabled with "请先保存".
 */
import type { AgentDefinitionAssociatedApp, AgentDefinitionRevision, AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState } from "react";
import { AgentApi } from "../api/agent-api.ts";
import { AppApi, AppApiError } from "../api/app-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";

export type PublishDrawerMode = "closed" | "open";

export interface PublishDrawerProps {
	readonly agentId: AgentPublicId;
	readonly hasDraft: boolean;
	readonly mode: PublishDrawerMode;
	readonly onClose: () => void;
	readonly onPublished: () => void;
}

type Step = "select-app" | "select-revision" | "confirm" | "done" | "error";

export function PublishDrawer({
	agentId,
	hasDraft,
	mode,
	onClose,
	onPublished,
}: PublishDrawerProps): React.ReactElement | null {
	const { controller } = useAdminAuth();
	const agentApi = useRef(new AgentApi({ auth: controller })).current;
	const appApi = useRef(new AppApi({ auth: controller })).current;

	const [apps, setApps] = useState<readonly AgentDefinitionAssociatedApp[]>([]);
	const [appsLoading, setAppsLoading] = useState(false);
	const [selectedApp, setSelectedApp] = useState<string | null>(null);
	const [revisions, setRevisions] = useState<readonly AgentDefinitionRevision[]>([]);
	const [revisionsLoading, setRevisionsLoading] = useState(false);
	const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
	const [revisionDetail, setRevisionDetail] = useState<AgentDefinitionRevision | null>(null);
	const [step, setStep] = useState<Step>("select-app");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// Reset state when opening
	useEffect(() => {
		if (mode === "open") {
			// Allow Escape to close the drawer
			const onKey = (e: KeyboardEvent) => {
				if (e.key === "Escape") onClose();
			};
			document.addEventListener("keydown", onKey);
			return () => document.removeEventListener("keydown", onKey);
		}
	}, [mode, onClose]);

	useEffect(() => {
		if (mode === "open") {
			setStep("select-app");
			setSelectedApp(null);
			setSelectedRevision(null);
			setRevisionDetail(null);
			setError(null);
			setAppsLoading(true);
			let cancelled = false;
			void agentApi.listAgentApps(agentId).then(
				(res) => {
					if (!cancelled) {
						setApps(res.items);
						setAppsLoading(false);
					}
				},
				(err: Error) => {
					if (!cancelled) {
						setError(err.message);
						setAppsLoading(false);
					}
				},
			);
			return () => {
				cancelled = true;
			};
		}
	}, [mode, agentId, agentApi]);

	// Load revisions when app is selected
	useEffect(() => {
		if (selectedApp === null) return;
		setRevisionsLoading(true);
		setSelectedRevision(null);
		setRevisionDetail(null);
		let cancelled = false;
		void agentApi.listRevisions(agentId, { limit: 50 }).then(
			(res) => {
				if (!cancelled) {
					setRevisions(res.items);
					setRevisionsLoading(false);
				}
			},
			(err: Error) => {
				if (!cancelled) {
					setError(err.message);
					setRevisionsLoading(false);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [selectedApp, agentId, agentApi]);

	// Load revision detail when selected
	useEffect(() => {
		if (selectedRevision === null || selectedRevision < 1) {
			setRevisionDetail(null);
			return;
		}
		let cancelled = false;
		void agentApi.getRevision(agentId, selectedRevision).then(
			(detail) => {
				if (!cancelled) setRevisionDetail(detail);
			},
			() => {
				// silently fail, diff is optional
			},
		);
		return () => {
			cancelled = true;
		};
	}, [selectedRevision, agentId, agentApi]);

	const doPublish = async () => {
		if (selectedApp === null || selectedRevision === null) return;
		setBusy(true);
		setError(null);
		try {
			await appApi.createVersion({ appId: selectedApp, sourceAgentRevision: selectedRevision });
			setStep("done");
			onPublished();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
			setStep("error");
		} finally {
			setBusy(false);
		}
	};

	if (mode !== "open") return null;

	return (
		<div
			className="drawer-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="发布"
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div
				className="drawer"
				role="dialog"
				aria-label="发布"
				aria-modal="true"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<h2>发布</h2>
				<p className="drawer-subtitle">Agent: {agentId}</p>

				{hasDraft && <div className="banner warning">Agent 存在未保存的草稿。请先保存后再发布。</div>}

				{error !== null && <div className="banner error">{error}</div>}

				{/* Step 1: Select app */}
				{step === "select-app" && (
					<div className="drawer-step">
						<h3>选择目标应用</h3>
						{appsLoading ? (
							<p>加载应用列表…</p>
						) : apps.length === 0 ? (
							<p>该 Agent 暂无关联应用。请先在应用列表创建应用。</p>
						) : (
							<div className="app-select-list">
								{apps.map((app) => (
									<label key={app.appId} className="app-select-row">
										<input
											type="radio"
											name="target-app"
											checked={selectedApp === app.appId}
											onChange={() => setSelectedApp(app.appId)}
											disabled={hasDraft}
										/>
										<span>
											<strong>{app.name}</strong>
											<small>{app.publicAppId}</small>
											<small>{app.status}</small>
										</span>
									</label>
								))}
							</div>
						)}
						{selectedApp !== null && !hasDraft && (
							<button type="button" onClick={() => setStep("select-revision")}>
								下一步：选择 Revision
							</button>
						)}
					</div>
				)}

				{/* Step 2: Select revision */}
				{step === "select-revision" && (
					<div className="drawer-step">
						<h3>选择 Agent Revision</h3>
						{revisionsLoading ? (
							<p>加载 Revision 列表…</p>
						) : revisions.length === 0 ? (
							<p>暂无已保存的 Revision。</p>
						) : (
							<div className="revision-select-list">
								{revisions.map((rev) => (
									<label key={rev.revision} className="revision-select-row">
										<input
											type="radio"
											name="target-revision"
											checked={selectedRevision === rev.revision}
											onChange={() => setSelectedRevision(rev.revision)}
										/>
										<span>
											<strong>Revision #{rev.revision}</strong>
											<small>{rev.createdAt}</small>
											{cappedDiff(rev.diffFromPrevious)}
										</span>
									</label>
								))}
							</div>
						)}
						<div className="drawer-actions">
							<button type="button" onClick={() => setStep("select-app")}>
								返回
							</button>
							{selectedRevision !== null && (
								<button type="button" onClick={() => setStep("confirm")}>
									下一步：确认
								</button>
							)}
						</div>
					</div>
				)}

				{/* Step 3: Confirm */}
				{step === "confirm" && (
					<div className="drawer-step">
						<h3>确认发布</h3>
						{revisionDetail !== null && (
							<div className="diff-summary">
								<h4>配置摘要</h4>
								<dl>
									<dt>Model</dt>
									<dd>{revisionDetail.configSnapshot?.modelId ?? "—"}</dd>
									<dt>System Prompt</dt>
									<dd>
										<pre>{revisionDetail.configSnapshot?.systemPrompt?.slice(0, 200)}</pre>
									</dd>
									<dt>工具</dt>
									<dd>{revisionDetail.configSnapshot?.toolIds?.join(", ") ?? "—"}</dd>
									<dt>知识库</dt>
									<dd>{revisionDetail.configSnapshot?.knowledgeBaseIds?.join(", ") ?? "—"}</dd>
									<dt>能力</dt>
									<dd>{JSON.stringify(revisionDetail.configSnapshot?.capabilities ?? {})}</dd>
								</dl>
								{revisionDetail.diffFromPrevious && (
									<>
										<h4>变更字段</h4>
										<p>{revisionDetail.diffFromPrevious.changedFields?.join(", ") ?? "无"}</p>
									</>
								)}
							</div>
						)}
						<div className="drawer-actions">
							<button type="button" onClick={() => setStep("select-revision")}>
								返回
							</button>
							<button type="button" className="primary" disabled={busy} onClick={doPublish}>
								{busy ? "发布中…" : "确认发布（不自动激活）"}
							</button>
						</div>
					</div>
				)}

				{/* Step done */}
				{step === "done" && (
					<div className="drawer-step">
						<h3>发布成功</h3>
						<p>版本已创建，尚未激活。请在应用详情中激活版本。</p>
						<div className="drawer-actions">
							<button type="button" onClick={onClose}>
								关闭
							</button>
						</div>
					</div>
				)}

				{/* Error state */}
				{step === "error" && (
					<div className="drawer-step">
						<h3>发布失败</h3>
						<p className="banner error">{error}</p>
						<div className="drawer-actions">
							<button type="button" onClick={() => setStep("confirm")}>
								重试
							</button>
							<button type="button" onClick={onClose}>
								关闭
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function cappedDiff(diff: unknown): React.ReactNode {
	if (diff === null || diff === undefined) return null;
	const d = diff as { changedFields?: readonly string[] };
	if (!d.changedFields || d.changedFields.length === 0) return null;
	return <small>变更: {d.changedFields.join(", ")}</small>;
}

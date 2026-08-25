/**
 * Publish drawer（WB-004 / SPEC §6.1；阶段三：Aurora UI 统一）。
 *
 * 关键语义：
 *
 * - "创建 Published App Version" 与 "激活上线" 是**两个独立动作**。
 *   本抽屉只负责创建版本，**绝不**自动激活。
 * - 创建成功后标题为「应用版本已创建，尚未激活」，并提供
 *   「前往应用详情」/「关闭」两个明确出口。
 * - 配置摘要按字段展示（Model / 思考 / Prompt 摘要 / Avatar / 附件 /
 *   语音 / 工具 / 知识库）；能力字段禁止 `JSON.stringify`，逐项渲染。
 * - 草稿未保存时禁用发布并明示原因。
 *
 * 阶段三：单一 `role="dialog"` + `aria-modal` 语义；焦点进入 / 返回、
 * Escape 关闭、背景 inert；重复提交由 busy 状态保护；视觉走 Aurora
 * Design System（surface + line + shadow-lg）。
 */
import type {
	AgentConfigSnapshot,
	AgentDefinitionAssociatedApp,
	AgentDefinitionRevision,
	AgentPublicId,
	ReasoningEffort,
} from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState } from "react";
import { AgentApi } from "../api/agent-api.ts";
import { AppApi, AppApiError } from "../api/app-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { AuroraButton } from "../aurora/index.ts";
import { navigate } from "../router.ts";
import styles from "./publish-drawer.module.css";

export type PublishDrawerMode = "closed" | "open";

export interface PublishDrawerProps {
	readonly agentId: AgentPublicId;
	readonly hasDraft: boolean;
	readonly mode: PublishDrawerMode;
	readonly onClose: () => void;
	readonly onPublished: () => void;
}

type Step = "select-app" | "select-revision" | "confirm" | "done" | "error";

const PROMPT_SUMMARY_LIMIT = 160;

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
	const [revisionDetailLoading, setRevisionDetailLoading] = useState(false);
	const [revisionDetailError, setRevisionDetailError] = useState<string | null>(null);
	const [createdAppId, setCreatedAppId] = useState<string | null>(null);
	const [step, setStep] = useState<Step>("select-app");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const dialogRef = useRef<HTMLDivElement | null>(null);
	const lastFocusedRef = useRef<HTMLElement | null>(null);

	// 焦点进入 / 返回 + 背景 inert；Escape 关闭 + 焦点陷阱。
	useEffect(() => {
		if (mode !== "open") return;
		lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		// 背景置为 inert（React 18+ 标准）
		const previousInert: Array<{ node: HTMLElement }> = [];
		const overlay = dialogRef.current?.parentElement;
		document.querySelectorAll<HTMLElement>("body > *").forEach((el) => {
			if (el === overlay || (overlay !== undefined && el.contains(overlay))) return;
			if (el.hasAttribute("inert")) return;
			previousInert.push({ node: el });
			el.setAttribute("inert", "");
		});
		// 把焦点送到对话框
		requestAnimationFrame(() => {
			const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
				'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
			);
			(firstFocusable ?? dialogRef.current)?.focus();
		});
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
			// 焦点陷阱：Tab/Shift+Tab 在对话框内循环
			if (e.key === "Tab" && dialogRef.current !== null) {
				const focusables = Array.from(
					dialogRef.current.querySelectorAll<HTMLElement>(
						'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
					),
				);
				if (focusables.length === 0) return;
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				const active = document.activeElement;
				if (e.shiftKey && active === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && active === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			previousInert.forEach(({ node }) => node.removeAttribute("inert"));
			lastFocusedRef.current?.focus();
		};
	}, [mode, onClose]);

	useEffect(() => {
		if (mode === "open") {
			setStep("select-app");
			setSelectedApp(null);
			setSelectedRevision(null);
			setRevisionDetail(null);
			setRevisionDetailError(null);
			setCreatedAppId(null);
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

	useEffect(() => {
		if (selectedApp === null) return;
		setRevisionsLoading(true);
		setSelectedRevision(null);
		setRevisionDetail(null);
		setRevisionDetailError(null);
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

	useEffect(() => {
		if (selectedRevision === null || selectedRevision < 1) {
			setRevisionDetail(null);
			setRevisionDetailError(null);
			setRevisionDetailLoading(false);
			return;
		}
		let cancelled = false;
		setRevisionDetailLoading(true);
		setRevisionDetailError(null);
		void agentApi
			.getRevision(agentId, selectedRevision)
			.then((detail) => {
				if (cancelled) return;
				setRevisionDetail(detail);
				setRevisionDetailLoading(false);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const message =
					err instanceof AppApiError
						? err.message
						: err instanceof Error
							? err.message
							: String(err);
				setRevisionDetailError(message);
				setRevisionDetailLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedRevision, agentId, agentApi]);

	const doCreateVersion = async () => {
		if (selectedApp === null || selectedRevision === null) return;
		if (hasDraft) return;
		setBusy(true);
		setError(null);
		try {
			await appApi.createVersion({ appId: selectedApp, sourceAgentRevision: selectedRevision });
			setCreatedAppId(selectedApp);
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

	const blockedByDraft = hasDraft;

	return (
		<div
			className={styles.overlay}
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				className={styles.drawer}
				role="dialog"
				aria-modal="true"
				aria-label="创建 Published App Version"
				tabIndex={-1}
			>
				<header className={styles.drawerHeader}>
					<h2>创建 Published App Version</h2>
					<p className={styles.drawerSubtitle}>
						<span>Agent：</span>
						<code>{agentId}</code>
						<span className={styles.drawerSubtitle__hint}>
							此操作仅创建不可变版本，**不会**自动激活。激活请到应用详情页。
						</span>
					</p>
				</header>

				{blockedByDraft ? (
					<div className={`${styles.banner} ${styles.warning}`} role="alert">
						Agent 存在未保存的草稿。请先保存为新 Revision，再创建应用版本。
					</div>
				) : null}

				{error !== null ? (
					<div className={`${styles.banner} ${styles.error}`} role="alert">
						{error}
					</div>
				) : null}

				{step === "select-app" ? (
					<div className={styles.drawerStep}>
						<h3>1. 选择目标应用</h3>
						{appsLoading ? (
							<p aria-busy="true">加载应用列表…</p>
						) : apps.length === 0 ? (
							<div className={styles.appsEmpty}>
								<strong>该 Agent 暂无关联应用</strong>
								<p>请先到应用列表创建应用，再回来继续发布。</p>
								<div className={styles.actions}>
									<AuroraButton variant="default" size="md" onClick={() => {
										onClose();
										navigate("/apps");
									}}>
										去创建应用
									</AuroraButton>
								</div>
							</div>
						) : (
							<div className={styles.appSelectList}>
								{apps.map((app) => (
									<label key={app.appId} className={styles.appSelectRow}>
										<input
											type="radio"
											name="target-app"
											checked={selectedApp === app.appId}
											onChange={() => setSelectedApp(app.appId)}
											disabled={blockedByDraft}
										/>
										<span>
											<strong>{app.name}</strong>
											<small>{app.publicAppId}</small>
											<small>状态：{app.status}</small>
										</span>
									</label>
								))}
							</div>
						)}
						{selectedApp !== null && !blockedByDraft ? (
							<div className={styles.drawerActions}>
								<AuroraButton variant="default" size="md" onClick={() => setStep("select-revision")}>
									下一步：选择 Revision
								</AuroraButton>
							</div>
						) : null}
					</div>
				) : null}

				{step === "select-revision" ? (
					<div className={styles.drawerStep}>
						<h3>2. 选择 Agent Revision</h3>
						{revisionsLoading ? (
							<p aria-busy="true">加载 Revision 列表…</p>
						) : revisions.length === 0 ? (
							<p>暂无已保存的 Revision。</p>
						) : (
							<div className={styles.revisionSelectList}>
								{revisions.map((rev) => (
									<label key={rev.revision} className={styles.revisionSelectRow}>
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
						<div className={styles.drawerActions}>
							<AuroraButton variant="default" size="md" onClick={() => setStep("select-app")}>
								返回
							</AuroraButton>
							{selectedRevision !== null ? (
								<AuroraButton variant="default" size="md" onClick={() => setStep("confirm")}>
									下一步：确认
								</AuroraButton>
							) : null}
						</div>
					</div>
				) : null}

				{step === "confirm" ? (
					<div className={styles.drawerStep}>
						<h3>3. 确认创建版本（不激活）</h3>
						{revisionDetailLoading ? (
							<p aria-busy="true">正在加载 Revision #{selectedRevision} 配置快照…</p>
						) : revisionDetailError !== null ? (
							<div role="alert" className={`${styles.banner} ${styles.error}`}>
								<p>加载 Revision 详情失败：{revisionDetailError}</p>
								<p>可返回上一步重新选择。</p>
							</div>
						) : revisionDetail !== null ? (
							<ConfigSummary snapshot={revisionDetail.configSnapshot} />
						) : null}
						<div className={styles.drawerActions}>
							<AuroraButton variant="default" size="md" onClick={() => setStep("select-revision")}>
								返回
							</AuroraButton>
							<AuroraButton
								variant="primary"
								size="md"
								disabled={
									busy || blockedByDraft || revisionDetail === null || revisionDetailLoading === true
								}
								onClick={doCreateVersion}
							>
								{busy ? "创建中…" : "创建版本（不激活）"}
							</AuroraButton>
						</div>
					</div>
				) : null}

				{step === "done" ? (
					<div className={styles.drawerStep} data-step="done">
						<h3>应用版本已创建，尚未激活</h3>
						<p>
							新版本已基于 Revision #{selectedRevision} 写入应用
							{createdAppId !== null ? `（${createdAppId}）` : ""}。
							该版本<strong>不会</strong>自动激活，需要在应用详情中激活才会对用户生效。
						</p>
						<div className={styles.drawerActions}>
							<AuroraButton
								variant="primary"
								size="md"
								onClick={() => {
									if (createdAppId !== null) {
										onClose();
										navigate(`/apps/${createdAppId}`);
									} else {
										onClose();
										navigate("/apps");
									}
								}}
							>
								前往应用详情
							</AuroraButton>
							<AuroraButton variant="default" size="md" onClick={onClose}>
								关闭
							</AuroraButton>
						</div>
					</div>
				) : null}

				{step === "error" ? (
					<div className={styles.drawerStep}>
						<h3>创建失败</h3>
						<p className={`${styles.banner} ${styles.error}`} role="alert">{error}</p>
						<div className={styles.drawerActions}>
							<AuroraButton variant="default" size="md" onClick={() => setStep("confirm")}>
								重试
							</AuroraButton>
							<AuroraButton variant="default" size="md" onClick={onClose}>
								关闭
							</AuroraButton>
						</div>
					</div>
				) : null}
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

/**
 * 按字段渲染 Revision 的配置摘要。绝不直接 `JSON.stringify` 整个对象。
 * 工具 / 知识库在此处只显示 ID 数量，避免伪造名称或健康状态。
 */
function ConfigSummary({ snapshot }: { snapshot: AgentConfigSnapshot }): React.ReactElement {
	const reasoning = snapshot.parameters.reasoning;
	return (
		<section className={styles.diffSummary} aria-label="配置摘要">
			<h4>配置摘要</h4>
			<dl className={styles.diffSummary__list}>
				<dt>Model</dt>
				<dd>
					<code>{snapshot.modelId ?? "—"}</code>
				</dd>
				<dt>思考</dt>
				<dd>
					{reasoning === undefined ? (
						"—"
					) : (
						<span>
							{reasoning.enabled === false ? "关闭" : "开启"}
							{reasoning.effort !== undefined ? ` · 默认强度 ${reasoningEffortLabel(reasoning.effort)}` : ""}
						</span>
					)}
				</dd>
				<dt>System Prompt</dt>
				<dd>
					{snapshot.systemPrompt.length === 0 ? (
						"（空）"
					) : snapshot.systemPrompt.length > PROMPT_SUMMARY_LIMIT ? (
						<details>
							<summary>
								{snapshot.systemPrompt.slice(0, PROMPT_SUMMARY_LIMIT)}…（共 {snapshot.systemPrompt.length} 字）
							</summary>
							<pre className={styles.diffSummary__prompt}>{snapshot.systemPrompt}</pre>
						</details>
					) : (
						<pre className={styles.diffSummary__prompt}>{snapshot.systemPrompt}</pre>
					)}
				</dd>
				<dt>Avatar</dt>
				<dd>{snapshot.capabilities.avatar ? "启用" : "关闭"}</dd>
				<dt>附件</dt>
				<dd>{snapshot.capabilities.attachments ? "启用" : "关闭"}</dd>
				<dt>实时语音</dt>
				<dd>
					{snapshot.capabilities.liveSpeech ? (
						<span>
							启用<span className={styles.diffSummary__experimental}>（实验性）</span>
						</span>
					) : (
						"关闭"
					)}
				</dd>
				<dt>工具</dt>
				<dd>
					{snapshot.toolIds.length === 0 ? (
						"未引用"
					) : (
						<span>
							已引用 {snapshot.toolIds.length} 项
							<span className={styles.diffSummary__muted}>（抽屉内不展示名称）</span>
						</span>
					)}
				</dd>
				<dt>知识库</dt>
				<dd>
					{snapshot.knowledgeBaseIds.length === 0 ? (
						"未引用"
					) : (
						<span>
							已引用 {snapshot.knowledgeBaseIds.length} 项
							<span className={styles.diffSummary__muted}>（抽屉内不展示名称）</span>
						</span>
					)}
				</dd>
			</dl>
		</section>
	);
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
	return effort;
}
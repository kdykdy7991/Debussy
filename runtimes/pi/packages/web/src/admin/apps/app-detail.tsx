/**
 * App detail page with tabs (WB-004 / SPEC §5.3).
 *
 * Tabs (首期): 概览 / 版本与上线 / 应用配置(stub) / 接入方式(stub) /
 * Launch Keys / 审计 / 用户会话(stub) / Danger Zone
 */
import type { LaunchKeySummary, PublishedAppDetail, PublishedAppVersionSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppApi, AppApiError } from "../api/app-api.ts";
import { AuroraButton, AuroraPageHeader, AuroraPill } from "../aurora/index.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import { adminConversationsPath } from "../user-conversations/query-params.ts";
import styles from "./app-detail.module.css";

type DetailTab = "overview" | "versions" | "access" | "activity" | "danger";

const DETAIL_TABS: readonly { readonly id: DetailTab; readonly label: string }[] = [
	{ id: "overview", label: "概览" },
	{ id: "versions", label: "版本与上线" },
	{ id: "access", label: "接入与安全" },
	{ id: "activity", label: "运行记录" },
	{ id: "danger", label: "危险操作" },
];

type LoadState =
	| { kind: "loading" }
	| { kind: "loaded"; detail: PublishedAppDetail; versions: readonly PublishedAppVersionSummary[] }
	| { kind: "error"; message: string };

/** Lazy-tab section state (MVP-06): errors surface explicitly, never become empty arrays. */
type SectionState<T> =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "loaded"; items: readonly T[]; nextCursor: string | null }
	| { kind: "error"; message: string };

export function AdminAppDetail({ appId }: { readonly appId: string }): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef<AppApi | null>(null);
	if (apiRef.current === null) apiRef.current = new AppApi({ auth: controller });
	const api = apiRef.current;
	const [tab, setTab] = useState<DetailTab>("overview");
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [keySection, setKeySection] = useState<SectionState<LaunchKeySummary>>({ kind: "idle" });
	const [auditSection, setAuditSection] = useState<SectionState<unknown>>({ kind: "idle" });

	const load = useCallback(() => {
		setState({ kind: "loading" });
		void Promise.all([api.getPublishedApp(appId), api.listVersions(appId, { limit: 50 })]).then(
			([detail, versions]) => {
				setState({ kind: "loaded", detail, versions: versions.items });
			},
			(err: Error) => setState({ kind: "error", message: err.message }),
		);
	}, [api, appId]);

	useEffect(() => {
		void load();
	}, [load]);

	// MVP-06: Launch Keys / Audit load on tab enter, with explicit error state
	// (previously the eager `.catch(() => ({ items: [] }))` silently turned any
	// failure into an empty list, hiding outages).
	useEffect(() => {
		if (tab !== "access" || keySection.kind !== "idle") return;
		let cancelled = false;
		setKeySection({ kind: "loading" });
		void api.listLaunchKeys(appId).then(
			(res) => {
				if (!cancelled) setKeySection({ kind: "loaded", items: res.items, nextCursor: null });
			},
			(err: Error) => {
				if (!cancelled) setKeySection({ kind: "error", message: err.message });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [tab, keySection.kind, api, appId]);

	useEffect(() => {
		if (tab !== "activity" || auditSection.kind !== "idle") return;
		let cancelled = false;
		setAuditSection({ kind: "loading" });
		void api.listAuditEvents({ appId, limit: 50 }).then(
			(res) => {
				if (!cancelled) setAuditSection({ kind: "loaded", items: res.items, nextCursor: res.nextCursor });
			},
			(err: Error) => {
				if (!cancelled) setAuditSection({ kind: "error", message: err.message });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [tab, auditSection.kind, api, appId]);

	if (state.kind === "loading") return <output className={styles.loading}>加载应用详情…</output>;
	if (state.kind === "error")
		return (
			<section className={styles.loadError} role="alert">
				<div>
					<strong>无法加载应用详情</strong>
					<p>{state.message}</p>
				</div>
				<AuroraButton onClick={load}>重试</AuroraButton>
			</section>
		);

	const { detail, versions } = state;
	const statusTone =
		detail.status === "active"
			? "live"
			: detail.status === "draft"
				? "amber"
				: detail.status === "suspended"
					? "red"
					: "neutral";
	const statusLabel =
		detail.status === "active"
			? "已发布"
			: detail.status === "draft"
				? "未发布"
				: detail.status === "suspended"
					? "已暂停"
					: "已归档";

	return (
		<section className={styles.workspace} aria-labelledby="app-detail-title">
			<AuroraButton variant="ghost" size="sm" onClick={() => navigate("/apps")}>
				← 返回发布列表
			</AuroraButton>
			<AuroraPageHeader
				title={detail.name}
				titleId="app-detail-title"
				description={`Public App ID · ${detail.publicAppId}`}
				meta={<AuroraPill tone={statusTone}>{statusLabel}</AuroraPill>}
			/>

			<div className={styles.tabs} role="tablist" aria-label="应用管理区域">
				{DETAIL_TABS.map((t, index) => (
					<button
						key={t.id}
						id={`app-tab-${t.id}`}
						role="tab"
						aria-controls={`app-panel-${t.id}`}
						aria-selected={tab === t.id}
						tabIndex={tab === t.id ? 0 : -1}
						type="button"
						onClick={() => setTab(t.id)}
						onKeyDown={(event) => {
							if (
								event.key !== "ArrowLeft" &&
								event.key !== "ArrowRight" &&
								event.key !== "Home" &&
								event.key !== "End"
							)
								return;
							event.preventDefault();
							const nextIndex =
								event.key === "Home"
									? 0
									: event.key === "End"
										? DETAIL_TABS.length - 1
										: (index + (event.key === "ArrowRight" ? 1 : -1) + DETAIL_TABS.length) %
											DETAIL_TABS.length;
							const nextTab = DETAIL_TABS[nextIndex];
							if (nextTab === undefined) return;
							setTab(nextTab.id);
							requestAnimationFrame(() => document.getElementById(`app-tab-${nextTab.id}`)?.focus());
						}}
					>
						{t.label}
					</button>
				))}
			</div>

			<div className={styles.panelBody} id={`app-panel-${tab}`} role="tabpanel" aria-labelledby={`app-tab-${tab}`}>
				{tab === "overview" && <OverviewPanel detail={detail} />}
				{tab === "versions" && (
					<VersionsPanel
						appId={appId}
						appName={detail.name}
						publicAppId={detail.publicAppId}
						allowedOrigins={detail.allowedOrigins}
						versions={versions}
						api={api}
						onChange={load}
					/>
				)}
				{tab === "access" && (
					<div className={styles.panelStack}>
						<ConfigPanel
							name={detail.name}
							accessMode={detail.accessMode}
							allowedOrigins={detail.allowedOrigins ?? []}
						/>
						<EmbedPanel publicAppId={detail.publicAppId} allowedOrigins={detail.allowedOrigins ?? []} />
						<LaunchKeysPanel
							appId={appId}
							section={keySection}
							api={api}
							onRefresh={() => {
								setKeySection({ kind: "idle" });
								api.listLaunchKeys(appId).then(
									(res) => setKeySection({ kind: "loaded", items: res.items, nextCursor: null }),
									(err: Error) => setKeySection({ kind: "error", message: err.message }),
								);
							}}
						/>
					</div>
				)}
				{tab === "activity" && (
					<div className={styles.panelStack}>
						<UsersPanel appId={appId} publicAppId={detail.publicAppId} />
						<AuditPanel section={auditSection} />
					</div>
				)}
				{tab === "danger" && (
					<DangerZonePanel
						appId={appId}
						appName={detail.name}
						publicAppId={detail.publicAppId}
						currentVersion={detail.currentVersion?.versionNumber ?? null}
						allowedOrigins={detail.allowedOrigins}
						status={detail.status}
						api={api}
						onChange={load}
					/>
				)}
			</div>
		</section>
	);
}

/**
 * 应用配置 tab（MVP-06）。
 *
 * Control API 没有"原地更新应用配置"的端点；配置的实际生效必须通过
 * 新建 Version 完成。因此这里只读展示当前配置，并明确引导"修改配置 →
 * 请在版本与上线里新建/上线"。（真实字段编辑若后续引入 update 端点，
 * 再拆成保存/上线。）
 */
function ConfigPanel({
	name,
	accessMode,
	allowedOrigins,
}: {
	readonly name: string;
	readonly accessMode: string;
	readonly allowedOrigins: readonly string[];
}): React.ReactElement {
	return (
		<div className={styles.section}>
			<p>
				<strong>只读</strong>：应用配置的修改必须通过新建 Version 生效（当前 Control API 不提供原地更新）。
				请到「版本与上线」页创建并上线新版本。
			</p>
			<dl className="diff-summary">
				<dt>名称</dt>
				<dd>{name}</dd>
				<dt>访问模式</dt>
				<dd>{accessMode}</dd>
				<dt>允许 Origin</dt>
				<dd>{allowedOrigins.length === 0 ? "—" : allowedOrigins.join(", ")}</dd>
			</dl>
		</div>
	);
}

/** 接入方式 tab（MVP-06）：可复制 iframe 与 WB-010 SDK 示例，用真实数据。 */
function EmbedPanel({
	publicAppId,
	allowedOrigins,
}: {
	readonly publicAppId: string;
	readonly allowedOrigins: readonly string[];
}): React.ReactElement {
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	const embedUrl = buildEmbedUrl(origin, publicAppId);
	const iframeSnippet = buildIframeSnippet(origin, publicAppId);
	const sdkSnippet = buildSdkSnippet(origin, publicAppId);

	return (
		<div className={styles.section}>
			<h3>iframe 接入</h3>
			<p>
				Embed URL：<code>{embedUrl}</code>
			</p>
			<p>允许 Origin：{allowedOrigins.length === 0 ? "（无，默认同源）" : allowedOrigins.join(", ")}</p>
			<CopyBlock label="iframe 代码" text={iframeSnippet} />
			<h3>SDK 接入（WB-010）</h3>
			<CopyBlock label="SDK 示例" text={sdkSnippet} />
		</div>
	);
}

function CopyBlock({ label, text }: { readonly label: string; readonly text: string }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	return (
		<div className="embed-copy">
			<button
				type="button"
				onClick={() => {
					void navigator.clipboard?.writeText(text).then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? "已复制" : `复制${label}`}
			</button>
			<pre className="code-block">{text}</pre>
		</div>
	);
}

export function buildEmbedUrl(origin: string, publicAppId: string): string {
	return `${origin.replace(/\/+$/, "")}/embed/${publicAppId}`;
}

export function buildIframeSnippet(origin: string, publicAppId: string): string {
	return `<iframe\n  src="${buildEmbedUrl(origin, publicAppId)}"\n  width="100%"\n  height="640"\n  allow="microphone; camera"\n  referrerpolicy="origin"\n  title="Pi Embed ${publicAppId}"\n></iframe>`;
}

export function buildSdkSnippet(origin: string, publicAppId: string): string {
	return `import { createClient } from "@earendil-works/pi-embed-sdk";\n\nconst client = createClient({ publicAppId: "${publicAppId}", origin: "${origin}" });\nclient.mount("#host");`;
}

/** 用户会话 tab（MVP-06）：跳转到用户会话列表并预填 appId 筛选。 */
function UsersPanel({
	appId,
	publicAppId,
}: {
	readonly appId: string;
	readonly publicAppId: string;
}): React.ReactElement {
	return (
		<div className={styles.section}>
			<p>查看该应用下的真实企业用户会话（脱敏列表，非管理员 DebugSession）。</p>
			<p>
				<code>publicAppId</code>：{publicAppId}
			</p>
			<button type="button" onClick={() => navigate(adminConversationsPath(appId))}>
				查看该应用的用户会话 →
			</button>
		</div>
	);
}

function OverviewPanel({ detail }: { readonly detail: PublishedAppDetail }): React.ReactElement {
	return (
		<div className={styles.overviewGrid}>
			<div className="card">
				<h3>概览</h3>
				<table>
					<tbody>
						<tr>
							<td>状态</td>
							<td>
								<span className={`badge status-${detail.status}`}>{detail.status}</span>
							</td>
						</tr>
						<tr>
							<td>publicAppId</td>
							<td>
								<code>{detail.publicAppId}</code>
							</td>
						</tr>
						<tr>
							<td>访问模式</td>
							<td>{detail.accessMode}</td>
						</tr>
						<tr>
							<td>允许 Origin</td>
							<td>{detail.allowedOrigins?.join(", ") ?? "—"}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<div className="card">
				<h3>当前 Agent</h3>
				<table>
					<tbody>
						<tr>
							<td>Agent</td>
							<td>{detail.sourceAgent?.name ?? "—"}</td>
						</tr>
						<tr>
							<td>Revision</td>
							<td>#{detail.sourceAgent?.revision}</td>
						</tr>
						<tr>
							<td>SourceHash</td>
							<td>
								<code>{detail.sourceAgent?.sourceHash?.slice(0, 12)}</code>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			{detail.currentVersion && (
				<div className="card">
					<h3>线上版本</h3>
					<table>
						<tbody>
							<tr>
								<td>版本号</td>
								<td>v{detail.currentVersion.versionNumber}</td>
							</tr>
							<tr>
								<td>状态</td>
								<td>{detail.currentVersion.status}</td>
							</tr>
							<tr>
								<td>AgentRevision</td>
								<td>#{detail.currentVersion.sourceAgentRevision}</td>
							</tr>
						</tbody>
					</table>
				</div>
			)}
			{detail.capabilities && (
				<div className="card">
					<h3>能力摘要</h3>
					<table>
						<tbody>
							<tr>
								<td>模型</td>
								<td>
									{detail.capabilities.model.provider}/{detail.capabilities.model.modelId}
								</td>
							</tr>
							<tr>
								<td>Profile</td>
								<td>{detail.capabilities.profile}</td>
							</tr>
							<tr>
								<td>工具</td>
								<td>{detail.capabilities.summary.tools?.join(", ") ?? "—"}</td>
							</tr>
							<tr>
								<td>上传</td>
								<td>{detail.capabilities.summary.uploads.enabled ? "✓" : "✗"}</td>
							</tr>
							<tr>
								<td>语音</td>
								<td>{detail.capabilities.summary.speech.enabled ? "✓" : "✗"}</td>
							</tr>
							<tr>
								<td>Avatar</td>
								<td>{detail.capabilities.summary.avatar.enabled ? "✓" : "✗"}</td>
							</tr>
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function VersionsPanel({
	appId,
	appName,
	publicAppId,
	allowedOrigins,
	versions,
	api,
	onChange,
}: {
	readonly appId: string;
	readonly appName: string;
	readonly publicAppId: string;
	readonly allowedOrigins: readonly string[];
	readonly versions: readonly PublishedAppVersionSummary[];
	readonly api: AppApi;
	readonly onChange: () => void;
}): React.ReactElement {
	const [revInput, setRevInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmation, setConfirmation] = useState<{
		readonly kind: "activate" | "rollback" | "preview";
		readonly version: PublishedAppVersionSummary;
	} | null>(null);

	const doCreateVersion = async () => {
		const rev = Number.parseInt(revInput, 10);
		if (!Number.isInteger(rev) || rev < 1) {
			setError("请输入正整数 revision");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.createVersion({ appId, sourceAgentRevision: rev });
			setRevInput("");
			onChange();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const doActivate = async (versionId: string) => {
		setBusy(true);
		try {
			await api.activateVersion({ appId, versionId });
			onChange();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const doPreview = async (versionId: string) => {
		const previewWindow = window.open("", "_blank");
		if (previewWindow === null) {
			setError("浏览器阻止了预览窗口，请允许弹窗后重试。");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const preview = await api.createPreviewTicket({ appId, versionId });
			const targetOrigin = new URL(preview.previewUrl).origin;
			const onReady = (event: MessageEvent<unknown>): void => {
				const message = event.data as { type?: unknown; publicAppId?: unknown } | null;
				if (
					event.source !== previewWindow ||
					event.origin !== targetOrigin ||
					message?.type !== "pi-preview-ready" ||
					message.publicAppId !== publicAppId
				) {
					return;
				}
				previewWindow.postMessage({ type: "pi-preview-ticket", publicAppId, ticket: preview.ticket }, targetOrigin);
				window.removeEventListener("message", onReady);
			};
			window.addEventListener("message", onReady);
			previewWindow.location.replace(preview.previewUrl);
			window.setTimeout(() => window.removeEventListener("message", onReady), 30_000);
		} catch (err) {
			previewWindow.close();
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const doRollback = async (versionId: string) => {
		setBusy(true);
		try {
			await api.rollbackVersion({ appId, versionId });
			onChange();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={styles.section}>
			{confirmation !== null && (
				<OperationConfirmation
					action={confirmation.kind}
					appName={appName}
					publicAppId={publicAppId}
					currentVersion={versions.find((version) => version.isCurrent)?.versionNumber ?? null}
					targetVersion={confirmation.version.versionNumber}
					allowedOrigins={allowedOrigins}
					busy={busy}
					onCancel={() => setConfirmation(null)}
					onConfirm={() => {
						const target = confirmation;
						setConfirmation(null);
						if (target.kind === "activate") void doActivate(target.version.id);
						else if (target.kind === "rollback") void doRollback(target.version.id);
						else void doPreview(target.version.id);
					}}
				/>
			)}
			<h3>创建版本（不自动激活）</h3>
			<div className="form-row">
				<input
					value={revInput}
					onChange={(e) => setRevInput(e.target.value)}
					placeholder="Agent Revision (正整数)"
					aria-label="Agent Revision"
					type="number"
					min="1"
				/>
				<button type="button" disabled={busy} onClick={doCreateVersion}>
					{busy ? "创建中…" : "创建版本"}
				</button>
			</div>
			{error !== null && <p className="banner error">{error}</p>}

			<h3>版本列表</h3>
			<table className="version-table">
				<thead>
					<tr>
						<th>版本</th>
						<th>状态</th>
						<th>AgentRevision</th>
						<th>RuntimeSpecHash</th>
						<th>创建时间</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{versions.map((v) => (
						<tr key={v.id} className={v.isCurrent ? "current" : ""}>
							<td>v{v.versionNumber}</td>
							<td>
								<span className={`badge status-${v.status}`}>
									{v.status}
									{v.isCurrent ? " (当前)" : ""}
								</span>
							</td>
							<td>#{v.sourceAgentRevision}</td>
							<td>
								<code>{v.runtimeSpecHash?.slice(0, 12) ?? "—"}</code>
							</td>
							<td>{v.createdAt}</td>
							<td>
								{v.status === "ready" && !v.isCurrent && (
									<>
										<button
											type="button"
											disabled={busy}
											onClick={() => setConfirmation({ kind: "preview", version: v })}
										>
											预览
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => setConfirmation({ kind: "activate", version: v })}
										>
											上线
										</button>
									</>
								)}
								{v.status === "ready" && !v.isCurrent && versions.some((candidate) => candidate.isCurrent) && (
									<button
										type="button"
										disabled={busy}
										onClick={() => setConfirmation({ kind: "rollback", version: v })}
									>
										回滚到此
									</button>
								)}
							</td>
						</tr>
					))}
					{versions.length === 0 && (
						<tr>
							<td colSpan={6}>暂无版本</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}

function OperationConfirmation(props: {
	readonly action: "activate" | "rollback" | "preview";
	readonly appName: string;
	readonly publicAppId: string;
	readonly currentVersion: number | null;
	readonly targetVersion: number;
	readonly allowedOrigins: readonly string[];
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}): React.ReactElement {
	const actionLabel = props.action === "activate" ? "上线" : props.action === "rollback" ? "回滚" : "预览";
	const impact =
		props.action === "preview"
			? "仅管理员预览，线上版本和线上用户均不受影响。"
			: "仅新建会话使用目标版本；已有会话继续固定原版本。";
	return (
		<div className="drawer-overlay" role="presentation">
			<section className="drawer" role="dialog" aria-modal="true" aria-label={`${actionLabel}确认`}>
				<h2>确认{actionLabel}</h2>
				<p>{impact}</p>
				<dl className="diff-summary">
					<dt>应用</dt>
					<dd>{props.appName}</dd>
					<dt>publicAppId</dt>
					<dd>{props.publicAppId}</dd>
					<dt>当前版本</dt>
					<dd>{props.currentVersion === null ? "无" : `v${props.currentVersion}`}</dd>
					<dt>目标版本</dt>
					<dd>v{props.targetVersion}</dd>
					<dt>Origins</dt>
					<dd>{props.allowedOrigins.join(", ") || "无"}</dd>
				</dl>
				<div className="drawer-actions">
					<button type="button" disabled={props.busy} onClick={props.onCancel}>
						取消
					</button>
					<button type="button" className="primary" disabled={props.busy} onClick={props.onConfirm}>
						确认{actionLabel}
					</button>
				</div>
			</section>
		</div>
	);
}

function LaunchKeysPanel({
	appId,
	section,
	api,
	onRefresh,
}: {
	readonly appId: string;
	section: SectionState<LaunchKeySummary>;
	readonly api: AppApi;
	readonly onRefresh: () => void;
}): React.ReactElement {
	const [keyId, setKeyId] = useState("");
	const [pem, setPem] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const doCreate = async () => {
		const trimmed = keyId.trim();
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
			setError("keyId 格式：1-64 字符，仅字母数字 ._-");
			return;
		}
		if (!pem.includes("BEGIN PUBLIC KEY") || pem.includes("PRIVATE KEY")) {
			setError("PEM 必须为公钥，不包含私钥");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.createLaunchKey({ appId, keyId: trimmed, publicKeyPem: pem.trim() });
			setKeyId("");
			setPem("");
			onRefresh();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const doRevoke = async (kId: string) => {
		setBusy(true);
		try {
			await api.revokeLaunchKey({ appId, keyId: kId });
			onRefresh();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={styles.section}>
			<h3>登记 Launch Key</h3>
			<div className="form-row">
				<input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="keyId" aria-label="Key ID" />
				<textarea
					className="pem-textarea"
					value={pem}
					onChange={(e) => setPem(e.target.value)}
					placeholder="PEM 公钥"
					aria-label="PEM Public Key"
					rows={4}
				/>
				<button type="button" disabled={busy} onClick={doCreate}>
					{busy ? "登记中…" : "登记"}
				</button>
			</div>
			{error !== null && <p className="banner error">{error}</p>}

			<h3>已登记 Key</h3>
			{section.kind === "loading" && <p>加载中…</p>}
			{section.kind === "error" && (
				<div className="banner error" role="alert">
					<span>加载失败：{section.message}</span>
					<button type="button" onClick={onRefresh}>
						重试
					</button>
				</div>
			)}
			{section.kind === "loaded" && (
				<table className="key-table">
					<thead>
						<tr>
							<th>keyId</th>
							<th>算法</th>
							<th>状态</th>
							<th>notBefore</th>
							<th>expiresAt</th>
							<th>创建时间</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{section.items.map((k) => (
							<tr key={k.id}>
								<td>
									<code>{k.keyId}</code>
								</td>
								<td>{k.algorithm}</td>
								<td>
									<span className={`badge status-${k.status}`}>{k.status}</span>
								</td>
								<td>{k.notBefore}</td>
								<td>{k.expiresAt ?? "—"}</td>
								<td>{k.createdAt}</td>
								<td>
									{k.status !== "revoked" && (
										<button type="button" disabled={busy} onClick={() => doRevoke(k.keyId)}>
											吊销
										</button>
									)}
								</td>
							</tr>
						))}
						{section.items.length === 0 && (
							<tr>
								<td colSpan={7}>暂无 Key</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
		</div>
	);
}

interface AuditRow {
	id: string;
	createdAt: string;
	action: string;
	actorType: string;
	actorId: string;
	resourceType: string;
	resourceId: string;
	requestId: string;
	metadata: unknown;
}

function AuditPanel({ section }: { section: SectionState<unknown> }): React.ReactElement {
	return (
		<div className={styles.section}>
			<h3>审计事件</h3>
			{section.kind === "loading" && <p>加载中…</p>}
			{section.kind === "error" && (
				<div className="banner error" role="alert">
					<span>加载失败：{section.message}</span>
				</div>
			)}
			{section.kind === "loaded" && <AuditTable items={section.items as unknown as readonly AuditRow[]} />}
		</div>
	);
}

function AuditTable({ items }: { readonly items: readonly AuditRow[] }): React.ReactElement {
	const audits = items;
	return (
		<table className="audit-table">
			<thead>
				<tr>
					<th>时间</th>
					<th>操作</th>
					<th>资源类型</th>
					<th>发起人</th>
					<th>requestId</th>
					<th>详情</th>
				</tr>
			</thead>
			<tbody>
				{audits.map((a) => (
					<tr key={a.id}>
						<td>{a.createdAt}</td>
						<td>{a.action}</td>
						<td>
							{a.resourceType}/{a.resourceId?.slice(0, 12)}
						</td>
						<td>
							{a.actorType}/{a.actorId?.slice(0, 12)}
						</td>
						<td>
							<code>{a.requestId?.slice(0, 12)}</code>
						</td>
						<td>
							<details>
								<summary>查看</summary>
								<pre>{JSON.stringify(a.metadata, null, 2)}</pre>
							</details>
						</td>
					</tr>
				))}
				{audits.length === 0 && (
					<tr>
						<td colSpan={6}>暂无审计事件</td>
					</tr>
				)}
			</tbody>
		</table>
	);
}

function DangerZonePanel({
	appId,
	appName,
	publicAppId,
	currentVersion,
	allowedOrigins,
	status,
	api,
	onChange,
}: {
	readonly appId: string;
	readonly appName: string;
	readonly publicAppId: string;
	readonly currentVersion: number | null;
	readonly allowedOrigins: readonly string[];
	readonly status: string;
	readonly api: AppApi;
	readonly onChange: () => void;
}): React.ReactElement {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmSuspend, setConfirmSuspend] = useState(false);

	const doSuspend = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.suspendApp({ appId });
			onChange();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`${styles.section} danger`}>
			{confirmSuspend && (
				<div className="drawer-overlay" role="presentation">
					<section className="drawer" role="dialog" aria-modal="true" aria-label="停用确认">
						<h2>确认停用应用</h2>
						<p>停用后将拒绝新的身份交换和新会话；正在运行的对话允许完成。</p>
						<dl className="diff-summary">
							<dt>应用</dt>
							<dd>{appName}</dd>
							<dt>publicAppId</dt>
							<dd>{publicAppId}</dd>
							<dt>当前版本</dt>
							<dd>{currentVersion === null ? "无" : `v${currentVersion}`}</dd>
							<dt>Origins</dt>
							<dd>{allowedOrigins.join(", ") || "无"}</dd>
						</dl>
						<div className="drawer-actions">
							<button type="button" disabled={busy} onClick={() => setConfirmSuspend(false)}>
								取消
							</button>
							<button
								type="button"
								className="danger"
								disabled={busy}
								onClick={() => {
									setConfirmSuspend(false);
									void doSuspend();
								}}
							>
								确认停用
							</button>
						</div>
					</section>
				</div>
			)}
			<h3>危险操作</h3>
			{error !== null && <p className="banner error">{error}</p>}
			{status === "active" || status === "draft" ? (
				<button type="button" className="danger" disabled={busy} onClick={() => setConfirmSuspend(true)}>
					{busy ? "处理中…" : "停用应用"}
				</button>
			) : status === "suspended" ? (
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await api.activateVersion({ appId, versionId: "" });
							// Fallback: if no current version, can't resume via activate
							onChange();
						} catch (err) {
							setError(err instanceof AppApiError ? err.message : String(err));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? "处理中…" : "恢复应用"}
				</button>
			) : null}
		</div>
	);
}

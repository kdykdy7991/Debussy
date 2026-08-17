/**
 * App detail page with tabs (WB-004 / SPEC §5.3).
 *
 * Tabs (首期): 概览 / 版本与上线 / 应用配置(stub) / 接入方式(stub) /
 * Launch Keys / 审计 / 用户会话(stub) / Danger Zone
 */
import type { LaunchKeySummary, PublishedAppDetail, PublishedAppVersionSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppApi, AppApiError } from "../api/app-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";

type DetailTab = "overview" | "versions" | "config" | "embed" | "keys" | "audit" | "users" | "danger";

type LoadState =
	| { kind: "loading" }
	| { kind: "loaded"; detail: PublishedAppDetail; versions: readonly PublishedAppVersionSummary[] }
	| { kind: "error"; message: string };

export function AdminAppDetail({ appId }: { readonly appId: string }): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef<AppApi | null>(null);
	if (apiRef.current === null) apiRef.current = new AppApi({ auth: controller });
	const api = apiRef.current;
	const [tab, setTab] = useState<DetailTab>("overview");
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [launchKeys, setLaunchKeys] = useState<readonly LaunchKeySummary[]>([]);
	const [audits, setAudits] = useState<readonly unknown[]>([]);

	const load = useCallback(() => {
		setState({ kind: "loading" });
		void Promise.all([
			api.getPublishedApp(appId),
			api.listVersions(appId, { limit: 50 }),
			api.listLaunchKeys(appId).catch(() => ({ items: [] })),
			api.listAuditEvents({ appId, limit: 50 }).catch(() => ({ items: [] })),
		]).then(
			([detail, versions, keysRes, auditRes]) => {
				setState({ kind: "loaded", detail, versions: versions.items });
				setLaunchKeys(keysRes.items);
				setAudits(auditRes.items);
			},
			(err: Error) => setState({ kind: "error", message: err.message }),
		);
	}, [api, appId]);

	useEffect(() => {
		void load();
	}, [load]);

	if (state.kind === "loading") return <output>加载应用详情…</output>;
	if (state.kind === "error")
		return (
			<section>
				<p role="alert">加载失败：{state.message}</p>
				<button type="button" onClick={load}>
					重试
				</button>
			</section>
		);

	const { detail, versions } = state;
	const tabs: { id: DetailTab; label: string }[] = [
		{ id: "overview", label: "概览" },
		{ id: "versions", label: "版本与上线" },
		{ id: "config", label: "应用配置" },
		{ id: "embed", label: "接入方式" },
		{ id: "keys", label: "Launch Keys" },
		{ id: "audit", label: "审计" },
		{ id: "users", label: "用户会话" },
		{ id: "danger", label: "Danger Zone" },
	];

	return (
		<section>
			<button type="button" onClick={() => navigate("/apps")}>
				← 返回应用列表
			</button>
			<h1>
				{detail.name} <small>{detail.publicAppId}</small>
			</h1>

			<div className="detail-tabs" role="tablist">
				{tabs.map((t) => (
					<button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}>
						{t.label}
					</button>
				))}
			</div>

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
			{tab === "config" && (
				<div className="panel">
					<p>应用配置编辑由 WB-004 实施；当前可在发布流程中创建版本。</p>
					<dl>
						<dt>名称</dt>
						<dd>{detail.name}</dd>
						<dt>访问模式</dt>
						<dd>{detail.accessMode}</dd>
						<dt>允许 Origin</dt>
						<dd>{detail.allowedOrigins?.join(", ") ?? "—"}</dd>
					</dl>
				</div>
			)}
			{tab === "embed" && (
				<div className="panel">
					<p>嵌入方式由 WB-010 实施。</p>
					<p>
						Embed URL:{" "}
						<code>{detail.publicAppId ? `${window.location.origin}/embed/${detail.publicAppId}` : "—"}</code>
					</p>
				</div>
			)}
			{tab === "keys" && (
				<LaunchKeysPanel
					appId={appId}
					keys={launchKeys}
					api={api}
					onChange={() => {
						void api.listLaunchKeys(appId).then(
							(res) => setLaunchKeys(res.items),
							() => {},
						);
					}}
				/>
			)}
			{tab === "audit" && <AuditPanel items={audits} />}
			{tab === "users" && (
				<div className="panel">
					<p>用户会话管理由 WB-006 实施。</p>
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
		</section>
	);
}

function OverviewPanel({ detail }: { readonly detail: PublishedAppDetail }): React.ReactElement {
	return (
		<div className="panel">
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
		<div className="panel">
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
	keys,
	api,
	onChange,
}: {
	readonly appId: string;
	readonly keys: readonly LaunchKeySummary[];
	readonly api: AppApi;
	readonly onChange: () => void;
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
			onChange();
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
			onChange();
		} catch (err) {
			setError(err instanceof AppApiError ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="panel">
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
					{keys.map((k) => (
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
					{keys.length === 0 && (
						<tr>
							<td colSpan={7}>暂无 Key</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}

function AuditPanel({ items }: { readonly items: readonly unknown[] }): React.ReactElement {
	const audits = items as ReadonlyArray<{
		id: string;
		createdAt: string;
		action: string;
		actorType: string;
		actorId: string;
		resourceType: string;
		resourceId: string;
		requestId: string;
		metadata: unknown;
	}>;
	return (
		<div className="panel">
			<h3>审计事件</h3>
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
		</div>
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
		<div className="panel danger">
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

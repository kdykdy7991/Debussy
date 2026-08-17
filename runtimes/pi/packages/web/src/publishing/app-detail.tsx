/**
 * App detail page (PUBLISHING-ADMIN-CONSOLE §5.4).
 *
 * Tabs: Overview / Versions / Launch Keys / Audit.
 * Danger Zone: Suspend / Resume (with confirmation).
 */
import { useState } from "react";
import { AuditPanel } from "./audit-panel.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { LaunchKeyPanel } from "./launch-key-panel.tsx";
import type { DetailTab, PublishingController } from "./publishing-controller.ts";
import { VersionPanel } from "./version-panel.tsx";

export interface AppDetailProps {
	readonly controller: PublishingController;
	readonly appId: string;
	readonly tab: DetailTab;
	readonly onBack: () => void;
	readonly setTab: (tab: DetailTab) => void;
}

export function AppDetail({ controller, appId, tab, onBack, setTab }: AppDetailProps) {
	const snapshot = useSnapshot(controller);
	const detail = snapshot.detail;
	const [confirmSuspend, setConfirmSuspend] = useState(false);

	if (snapshot.detailLoading && detail === null) {
		return <div className="pub-card">加载中…</div>;
	}
	if (snapshot.detailError !== null && detail === null) {
		return (
			<div className="banner error">
				<span>{snapshot.detailError}</span>
				<button className="pub-btn ghost" type="button" onClick={() => controller.refreshDetail(appId, tab)}>
					重试
				</button>
			</div>
		);
	}
	if (detail === null) {
		return <div className="pub-card">未找到 App。</div>;
	}

	return (
		<div>
			<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
				<button className="pub-btn ghost" type="button" onClick={onBack}>
					← 返回列表
				</button>
				<h1 style={{ margin: 0, fontSize: 20 }}>
					{detail.name} <small style={{ color: "var(--pub-fg-muted)" }}>{detail.publicAppId}</small>
				</h1>
				<span className={`badge ${detail.status}`}>{detail.status}</span>
			</div>

			<div className="detail-tabs">
				{(["overview", "versions", "keys", "audit"] as const).map((option) => (
					<button
						key={option}
						type="button"
						className={tab === option ? "active" : undefined}
						onClick={() => setTab(option)}
					>
						{option === "overview"
							? "Overview"
							: option === "versions"
								? "Versions"
								: option === "keys"
									? "Launch Keys"
									: "Audit"}
					</button>
				))}
			</div>

			{tab === "overview" ? (
				<OverviewPanel
					detail={detail}
					onSuspend={() => setConfirmSuspend(true)}
					onResume={() => controller.resumeApp({ appId })}
				/>
			) : tab === "versions" ? (
				<VersionPanel controller={controller} appId={appId} setTab={setTab} />
			) : tab === "keys" ? (
				<LaunchKeyPanel controller={controller} appId={appId} />
			) : (
				<AuditPanel controller={controller} />
			)}

			{confirmSuspend ? (
				<ConfirmDialog
					title={`停用 ${detail.name}`}
					body={
						<div>
							<p>停用后 Embed 端会立即拒绝新建 exchange / turn；正在运行的 turn 不会被打断。</p>
							<p style={{ marginTop: 8 }}>这是不可逆操作；需要重新激活一个 ready 版本才能恢复。</p>
						</div>
					}
					confirmLabel="确认停用"
					danger
					onConfirm={async () => {
						setConfirmSuspend(false);
						await controller.suspendApp({ appId });
					}}
					onCancel={() => setConfirmSuspend(false)}
				/>
			) : null}
		</div>
	);
}

function OverviewPanel({
	detail,
	onSuspend,
	onResume,
}: {
	readonly detail: import("./types.ts").PublishedAppDetail;
	readonly onSuspend: () => void;
	readonly onResume: () => void;
}) {
	return (
		<div>
			<div className="pub-card">
				<h2>概览</h2>
				<dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 8, margin: 0 }}>
					<dt style={{ color: "var(--pub-fg-muted)" }}>publicAppId</dt>
					<dd style={{ margin: 0 }}>{detail.publicAppId}</dd>
					<dt style={{ color: "var(--pub-fg-muted)" }}>status</dt>
					<dd style={{ margin: 0 }}>
						<span className={`badge ${detail.status}`}>{detail.status}</span>
					</dd>
					<dt style={{ color: "var(--pub-fg-muted)" }}>accessMode</dt>
					<dd style={{ margin: 0 }}>{detail.accessMode}</dd>
					<dt style={{ color: "var(--pub-fg-muted)" }}>allowedOrigins</dt>
					<dd style={{ margin: 0 }}>
						{detail.allowedOrigins.length === 0
							? "—"
							: detail.allowedOrigins.map((origin) => <div key={origin}>{origin}</div>)}
					</dd>
					<dt style={{ color: "var(--pub-fg-muted)" }}>embedUrl</dt>
					<dd style={{ margin: 0 }}>
						<code>{`${window.location.origin}/embed/${detail.publicAppId}`}</code>
					</dd>
				</dl>
				<pre
					style={{
						marginTop: 12,
						background: "var(--pub-bg)",
						padding: 10,
						borderRadius: 8,
						overflowX: "auto",
						fontSize: 12,
					}}
				>
					{`<iframe src="${window.location.origin}/embed/${detail.publicAppId}" allow="microphone"></iframe>`}
				</pre>
			</div>

			<div className="pub-card">
				<h2>当前 Agent</h2>
				<dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 8, margin: 0 }}>
					<dt style={{ color: "var(--pub-fg-muted)" }}>Agent</dt>
					<dd style={{ margin: 0 }}>{detail.sourceAgent.name}</dd>
					<dt style={{ color: "var(--pub-fg-muted)" }}>Revision</dt>
					<dd style={{ margin: 0 }}>{detail.sourceAgent.revision}</dd>
					<dt style={{ color: "var(--pub-fg-muted)" }}>sourceHash</dt>
					<dd style={{ margin: 0 }}>
						<code style={{ fontSize: 11 }}>{detail.sourceAgent.sourceHash}</code>
					</dd>
				</dl>
			</div>

			{detail.capabilities !== null ? (
				<div className="pub-card">
					<h2>能力摘要</h2>
					<dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 8, margin: 0 }}>
						<dt style={{ color: "var(--pub-fg-muted)" }}>Model</dt>
						<dd style={{ margin: 0 }}>
							{detail.capabilities.model.provider} / {detail.capabilities.model.modelId}
						</dd>
						<dt style={{ color: "var(--pub-fg-muted)" }}>Profile</dt>
						<dd style={{ margin: 0 }}>{detail.capabilities.profile}</dd>
						<dt style={{ color: "var(--pub-fg-muted)" }}>Tools</dt>
						<dd style={{ margin: 0 }}>{detail.capabilities.summary.tools.join(", ") || "—"}</dd>
						<dt style={{ color: "var(--pub-fg-muted)" }}>Uploads</dt>
						<dd style={{ margin: 0 }}>
							{detail.capabilities.summary.uploads.enabled
								? `enabled · maxFiles=${detail.capabilities.summary.uploads.maxFiles}`
								: "disabled"}
						</dd>
						<dt style={{ color: "var(--pub-fg-muted)" }}>Speech</dt>
						<dd style={{ margin: 0 }}>{detail.capabilities.summary.speech.enabled ? "enabled" : "disabled"}</dd>
						<dt style={{ color: "var(--pub-fg-muted)" }}>Avatar</dt>
						<dd style={{ margin: 0 }}>{detail.capabilities.summary.avatar.enabled ? "enabled" : "disabled"}</dd>
					</dl>
				</div>
			) : null}

			<div className="pub-card">
				<h2>危险操作</h2>
				{detail.status === "suspended" ? (
					<button className="pub-btn primary" type="button" onClick={onResume}>
						恢复 / 激活
					</button>
				) : detail.status === "active" ? (
					<button className="pub-btn danger" type="button" onClick={onSuspend}>
						停用
					</button>
				) : (
					<p style={{ color: "var(--pub-fg-muted)" }}>当前状态不允许危险操作。</p>
				)}
			</div>
		</div>
	);
}

function useSnapshot(controller: PublishingController) {
	return controller.getSnapshot();
}

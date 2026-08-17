/**
 * App versions panel (ADMIN-006 / PUBLISHING-ADMIN-CONSOLE §5.4).
 *
 * List, create, activate, rollback, view validation errors.
 */
import { useState, useSyncExternalStore } from "react";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import type { DetailTab, PublishingController } from "./publishing-controller.ts";
import type { PublishedAppVersionSummary } from "./types.ts";

export interface VersionPanelProps {
	readonly controller: PublishingController;
	readonly appId: string;
	readonly setTab: (tab: DetailTab) => void;
}

export function VersionPanel({ controller, appId, setTab }: VersionPanelProps) {
	const snapshot = useSnapshot(controller);
	const detail = snapshot.detail;
	const [revisionInput, setRevisionInput] = useState<string>("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmTarget, setConfirmTarget] = useState<{
		readonly action: "activate" | "rollback";
		readonly version: PublishedAppVersionSummary;
	} | null>(null);

	if (detail === null) return <p>加载中…</p>;

	const submitCreate = async () => {
		const rev = Number(revisionInput);
		if (!Number.isInteger(rev) || rev <= 0) {
			setError("revision 必须是正整数");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await controller.createVersion({ appId, sourceAgentRevision: rev });
			setRevisionInput("");
			setTab("versions");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const performAction = async () => {
		const target = confirmTarget;
		if (target === null) return;
		setConfirmTarget(null);
		if (target.action === "activate") {
			await controller.activateVersion({ appId, versionId: target.version.id });
		} else {
			await controller.rollbackVersion({ appId, versionId: target.version.id });
		}
	};

	return (
		<div className="pub-card">
			<h2>版本</h2>
			<div style={{ display: "flex", gap: 8, alignItems: "end", marginBottom: 12 }}>
				<label style={{ flex: 1 }}>
					<span>从 Agent revision 创建新版本</span>
					<input
						value={revisionInput}
						onChange={(event) => setRevisionInput(event.target.value)}
						placeholder="例如 3"
					/>
				</label>
				<button className="pub-btn primary" type="button" onClick={submitCreate} disabled={submitting}>
					{submitting ? "创建中…" : "创建版本"}
				</button>
			</div>
			{error !== null ? <div className="banner error">{error}</div> : null}
			<table className="version-table">
				<thead>
					<tr>
						<th>#</th>
						<th>状态</th>
						<th>Source rev</th>
						<th>runtimeSpecHash</th>
						<th>创建时间</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{snapshot.versions.length === 0 ? (
						<tr>
							<td colSpan={6} style={{ textAlign: "center", color: "var(--pub-fg-muted)" }}>
								尚无版本
							</td>
						</tr>
					) : (
						snapshot.versions.map((version) => (
							<tr key={version.id} className={version.isCurrent ? "current" : undefined}>
								<td>
									<strong>v{version.versionNumber}</strong>
									{version.isCurrent ? <small> current</small> : null}
								</td>
								<td>
									<span className={`badge ${version.status}`}>{version.status}</span>
								</td>
								<td>{version.sourceAgentRevision}</td>
								<td>
									<small style={{ fontFamily: "monospace", color: "var(--pub-fg-muted)" }}>
										{version.runtimeSpecHash === null ? "—" : version.runtimeSpecHash.slice(0, 12)}
									</small>
								</td>
								<td>{new Date(version.createdAt).toLocaleString()}</td>
								<td>
									{version.status === "ready" ? (
										<div style={{ display: "flex", gap: 4 }}>
											{!version.isCurrent ? (
												<button
													className="pub-btn"
													type="button"
													onClick={() => setConfirmTarget({ action: "activate", version })}
												>
													激活
												</button>
											) : null}
											<button
												className="pub-btn"
												type="button"
												onClick={() => setConfirmTarget({ action: "rollback", version })}
												disabled={!snapshot.detail?.currentVersion}
											>
												回滚到此版本
											</button>
										</div>
									) : version.status === "rejected" ? (
										<div className="validation-errors">
											{version.validationErrors.map((err) => (
												<div key={String(err)}>{JSON.stringify(err)}</div>
											))}
										</div>
									) : null}
								</td>
							</tr>
						))
					)}
				</tbody>
			</table>
			{confirmTarget !== null ? (
				<ConfirmDialog
					title={confirmTarget.action === "activate" ? "激活版本" : "回滚到此版本"}
					body={
						<div>
							<p>
								应用：<strong>{detail.name}</strong>
							</p>
							<p>
								版本：<strong>v{confirmTarget.version.versionNumber}</strong>
							</p>
							<p style={{ marginTop: 8, color: "var(--pub-fg-muted)" }}>
								{confirmTarget.action === "activate"
									? "激活后将立即对 Embed 开放。"
									: "回滚仅翻转 current pointer；历史 RuntimeSpec 不会被改动。"}
							</p>
						</div>
					}
					confirmLabel="确认"
					danger={confirmTarget.action === "rollback"}
					onConfirm={performAction}
					onCancel={() => setConfirmTarget(null)}
				/>
			) : null}
		</div>
	);
}

function useSnapshot(controller: PublishingController) {
	return useSyncExternalStore(controller.subscribe.bind(controller), controller.getSnapshot, controller.getSnapshot);
}

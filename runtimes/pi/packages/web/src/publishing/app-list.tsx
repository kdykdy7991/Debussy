/**
 * App list page (ADMIN-004 / PUBLISHING-ADMIN-CONSOLE §5.2).
 *
 * - 状态筛选 / 搜索；
 * - 名称、状态、访问模式、当前版本、Origin 数量、Embed URL 复制；
 * - "导入当前 Agent"、"创建应用"；
 * - 空 / 加载 / 错误态 + 重试。
 */
import { useEffect, useMemo, useState } from "react";
import type { PublishingController } from "./publishing-controller.ts";

export interface AppListProps {
	readonly controller: PublishingController;
	readonly onOpen: (appId: string) => void;
	readonly onCreate: () => void;
}

export function AppList({ controller, onOpen, onCreate }: AppListProps) {
	const snapshot = useSnapshot(controller);
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return snapshot.apps;
		return snapshot.apps.filter(
			(app) => app.name.toLowerCase().includes(needle) || app.publicAppId.toLowerCase().includes(needle),
		);
	}, [query, snapshot.apps]);
	return (
		<div>
			<div className="app-list-toolbar">
				<select
					value={snapshot.appsStatusFilter}
					onChange={(event) => controller.setStatusFilter(event.target.value)}
					aria-label="状态筛选"
				>
					<option value="">全部状态</option>
					<option value="draft">draft</option>
					<option value="active">active</option>
					<option value="suspended">suspended</option>
					<option value="archived">archived</option>
				</select>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="按名称 / publicAppId 搜索"
					aria-label="搜索 App"
				/>
				<span className="spacer" />
				<button
					className="pub-btn"
					type="button"
					onClick={() => controller.importCurrentAgent()}
					disabled={controller.isInflight("agents.import")}
				>
					{controller.isInflight("agents.import") ? "导入中…" : "导入当前 Agent"}
				</button>
				<button className="pub-btn primary" type="button" onClick={onCreate}>
					创建应用
				</button>
			</div>
			{snapshot.appsLoading && snapshot.apps.length === 0 ? (
				<div className="pub-card">加载中…</div>
			) : snapshot.appsError !== null ? (
				<div className="banner error">
					<span>{snapshot.appsError}</span>
					<button className="pub-btn ghost" type="button" onClick={() => controller.refreshAppList()}>
						重试
					</button>
				</div>
			) : filtered.length === 0 ? (
				<div className="pub-card empty">
					<p>暂无 App。点击"创建应用"开始，或先"导入当前 Agent"准备 agent revision。</p>
				</div>
			) : (
				<>
					<div className="app-list">
						{filtered.map((app) => (
							<div className="app-row" key={app.id}>
								<div className="name">
									<strong>{app.name}</strong>
									<small>{app.publicAppId}</small>
								</div>
								<div>
									<span className={`badge ${app.status}`}>{app.status}</span>
									<small style={{ marginLeft: 12, color: "var(--pub-fg-muted)" }}>{app.accessMode}</small>
								</div>
								<div>
									<small style={{ color: "var(--pub-fg-muted)" }}>当前版本</small>
									<div>{app.currentVersionId ?? "—"}</div>
								</div>
								<div>
									<small style={{ color: "var(--pub-fg-muted)" }}>允许 Origin</small>
									<div>{app.allowedOrigins.length}</div>
								</div>
								<div style={{ display: "flex", gap: 8 }}>
									<CopyButton text={app.embedUrl} label="复制 Embed URL" />
									<button className="pub-btn" type="button" onClick={() => onOpen(app.id)}>
										详情
									</button>
								</div>
							</div>
						))}
					</div>
					{snapshot.appsNextCursor !== null ? (
						<div className="step-actions">
							<button
								className="pub-btn"
								type="button"
								onClick={() => void controller.loadMoreApps()}
								disabled={snapshot.appsLoading}
							>
								{snapshot.appsLoading ? "加载中…" : "加载更多"}
							</button>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			className="copy"
			type="button"
			onClick={() => {
				void navigator.clipboard?.writeText(text).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? "已复制" : label}
		</button>
	);
}

function useSnapshot(controller: PublishingController) {
	const [, force] = useState({});
	useEffect(() => controller.subscribe(() => force({})), [controller]);
	return controller.getSnapshot();
}

/**
 * App list page with dashboard summary (WB-004 / SPEC §5.3).
 *
 * - Dashboard summary cards (app count, active users, active sessions, errors)
 * - Pending (ready non-current) version blocks
 * - App list table with status filter, search, cursor pagination
 * - Loading / empty / error / retry states
 */
import type { DashboardSummary, PublishedAppSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppApi } from "../api/app-api.ts";
import { AdminAppDetail } from "../apps/app-detail.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import type { AdminRoute } from "../router.ts";
import { navigate } from "../router.ts";

type AppsState =
	| { kind: "loading" }
	| { kind: "loaded"; apps: readonly PublishedAppSummary[]; nextCursor: string | null; statusFilter: string }
	| { kind: "error"; message: string };

type DashboardState =
	| { kind: "loading" }
	| { kind: "loaded"; data: DashboardSummary }
	| { kind: "error"; message: string };

export function AdminAppsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "app-detail") {
		const appId = route.params.appId;
		if (appId === undefined) return <p role="alert">缺少 appId</p>;
		return <AdminAppDetail appId={appId} />;
	}
	return <AdminAppsDashboard />;
}

function AdminAppsDashboard(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new AppApi({ auth: controller })).current;
	const [dashboard, setDashboard] = useState<DashboardState>({ kind: "loading" });
	const [apps, setApps] = useState<AppsState>({ kind: "loading" });
	const [query, setQuery] = useState("");

	const loadDashboard = useCallback(() => {
		setDashboard({ kind: "loading" });
		void api.getDashboardSummary().then(
			(data) => setDashboard({ kind: "loaded", data }),
			(err: Error) => setDashboard({ kind: "error", message: err.message }),
		);
	}, [api]);
	const loadApps = useCallback(
		(statusFilter: string) => {
			setApps({ kind: "loading" });
			void api.listPublishedApps({ limit: 50, status: statusFilter === "" ? undefined : statusFilter }).then(
				(res) => setApps({ kind: "loaded", apps: res.items, nextCursor: res.nextCursor, statusFilter }),
				(err: Error) => setApps({ kind: "error", message: err.message }),
			);
		},
		[api],
	);

	useEffect(() => {
		void loadDashboard();
		void loadApps("");
	}, [loadDashboard, loadApps]);

	const filtered = useMemo(() => {
		if (apps.kind !== "loaded") return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return apps.apps;
		return apps.apps.filter(
			(a) => a.name.toLowerCase().includes(needle) || a.publicAppId.toLowerCase().includes(needle),
		);
	}, [query, apps]);

	return (
		<section>
			<h1>应用</h1>

			{/* Dashboard metrics */}
			<div className="dashboard-cards">
				{dashboard.kind === "loading" ? (
					<div className="card">加载中…</div>
				) : dashboard.kind === "error" ? (
					<div className="card error">
						<span>仪表盘：{dashboard.message}</span>
						<button type="button" onClick={loadDashboard}>
							重试
						</button>
					</div>
				) : (
					<>
						<div className="card metric">
							<strong>{dashboard.data.appCount}</strong>
							<small>应用数</small>
						</div>
						<div className="card metric">
							<strong>{dashboard.data.activeUserCount}</strong>
							<small>活跃用户</small>
						</div>
						<div className="card metric">
							<strong>{dashboard.data.activeSessionCount}</strong>
							<small>会话数</small>
						</div>
						<div className="card metric">
							<strong>{dashboard.data.errorEventCount}</strong>
							<small>错误事件</small>
						</div>
					</>
				)}
			</div>

			{/* Pending versions */}
			{dashboard.kind === "loaded" && dashboard.data.pendingApps.length > 0 && (
				<div className="pending-section">
					<h2>待上线版本</h2>
					{dashboard.data.pendingApps.map((p) => (
						<div key={p.appId} className="pending-row">
							<span>
								<strong>{p.name}</strong> ({p.publicAppId})
							</span>
							<span>
								v{p.pendingVersionNumber} · {p.pendingVersionStatus}
							</span>
							<button type="button" onClick={() => navigate(`/apps/${p.appId}`)}>
								查看
							</button>
						</div>
					))}
				</div>
			)}

			{/* App list toolbar */}
			<div className="app-list-toolbar">
				<select
					value={apps.kind === "loaded" ? apps.statusFilter : ""}
					onChange={(e) => {
						const val = e.target.value;
						setApps({ kind: "loading" });
						loadApps(val);
					}}
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
					onChange={(e) => setQuery(e.target.value)}
					placeholder="按名称 / publicAppId 搜索"
					aria-label="搜索应用"
				/>
			</div>

			{/* App list */}
			{apps.kind === "loading" && filtered.length === 0 ? (
				<div className="card">加载中…</div>
			) : apps.kind === "error" ? (
				<div className="banner error">
					<span>{apps.message}</span>
					<button type="button" onClick={() => loadApps(apps.kind === "error" ? "" : "")}>
						重试
					</button>
				</div>
			) : filtered.length === 0 ? (
				<div className="card empty">
					<p>暂无应用。</p>
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
									<span className={`badge status-${app.status}`}>{app.status}</span>
									<small style={{ marginLeft: 12, color: "var(--pub-fg-muted)" }}>{app.accessMode}</small>
								</div>
								<div>
									<small>当前版本</small>
									<div>{app.currentVersionId ?? "—"}</div>
								</div>
								<div>
									<small>允许 Origin</small>
									<div>{app.allowedOrigins.length}</div>
								</div>
								<div style={{ display: "flex", gap: 8 }}>
									<CopyButton text={app.embedUrl} label="复制 Embed URL" />
									<button type="button" onClick={() => navigate(`/apps/${app.id}`)}>
										详情
									</button>
								</div>
							</div>
						))}
					</div>
					{apps.kind === "loaded" && apps.nextCursor !== null && (
						<button
							type="button"
							disabled={false}
							onClick={() => {
								// Single-level load-more: fetch more and append
								const cursor = apps.nextCursor ?? undefined;
								void api
									.listPublishedApps({
										limit: 50,
										cursor,
										status: apps.statusFilter === "" ? undefined : apps.statusFilter,
									})
									.then(
										(res) => {
											const known = new Set(apps.apps.map((a) => a.id));
											setApps({
												kind: "loaded",
												apps: [...apps.apps, ...res.items.filter((a) => !known.has(a.id))],
												nextCursor: res.nextCursor,
												statusFilter: apps.statusFilter,
											});
										},
										(err: Error) => setApps({ kind: "error", message: err.message }),
									);
							}}
						>
							加载更多
						</button>
					)}
				</>
			)}
		</section>
	);
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	return (
		<button
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

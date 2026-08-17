/**
 * Publishing 管理控制台顶层 Shell（ADMIN-000 §3.1 / §5）。
 *
 * - 路由分流：`/publishing` 全部由本组件接管；`/embed/*` 由 EmbedApp 接管；
 *   其它路径保持原有内部 Pi Web App 不变。
 * - Token 仅内存：`/publishing` 路由级别不读取 localStorage / sessionStorage
 *   / URL 查询串。
 * - 不依赖 Pi WebSocket：管理面和 Embed 一样走普通 HTTP fetch。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublishingApi } from "./api.ts";
import { AppDetail } from "./app-detail.tsx";
import { AppList } from "./app-list.tsx";
import { AdminAuthController } from "./auth-controller.ts";
import { CreateAppWizard } from "./create-app-wizard.tsx";
import { type DetailTab, PublishingController } from "./publishing-controller.ts";
import type { PublishedAppDetail } from "./types.ts";
import "./publishing.css";

export interface PublishingAppProps {
	readonly api?: PublishingApi;
	readonly auth?: AdminAuthController;
	readonly controller?: PublishingController;
	readonly initialBaseUrl?: string;
}

export function PublishingApp(props: PublishingAppProps) {
	const auth = useMemo(
		() => props.auth ?? new AdminAuthController({ initialBaseUrl: props.initialBaseUrl ?? "" }),
		[props.auth, props.initialBaseUrl],
	);
	const api = useMemo(() => props.api ?? new PublishingApi(), [props.api]);
	const controller = useMemo(
		() => props.controller ?? new PublishingController({ api, auth }),
		[props.controller, api, auth],
	);

	const snapshot = useSnapshot(controller);
	const [tokenInput, setTokenInput] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [detailTab, setDetailTab] = useState<DetailTab>("overview");
	const [pendingApp, setPendingApp] = useState<PublishedAppDetail | null>(null);
	const navigate = useCallback((path: string) => {
		if (window.location.pathname !== path) window.history.pushState(null, "", path);
	}, []);

	const isLocked = !snapshot.connected && snapshot.tenant === null;
	const submitConnect = useCallback(
		async (event: React.FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			if (tokenInput.trim() === "") return;
			setSubmitting(true);
			try {
				await controller.connect(tokenInput);
				setTokenInput("");
				const appId = publishingAppIdFromPath(window.location.pathname);
				if (appId !== null) controller.goDetail(appId, "overview");
			} catch {
				// Controller snapshot owns the sanitized error shown below.
			} finally {
				setSubmitting(false);
			}
		},
		[controller, tokenInput],
	);

	const onCreatePublished = useCallback(
		async (appId: string, _versionId: string) => {
			const detail = await api.getPublishedApp(appId);
			setPendingApp(detail);
			navigate(`/publishing/apps/${encodeURIComponent(appId)}`);
		},
		[api, navigate],
	);

	useEffect(() => {
		const onPopState = () => {
			if (!controller.getSnapshot().connected) return;
			setPendingApp(null);
			const appId = publishingAppIdFromPath(window.location.pathname);
			if (appId === null) controller.goApps();
			else controller.goDetail(appId, "overview");
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [controller]);

	const lockAll = useCallback(() => {
		setTokenInput("");
		setPendingApp(null);
		controller.lockAuth();
	}, [controller]);

	if (isLocked) {
		return (
			<div className="publishing-shell">
				<header className="publishing-header">
					<div className="brand">
						<span className="brand-mark" aria-hidden="true">
							P
						</span>
						<span>PUBLISHING CONSOLE</span>
					</div>
				</header>
				<main className="publishing-main">
					<div className="publishing-login">
						<h1>连接 Control Plane</h1>
						<p>
							输入 token 进入控制台。token 仅保留在内存，刷新页面或点击锁定后必须重新输入。 生产部署必须把
							`/publishing` 限制到内网 / VPN / 身份代理之后。
						</p>
						<form onSubmit={submitConnect}>
							<label>
								<span>Control Plane 地址</span>
								<input type="text" value={auth.getSnapshot().baseUrl} readOnly aria-readonly="true" />
							</label>
							<label>
								<span>Admin Token</span>
								<input
									type="password"
									value={tokenInput}
									onChange={(event) => setTokenInput(event.target.value)}
									autoComplete="off"
									placeholder="Bearer token"
								/>
							</label>
							{snapshot.detailError !== null ? <div className="error">{snapshot.detailError}</div> : null}
							<div className="actions">
								<button className="pub-btn primary" type="submit" disabled={submitting}>
									{submitting ? "连接中…" : "连接"}
								</button>
							</div>
						</form>
					</div>
				</main>
			</div>
		);
	}

	if (pendingApp !== null) {
		return (
			<div className="publishing-shell">
				<Header
					tenantName={snapshot.tenant?.name ?? ""}
					onLock={lockAll}
					onApps={() => {
						setPendingApp(null);
						navigate("/publishing");
						controller.goApps();
					}}
				/>
				<main className="publishing-main">
					<PublishSuccess app={pendingApp} onContinue={() => setPendingApp(null)} />
				</main>
			</div>
		);
	}

	return (
		<div className="publishing-shell">
			<Header
				tenantName={snapshot.tenant?.name ?? ""}
				onLock={lockAll}
				onApps={() => {
					navigate("/publishing");
					controller.goApps();
				}}
			/>
			<main className="publishing-main">
				{snapshot.page.kind === "apps" ? (
					<AppList
						controller={controller}
						onOpen={(appId) => {
							setDetailTab("overview");
							navigate(`/publishing/apps/${encodeURIComponent(appId)}`);
							controller.goDetail(appId, "overview");
						}}
						onCreate={() => void controller.goCreate()}
					/>
				) : null}
				{snapshot.page.kind === "apps-create" ? (
					<CreateAppWizard
						controller={controller}
						onCancel={() => {
							navigate("/publishing");
							controller.goApps();
						}}
						onPublished={onCreatePublished}
					/>
				) : null}
				{snapshot.page.kind === "app-detail" || snapshot.page.kind === "app-detail-tab" ? (
					<AppDetail
						controller={controller}
						appId={snapshot.page.kind === "app-detail" ? snapshot.page.appId : snapshot.page.appId}
						tab={snapshot.page.kind === "app-detail-tab" ? snapshot.page.tab : detailTab}
						setTab={(tab) => {
							setDetailTab(tab);
							if (snapshot.page.kind === "app-detail-tab") controller.goDetail(snapshot.page.appId, tab);
						}}
						onBack={() => {
							navigate("/publishing");
							controller.goApps();
						}}
					/>
				) : null}
			</main>
		</div>
	);
}

export function publishingAppIdFromPath(pathname: string): string | null {
	const match = pathname.match(/^\/publishing\/apps\/([^/]+)\/?$/);
	if (match?.[1] === undefined) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

function Header({
	tenantName,
	onLock,
	onApps,
}: {
	readonly tenantName: string;
	readonly onLock: () => void;
	readonly onApps: () => void;
}) {
	return (
		<header className="publishing-header">
			<div className="brand">
				<span className="brand-mark" aria-hidden="true">
					P
				</span>
				<span>PUBLISHING CONSOLE</span>
			</div>
			<nav>
				<button type="button" onClick={onApps}>
					App 列表
				</button>
			</nav>
			<span className="spacer" />
			<span className="tenant">tenant: {tenantName}</span>
			<button className="lock-btn" type="button" onClick={onLock} aria-label="锁定 / 清空内存 token">
				锁定
			</button>
		</header>
	);
}

function PublishSuccess({ app, onContinue }: { readonly app: PublishedAppDetail; readonly onContinue: () => void }) {
	const embedUrl = `${window.location.origin}/embed/${app.publicAppId}`;
	const iframe = `<iframe src="${embedUrl}" allow="microphone"></iframe>`;
	return (
		<div className="publish-success">
			<h1 style={{ margin: 0, fontSize: 22 }}>已发布 {app.name}</h1>
			<p style={{ color: "var(--pub-fg-muted)" }}>将以下 iframe 嵌入宿主即可访问。</p>
			<pre>{iframe}</pre>
			<div style={{ display: "flex", gap: 8, marginTop: 12 }}>
				<button className="pub-btn" type="button" onClick={() => void navigator.clipboard?.writeText(iframe)}>
					复制 iframe
				</button>
				<button className="pub-btn" type="button" onClick={() => void navigator.clipboard?.writeText(embedUrl)}>
					复制 Embed URL
				</button>
				<button className="pub-btn primary" type="button" onClick={onContinue}>
					继续
				</button>
			</div>
			<div className="banner" style={{ marginTop: 16 }}>
				<div>
					<strong>publicAppId</strong>: {app.publicAppId}
				</div>
				<div>
					<strong>当前版本</strong>: {app.currentVersion?.versionNumber ?? "—"}
				</div>
				<div>
					<strong>allowedOrigins</strong>: {app.allowedOrigins.length === 0 ? "—" : app.allowedOrigins.join(", ")}
				</div>
				<div>
					<strong>accessMode</strong>: {app.accessMode}
				</div>
			</div>
		</div>
	);
}

function useSnapshot(controller: PublishingController) {
	const [, force] = useState({});
	useEffect(() => controller.subscribe(() => force({})), [controller]);
	return controller.getSnapshot();
}

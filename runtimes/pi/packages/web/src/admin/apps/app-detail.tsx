import type {
	AgentDefinitionDetail,
	AgentDefinitionSummary,
	AgentPublicId,
	PublishedAppDetail,
	PublishedAppVersionSummary,
} from "@earendil-works/pi-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import menuStyles from "../action-menu.module.css";
import { AgentApi } from "../api/agent-api.ts";
import { AppApi } from "../api/app-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./app-detail.module.css";

type LoadState =
	| { kind: "loading" }
	| {
			kind: "ready";
			app: PublishedAppDetail | null;
			agents: readonly AgentDefinitionSummary[];
			versions: readonly PublishedAppVersionSummary[];
	  }
	| { kind: "error"; message: string };
const STATUS_LABEL = { draft: "草稿", active: "已上线", suspended: "已暂停", archived: "已归档" } as const;

function Icon({
	name,
}: {
	readonly name: "back" | "globe" | "user" | "lock" | "save" | "eye" | "upload";
}): React.ReactElement {
	const paths = {
		back: <path d="m15 18-6-6 6-6M9 12h12" />,
		globe: (
			<>
				<circle cx="12" cy="12" r="8.5" />
				<path d="M3.5 12h17M12 3.5c2.7 2.5 3.8 5.3 3.8 8.5S14.7 18 12 20.5C9.3 18 8.2 15.2 8.2 12S9.3 6 12 3.5Z" />
			</>
		),
		user: (
			<>
				<circle cx="12" cy="8" r="3.5" />
				<path d="M5.5 20c.4-4 2.5-6 6.5-6s6.1 2 6.5 6" />
			</>
		),
		lock: (
			<>
				<rect x="5.5" y="10" width="13" height="10" rx="2" />
				<path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3" />
			</>
		),
		save: (
			<>
				<path d="M5 3h12l2 2v16H5Z" />
				<path d="M8 3v6h8V3M8 21v-7h8v7" />
			</>
		),
		eye: (
			<>
				<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
				<circle cx="12" cy="12" r="2.5" />
			</>
		),
		upload: (
			<>
				<path d="M12 16V4m-4 4 4-4 4 4M5 14v6h14v-6" />
			</>
		),
	} as const;
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{paths[name]}
		</svg>
	);
}

function formatDate(value?: string): string {
	if (!value) return "—";
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(value));
}

export function AdminAppDetail({ appId }: { readonly appId?: string }): React.ReactElement {
	const isNew = appId === undefined;
	const { controller } = useAdminAuth();
	const appApi = useRef(new AppApi({ auth: controller })).current;
	const agentApi = useRef(new AgentApi({ auth: controller })).current;
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [agentId, setAgentId] = useState("");
	const [agentDetail, setAgentDetail] = useState<AgentDefinitionDetail | null>(null);
	const [accessMode, setAccessMode] = useState<"anonymous" | "signed_user">("anonymous");
	const [origins, setOrigins] = useState("");
	const [busy, setBusy] = useState(false);
	const [versionBusy, setVersionBusy] = useState<"create" | "preview" | "activate" | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const copyToClipboard = async (key: string, text: string): Promise<void> => {
		try {
			if (navigator.clipboard?.writeText !== undefined) {
				await navigator.clipboard.writeText(text);
			} else {
				const textarea = document.createElement("textarea");
				textarea.value = text;
				textarea.setAttribute("readonly", "");
				textarea.style.position = "absolute";
				textarea.style.left = "-9999px";
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand("copy");
				document.body.removeChild(textarea);
			}
			setCopiedKey(key);
			window.setTimeout(() => {
				setCopiedKey((current) => (current === key ? null : current));
			}, 1500);
		} catch {
			// Clipboard is best-effort; the row still shows the full text.
		}
	};
	useEffect(() => {
		void Promise.all([
			agentApi.listAgents({ limit: 100 }),
			appId ? appApi.getPublishedApp(appId) : Promise.resolve(null),
			appId ? appApi.listVersions(appId, { limit: 100 }) : Promise.resolve({ items: [], nextCursor: null }),
		]).then(
			([agents, app, versions]) => {
				setState({ kind: "ready", app, agents: agents.items, versions: versions.items });
				if (app) {
					setName(app.name);
					setAgentId(app.sourceAgent.id);
					setAccessMode(app.accessMode === "signed_user" ? "signed_user" : "anonymous");
					setOrigins(app.allowedOrigins.join(", "));
				} else if (agents.items[0]) setAgentId(agents.items[0].id);
			},
			(caught: Error) => setState({ kind: "error", message: caught.message }),
		);
	}, [agentApi, appApi, appId]);
	useEffect(() => {
		if (!agentId) {
			setAgentDetail(null);
			return;
		}
		void agentApi.getAgentDetail(agentId as AgentPublicId).then(setAgentDetail, () => setAgentDetail(null));
	}, [agentApi, agentId]);
	const app = state.kind === "ready" ? state.app : null;
	const versions = state.kind === "ready" ? state.versions : [];
	const pendingReadyVersion = versions.find((version) => version.status === "ready" && !version.isCurrent) ?? null;
	const allowedOrigins = useMemo(
		() =>
			origins
				.split(/[,\n]/)
				.map((item) => item.trim())
				.filter(Boolean),
		[origins],
	);
	const save = async () => {
		if (!isNew) {
			setError("当前 Control API 暂不支持修改已有应用配置");
			return;
		}
		if (!name.trim() || !agentId) {
			setError("请填写应用名称并选择 Agent");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const created = await appApi.createPublishedApp({
				name: name.trim(),
				agentDefinitionId: agentId,
				accessMode,
				allowedOrigins,
			});
			navigate(`/apps/${created.id}`);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		if (!appId || !app) return;
		const confirmation = window.prompt(`删除应用后将无法继续访问。请输入应用名称“${app.name}”确认删除：`);
		if (confirmation === null) return;
		if (confirmation !== app.name) {
			setError("输入的应用名称不匹配，未执行删除");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await appApi.deletePublishedApp(appId, confirmation);
			navigate("/apps");
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	};
	const refreshApp = async (): Promise<void> => {
		if (!appId || state.kind !== "ready") return;
		const [nextApp, nextVersions] = await Promise.all([
			appApi.getPublishedApp(appId),
			appApi.listVersions(appId, { limit: 100 }),
		]);
		setState({ kind: "ready", app: nextApp, agents: state.agents, versions: nextVersions.items });
	};
	const createVersion = async (): Promise<void> => {
		if (!appId || !agentDetail || versionBusy !== null) return;
		setVersionBusy("create");
		setError(null);
		try {
			await appApi.createVersion({ appId, sourceAgentRevision: agentDetail.currentRevision });
			await refreshApp();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setVersionBusy(null);
		}
	};
	const preview = async (): Promise<void> => {
		if (!appId || !app || !agentId || versionBusy !== null) return;
		// Open the popup synchronously: browsers block popups that are opened
		// after an `await` boundary.
		const popup = window.open("about:blank", "_blank", "popup,width=1100,height=760");
		if (popup === null) {
			setError("浏览器阻止了预览窗口，请允许此站点打开弹窗后重试");
			return;
		}
		setVersionBusy("preview");
		setError(null);
		try {
			// Re-fetch the Agent detail so we pin the preview to the latest saved
			// revision. `agentDetail` captured in the component state may be stale
			// (the user saved the agent in another tab, or `useEffect` didn't
			// re-run on re-entry), and creating a version off a stale revision
			// silently captures the old `newConversations` toggle value.
			const latestAgent = await agentApi.getAgentDetail(agentId as AgentPublicId);
			setAgentDetail(latestAgent);
			// Find-or-create a ready version compiled from the latest agent
			// revision. Without this, preview would pin to whichever pending
			// version happened to be the newest (possibly compiled before the
			// user's latest save) and the preview's features (e.g.
			// `newConversations`) would not reflect the agent's current state.
			const readyForLatest =
				state.kind === "ready"
					? state.versions.find(
							(version) =>
								version.status === "ready" &&
								version.sourceAgentRevision === latestAgent.currentRevision,
						)
					: undefined;
			let versionId: string;
			if (readyForLatest !== undefined) {
				versionId = readyForLatest.id;
			} else {
				const created = await appApi.createVersion({
					appId,
					sourceAgentRevision: latestAgent.currentRevision,
				});
				versionId = created.version.id;
				await refreshApp();
			}
			const ticket = await appApi.createPreviewTicket({ appId, versionId });
			const previewOrigin = new URL(ticket.previewUrl).origin;
			let ticketSent = false;
			const onMessage = (event: MessageEvent<unknown>): void => {
				if (event.source !== popup || event.origin !== previewOrigin) return;
				const message = event.data as { type?: unknown; publicAppId?: unknown } | null;
				if (message?.type !== "pi-preview-ready" || message.publicAppId !== app.publicAppId) return;
				if (ticketSent) return;
				ticketSent = true;
				popup.postMessage(
					{ type: "pi-preview-ticket", publicAppId: app.publicAppId, ticket: ticket.ticket },
					previewOrigin,
				);
				window.removeEventListener("message", onMessage);
			};
			window.addEventListener("message", onMessage);
			window.setTimeout(() => {
				window.removeEventListener("message", onMessage);
			}, 10_000);
			// `window.name` survives the initial about:blank -> preview navigation.
			// It is an in-memory bootstrap fallback for browsers that sever or delay
			// `window.opener`; PreviewBootstrap clears it before exchanging the ticket.
			popup.name = `pi-preview:${JSON.stringify({ publicAppId: app.publicAppId, ticket: ticket.ticket })}`;
			popup.location.replace(ticket.previewUrl);
		} catch (caught) {
			popup.close();
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setVersionBusy(null);
		}
	};
	const activate = async (): Promise<void> => {
		if (!appId || !pendingReadyVersion || versionBusy !== null) return;
		setVersionBusy("activate");
		setError(null);
		try {
			await appApi.activateVersion({ appId, versionId: pendingReadyVersion.id });
			await refreshApp();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setVersionBusy(null);
		}
	};
	if (state.kind === "loading") return <div className={styles.loading}>正在加载应用详情…</div>;
	if (state.kind === "error")
		return (
			<div className={styles.loading} role="alert">
				加载失败：{state.message}
			</div>
		);
	const status = app?.status ?? "draft";
	return (
		<main className={styles.page}>
			<button className={styles.back} type="button" onClick={() => navigate("/apps")}>
				<Icon name="back" />
				返回应用列表
			</button>
			<header className={styles.header}>
				<div>
					<span>
						<h1>{isNew ? "创建应用" : "应用详情"}</h1>
						<b className={styles.status}>{STATUS_LABEL[status]}</b>
					</span>
					<p>编辑应用信息、访问配置并发布到应用市场。</p>
				</div>
				<div className={menuStyles.anchor}>
					<button
						type="button"
						className={styles.more}
						onClick={() => setMenuOpen((open) => !open)}
						aria-expanded={menuOpen}
						aria-haspopup="menu"
					>
						•••
					</button>
					{menuOpen ? (
						<div className={menuStyles.menu} role="menu">
							<button
								type="button"
								role="menuitem"
								disabled={isNew || busy}
								onClick={() => {
									setMenuOpen(false);
									void remove();
								}}
							>
								删除应用
							</button>
						</div>
					) : null}
				</div>
			</header>
			<div className={styles.layout}>
				<form
					className={styles.form}
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<section>
						<h2>1.　基本信息</h2>
						<label>
							应用名称 <em>*</em>
							<div className={styles.field}>
								<input value={name} maxLength={100} onChange={(event) => setName(event.currentTarget.value)} />
								<small>{name.length} / 100</small>
							</div>
						</label>
						<label>
							应用描述
							<div className={styles.field}>
								<textarea
									value={description}
									maxLength={300}
									onChange={(event) => setDescription(event.currentTarget.value)}
								/>
								<small>{description.length} / 300</small>
							</div>
						</label>
					</section>
					<section>
						<h2>2.　Agent</h2>
						<label>
							选择 Agent <em>*</em>
							<select value={agentId} onChange={(event) => setAgentId(event.currentTarget.value)}>
								<option value="">请选择 Agent</option>
								{state.agents.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
							</select>
						</label>
						{agentDetail ? (
							<div className={styles.agentCard}>
								<span className={styles.agentIcon}>
									<Icon name="globe" />
								</span>
								<div>
									<b>{agentDetail.name}</b>
									<p>
										模型：　{agentDetail.modelId ?? "未配置"}　　　　更新时间：　
										{formatDate(agentDetail.updatedAt)}
									</p>
								</div>
								<i>v{agentDetail.currentRevision}</i>
							</div>
						) : null}
					</section>
					<section>
						<h2>3.　访问配置</h2>
						<label htmlFor="access-anonymous">
							访问方式 <em>*</em>
						</label>
						<div className={styles.accessChoices}>
							<button
								id="access-anonymous"
								type="button"
								className={accessMode === "anonymous" ? styles.selected : ""}
								onClick={() => setAccessMode("anonymous")}
							>
								<i />
								<Icon name="user" />
								<span>
									<b>匿名访问</b>
									<small>任何人获得链接后即可访问应用</small>
								</span>
							</button>
							<button
								type="button"
								className={accessMode === "signed_user" ? styles.selected : ""}
								onClick={() => setAccessMode("signed_user")}
							>
								<i />
								<Icon name="lock" />
								<span>
									<b>登录用户访问</b>
									<small>仅登录系统的用户可以访问应用</small>
								</span>
							</button>
						</div>
						<label>
							允许访问的域名
							<div className={styles.field}>
								<input
									value={origins}
									onChange={(event) => setOrigins(event.currentTarget.value)}
									placeholder="输入域名，多个域名用回车分隔"
								/>
								<small>{allowedOrigins.length} / 20</small>
							</div>
							<span className={styles.hint}>例： example.com，*.example.com</span>
						</label>
					</section>
				</form>
				<aside className={styles.summary}>
					<h2>发布摘要</h2>
					<div className={styles.summaryStatus}>
						当前状态　 <i /> {STATUS_LABEL[status]}
					</div>
					<section>
						<h3>应用信息</h3>
						<small>应用名称</small>
						<b>{name || "—"}</b>
						<small>应用描述</small>
						<p>{description || "—"}</p>
					</section>
					<section>
						<h3>Agent</h3>
						{agentDetail ? (
							<>
								<div className={styles.summaryAgent}>
									<Icon name="globe" />
									<b>{agentDetail.name}</b>
									<i>v{agentDetail.currentRevision}</i>
								</div>
								<p>模型：　{agentDetail.modelId ?? "未配置"}</p>
								<p>更新时间：　{formatDate(agentDetail.updatedAt)}</p>
							</>
						) : (
							<p>尚未选择</p>
						)}
					</section>
					<section>
						<h3>访问配置</h3>
						<small>访问方式</small>
						<p>
							<Icon name={accessMode === "anonymous" ? "user" : "lock"} />
							{accessMode === "anonymous" ? "匿名访问" : "登录用户访问"}
						</p>
						<small>允许访问的域名</small>
						<p>{allowedOrigins.length ? allowedOrigins.join("、") : "—"}</p>
					</section>
					<section>
						<h3>版本与时间</h3>
						<div className={styles.version}>
							<span>
								<small>线上版本</small>
								<b>{app?.currentVersion ? `v${app.currentVersion.versionNumber}` : "—"}</b>
							</span>
							<span>
								<small>更新时间</small>
								<b>{formatDate(app?.updatedAt)}</b>
							</span>
						</div>
					</section>
					{app !== null && (app.status === "active" || app.status === "suspended") ? (
						<section>
							<h3>接入 / Embed</h3>
							{(() => {
								// In dev the admin and embed are served from the same
								// origin; for split-host deployments the embed base URL
								// should be set via a config in the future.
								const origin =
									typeof window !== "undefined" ? window.location.origin : "";
								const embedUrl = buildEmbedUrl(origin, app.publicAppId);
								const iframeSnippet = buildIframeSnippet(origin, app.publicAppId);
								const sdkSnippet = buildSdkSnippet(origin, app.publicAppId);
								return (
									<div className={styles.connection}>
										<div className={styles.connectionRow}>
											<code title={embedUrl}>{embedUrl}</code>
											<button
												type="button"
												className={`${styles.connectionCopy}${copiedKey === "url" ? ` ${styles["is-copied"]}` : ""}`}
												onClick={() => void copyToClipboard("url", embedUrl)}
											>
												{copiedKey === "url" ? "已复制" : "复制链接"}
											</button>
										</div>
										<div className={styles.connectionBlock}>
											<small>Iframe 嵌入</small>
											<div className={styles.connectionCode}>
												<pre>{iframeSnippet}</pre>
												<button
													type="button"
													className={`${styles.connectionCopy}${copiedKey === "iframe" ? ` ${styles["is-copied"]}` : ""}`}
													onClick={() => void copyToClipboard("iframe", iframeSnippet)}
												>
													{copiedKey === "iframe" ? "已复制" : "复制"}
												</button>
											</div>
										</div>
										<div className={styles.connectionBlock}>
											<small>SDK 挂载</small>
											<div className={styles.connectionCode}>
												<pre>{sdkSnippet}</pre>
												<button
													type="button"
													className={`${styles.connectionCopy}${copiedKey === "sdk" ? ` ${styles["is-copied"]}` : ""}`}
													onClick={() => void copyToClipboard("sdk", sdkSnippet)}
												>
													{copiedKey === "sdk" ? "已复制" : "复制"}
												</button>
											</div>
										</div>
										{app.accessMode === "signed_user" || app.accessMode === "mixed" ? (
											<p className={styles.note}>
												登录访问还需要 Launch Key，前往"Launch Keys"页签签发。
											</p>
										) : null}
									</div>
								);
							})()}
						</section>
					) : null}
					<button type="button" className={styles.save} disabled={busy} onClick={() => void save()}>
						<Icon name="save" />
						{busy ? "正在保存…" : "保存配置"}
					</button>
					<div className={styles.actions}>
						<button
							type="button"
							disabled={isNew || !agentDetail || versionBusy !== null}
							onClick={() => void createVersion()}
						>
							<Icon name="save" />
							{versionBusy === "create" ? "创建中…" : versions.length === 0 ? "创建第一个版本" : "创建新版本"}
						</button>
						<button
							type="button"
							disabled={!agentDetail || versionBusy !== null}
							onClick={() => void preview()}
						>
							<Icon name="eye" />
							{versionBusy === "preview" ? "打开中…" : "预览"}
						</button>
						<button
							type="button"
							disabled={!pendingReadyVersion || versionBusy !== null}
							onClick={() => void activate()}
						>
							<Icon name="upload" />
							{versionBusy === "activate" ? "上线中…" : "上线"}
						</button>
					</div>
					{error ? <p className={styles.error}>{error}</p> : null}
				</aside>
			</div>
		</main>
	);
}

/** Build the public embed URL for a PublishedApp. Used by the app-detail "接入" section. */
export function buildEmbedUrl(origin: string, publicAppId: string): string {
	return `${origin.replace(/\/+$/, "")}/embed/${publicAppId}`;
}

export function buildIframeSnippet(origin: string, publicAppId: string): string {
	return `<iframe\n  src="${buildEmbedUrl(origin, publicAppId)}"\n  width="100%"\n  height="640"\n  allow="microphone; camera"\n  referrerpolicy="origin"\n  title="Pi Embed ${publicAppId}"\n></iframe>`;
}

export function buildSdkSnippet(origin: string, publicAppId: string): string {
	return `import { createClient } from "@earendil-works/pi-embed-sdk";\n\nconst client = createClient({ publicAppId: "${publicAppId}", origin: "${origin}" });\nclient.mount("#host");`;
}

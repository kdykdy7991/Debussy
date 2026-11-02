/**
 * Publish drawer（P2 one-click publish）。
 *
 * 发布始终使用 Agent 最新 Revision；用户只选择对外访问模式。
 * 发布目标由服务端按 Agent 和访问模式解析。
 *
 * 草稿未保存时禁用发布并明示原因。
 */
import type { AgentDefinitionAssociatedApp, AgentPublicId, AgentPublishResponse } from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState } from "react";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { AuroraButton } from "../aurora/index.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import styles from "./publish-drawer.module.css";

export type PublishDrawerMode = "closed" | "open";

export interface PublishDrawerProps {
	readonly agentId: AgentPublicId;
	readonly apps: readonly AgentDefinitionAssociatedApp[];
	readonly appsLoading: boolean;
	readonly appsError?: string;
	readonly onReloadApps: () => void;
	readonly hasDraft: boolean;
	readonly mode: PublishDrawerMode;
	readonly onClose: () => void;
	readonly onPublished: () => void;
}

type Step = "confirm" | "done" | "error";

export function PublishDrawer({
	agentId,
	apps,
	appsLoading,
	appsError,
	onReloadApps,
	hasDraft,
	mode,
	onClose,
	onPublished,
}: PublishDrawerProps): React.ReactElement | null {
	const { controller } = useAdminAuth();
	const agentApi = useRef(new AgentApi({ auth: controller })).current;

	const [step, setStep] = useState<Step>("confirm");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [published, setPublished] = useState<AgentPublishResponse | null>(null);
	const [accessMode, setAccessMode] = useState<"anonymous" | "signed_user" | "trusted_app">("anonymous");
	const [origin, setOrigin] = useState("");
	const [issuer, setIssuer] = useState("");
	const [keyId, setKeyId] = useState("");
	const [publicKeyPem, setPublicKeyPem] = useState("");
	const [trustedName, setTrustedName] = useState("");
	const [trustedSecret, setTrustedSecret] = useState<{
		readonly clientId: string;
		readonly clientSecret: string;
	} | null>(null);
	const [trustedBusy, setTrustedBusy] = useState(false);
	const [trustedSystemsLoading, setTrustedSystemsLoading] = useState(false);
	const [trustedSystemsError, setTrustedSystemsError] = useState(false);
	const originEdited = useRef(false);
	const nameEdited = useRef(false);
	const modeEdited = useRef(false);
	const [trustedSystems, setTrustedSystems] = useState<
		readonly {
			readonly id: string;
			readonly name: string;
			readonly client_id: string;
			readonly enabled: boolean;
			readonly allowed_origins: readonly string[];
			readonly published_app_id: string;
		}[]
	>([]);

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
			previousInert.forEach(({ node }) => {
				node.removeAttribute("inert");
			});
			lastFocusedRef.current?.focus();
		};
	}, [mode, onClose]);

	useEffect(() => {
		if (mode !== "open") {
			setTrustedSecret(null);
			return;
		}
		if (mode === "open") {
			originEdited.current = false;
			nameEdited.current = false;
			modeEdited.current = false;
			setStep("confirm");
			setError(null);
			setPublished(null);
			setIssuer("");
			setKeyId("");
			setPublicKeyPem("");
			setTrustedName("");
			setTrustedSecret(null);
			setTrustedSystems([]);
			setTrustedSystemsLoading(true);
			setTrustedSystemsError(false);
			void agentApi
				.listTrustedSystems()
				.then(setTrustedSystems)
				.catch(() => setTrustedSystemsError(true))
				.finally(() => setTrustedSystemsLoading(false));
		}
	}, [mode, agentApi]);

	const latestTrustedApp = [...apps]
		.filter((app) => app.accessMode === "trusted_app" && app.status === "active")
		.sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""))[0];
	const existingTrustedSystem = trustedSystems.find(
		(system) => system.published_app_id === latestTrustedApp?.appId.slice(4),
	);

	useEffect(() => {
		if (mode !== "open") return;
		const latest = [...apps]
			.filter((app) => app.status === "active")
			.sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""))[0];
		if (!modeEdited.current) {
			setAccessMode(
				latest?.accessMode === "signed_user" || latest?.accessMode === "trusted_app"
					? latest.accessMode
					: "anonymous",
			);
		}
		if (!originEdited.current) {
			setOrigin(
				(latestTrustedApp?.allowedOrigins ?? latest?.allowedOrigins ?? []).join("\n") ||
					window.localStorage.getItem(`agent-publish:${agentId}:origins`) ||
					"",
			);
		}
		if (!nameEdited.current) {
			setTrustedName(
				existingTrustedSystem?.name ?? window.localStorage.getItem(`agent-publish:${agentId}:name`) ?? "",
			);
		}
	}, [mode, apps, latestTrustedApp, existingTrustedSystem, agentId]);

	const signedExists = apps.some((app) => app.accessMode === "signed_user" && app.launchKeyConfigured);
	const trustedExists = apps.some((app) => app.accessMode === "trusted_app");

	const doPublish = async () => {
		if (
			hasDraft ||
			appsLoading ||
			appsError ||
			(accessMode === "trusted_app" && (trustedSystemsLoading || trustedSystemsError))
		)
			return;
		setBusy(true);
		setError(null);
		try {
			const allowedOrigins = origin
				.split(/[\n,]+/)
				.map((value) => value.trim())
				.filter(Boolean);
			const result = await agentApi.publishAgent(agentId, {
				accessMode,
				...((accessMode === "signed_user" && !signedExists) ||
				(accessMode === "trusted_app" && allowedOrigins.length > 0)
					? { allowedOrigins }
					: {}),
				...(accessMode === "signed_user" && !signedExists
					? { signedIdentity: { issuer: issuer.trim(), keyId: keyId.trim(), publicKeyPem: publicKeyPem.trim() } }
					: {}),
			});
			setPublished(result);
			if (accessMode === "trusted_app" && existingTrustedSystem !== undefined) {
				try {
					await agentApi.updateTrustedSystem(existingTrustedSystem.client_id, "update", {
						name: trustedName.trim(),
						allowedOrigins,
					});
					setTrustedSystems(await agentApi.listTrustedSystems());
				} catch (err) {
					setError(`Agent 已发布，但宿主配置保存失败：${err instanceof Error ? err.message : String(err)}`);
				}
			}
			setStep("done");
		} catch (err) {
			setError(err instanceof AgentApiError ? err.message : err instanceof Error ? err.message : String(err));
			setStep("error");
		} finally {
			setBusy(false);
		}
	};

	const createTrusted = async () => {
		if (published === null || !trustedName.trim() || !origin.trim()) return;
		setTrustedBusy(true);
		setError(null);
		try {
			const result = await agentApi.createTrustedSystem({
				publicAppId: published.publishedApp.publicAppId,
				name: trustedName.trim(),
				allowedOrigins: origin
					.split(/[\n,]+/)
					.map((value) => value.trim())
					.filter(Boolean),
			});
			setTrustedSecret(result);
			setTrustedSystems(await agentApi.listTrustedSystems());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTrustedBusy(false);
		}
	};

	const updateTrusted = async (clientId: string, action: "rotate" | "enable" | "disable") => {
		setTrustedBusy(true);
		setError(null);
		try {
			const result = await agentApi.updateTrustedSystem(clientId, action);
			if (result.clientSecret !== undefined) setTrustedSecret({ clientId, clientSecret: result.clientSecret });
			setTrustedSystems(await agentApi.listTrustedSystems());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTrustedBusy(false);
		}
	};

	const retryTrustedConfiguration = async () => {
		if (existingTrustedSystem === undefined) return;
		setTrustedBusy(true);
		try {
			await agentApi.updateTrustedSystem(existingTrustedSystem.client_id, "update", {
				name: trustedName.trim(),
				allowedOrigins: origin
					.split(/[\n,]+/)
					.map((value) => value.trim())
					.filter(Boolean),
			});
			setTrustedSystems(await agentApi.listTrustedSystems());
			setError(null);
		} catch (err) {
			setError(`宿主配置保存失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setTrustedBusy(false);
		}
	};

	if (mode !== "open") return null;

	const blockedByDraft = hasDraft;
	const selectedAccessMode = accessMode;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape and explicit close actions provide keyboard access; this handler only supports backdrop clicks.
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
				aria-label="发布 Agent"
				tabIndex={-1}
			>
				<header className={styles.drawerHeader}>
					<h2>发布 Agent</h2>
					<p className={styles.drawerSubtitle}>
						<span>当前 Agent</span>
						<span className={styles.drawerSubtitle__hint}>
							将当前最新 Revision 一键发布为线上版本，立即对外可访问。
						</span>
					</p>
				</header>

				{blockedByDraft ? (
					<div className={`${styles.banner} ${styles.warning}`} role="alert">
						Agent 存在未保存的草稿。请先保存为新 Revision，再发布。
					</div>
				) : null}
				{appsLoading ? <div className={`${styles.banner} ${styles.warning}`}>正在加载发布配置…</div> : null}
				{accessMode === "trusted_app" && trustedSystemsLoading ? (
					<div className={`${styles.banner} ${styles.warning}`}>正在加载受信任系统…</div>
				) : null}
				{accessMode === "trusted_app" && trustedSystemsError ? (
					<div className={`${styles.banner} ${styles.error}`} role="alert">
						加载受信任系统失败，请关闭后重新打开发布配置。
					</div>
				) : null}
				{appsError ? (
					<div className={`${styles.banner} ${styles.error}`} role="alert">
						加载发布配置失败：{appsError}{" "}
						<button type="button" onClick={onReloadApps}>
							重试
						</button>
					</div>
				) : null}

				{step === "confirm" ? (
					<div className={styles.drawerStep}>
						<label className={styles.field}>
							访问模式
							<select
								value={accessMode}
								onChange={(event) => {
									modeEdited.current = true;
									setAccessMode(event.currentTarget.value as typeof accessMode);
								}}
							>
								<option value="anonymous">匿名访客</option>
								<option value="signed_user">签名用户</option>
								<option value="trusted_app">受信任系统</option>
							</select>
						</label>
						{(accessMode === "signed_user" && !signedExists) || accessMode === "trusted_app" ? (
							<>
								<label className={styles.field}>
									宿主页面来源（Origin，每行一个）
									<textarea
										value={origin}
										onChange={(event) => {
											originEdited.current = true;
											setOrigin(event.currentTarget.value);
											window.localStorage.setItem(
												`agent-publish:${agentId}:origins`,
												event.currentTarget.value,
											);
										}}
										rows={2}
										placeholder={"http://127.0.0.1:5173\nhttp://127.0.0.1:8003"}
									/>
								</label>
								{accessMode === "trusted_app" ? (
									<label className={styles.field}>
										宿主系统名称
										<input
											value={trustedName}
											onChange={(event) => {
												nameEdited.current = true;
												setTrustedName(event.currentTarget.value);
												window.localStorage.setItem(
													`agent-publish:${agentId}:name`,
													event.currentTarget.value,
												);
											}}
											placeholder="客服工单系统"
										/>
									</label>
								) : null}
								{accessMode === "signed_user" ? (
									<>
										<label className={styles.field}>
											签发方（issuer）
											<input
												value={issuer}
												onChange={(event) => setIssuer(event.currentTarget.value)}
												placeholder="ticket-system"
											/>
										</label>
										<label className={styles.field}>
											公钥 ID（kid）
											<input
												value={keyId}
												onChange={(event) => setKeyId(event.currentTarget.value)}
												placeholder="ticket-key-1"
											/>
										</label>
										<label className={styles.field}>
											Ed25519 公钥（SPKI PEM）
											<textarea
												value={publicKeyPem}
												onChange={(event) => setPublicKeyPem(event.currentTarget.value)}
												rows={5}
												placeholder="-----BEGIN PUBLIC KEY-----"
											/>
										</label>
									</>
								) : null}
							</>
						) : null}
						{accessMode === "signed_user" ? (
							<p className={styles.confirmText}>
								宿主后端保管私钥并为登录用户签发短期 Launch Token。Debussy 需先将 issuer 加入
								PI_EMBED_LAUNCH_TOKEN_ALLOWED_ISSUERS 并重启；这里只登记公钥，Origin 本身不构成签名。 算法固定为
								EdDSA（Ed25519），Audience 默认是 skdy-embed。 首次发布会生成新的访问链接，原匿名链接保留。
							</p>
						) : null}
						{accessMode === "trusted_app" ? (
							<p className={styles.confirmText}>
								发布后为此 Agent 配置受信任系统，宿主后端用独立密钥换取一次性 code，再通过 iframe
								消息传入。无需公钥或重启。
							</p>
						) : null}
						{accessMode === "trusted_app" && trustedExists ? (
							<div className={styles.drawerStep}>
								<h3>受信任系统</h3>
								{trustedSystems
									.filter(
										(system) =>
											system.published_app_id ===
											apps.find((app) => app.accessMode === "trusted_app")?.appId.slice(4),
									)
									.map((system) => (
										<div key={system.id}>
											<p>
												{system.name} · {system.client_id} · {system.enabled ? "已启用" : "已停用"}
											</p>
											<button
												type="button"
												disabled={trustedBusy}
												onClick={() => void updateTrusted(system.client_id, "rotate")}
											>
												重新生成密钥
											</button>{" "}
											<button
												type="button"
												disabled={trustedBusy}
												onClick={() =>
													void updateTrusted(system.client_id, system.enabled ? "disable" : "enable")
												}
											>
												{system.enabled ? "停用" : "启用"}
											</button>
										</div>
									))}
								{trustedSecret !== null ? (
									<p>
										新 Client Secret（仅显示一次）：<code>{trustedSecret.clientSecret}</code>
									</p>
								) : null}
							</div>
						) : null}
						<p className={styles.confirmText}>
							发布后将把 Agent 的最新 Revision 编译为不可变版本。匿名与签名用户使用各自的访问链接，旧会话保留。
						</p>
						{error !== null ? (
							<div className={`${styles.banner} ${styles.error}`} role="alert">
								{error}
							</div>
						) : null}
						<div className={styles.drawerActions}>
							<AuroraButton
								variant="primary"
								size="md"
								disabled={
									busy ||
									blockedByDraft ||
									appsLoading ||
									!!appsError ||
									(accessMode === "trusted_app" && (trustedSystemsLoading || trustedSystemsError)) ||
									(accessMode === "signed_user" &&
										!signedExists &&
										(!origin.trim() || !issuer.trim() || !keyId.trim() || !publicKeyPem.trim())) ||
									(accessMode === "trusted_app" && (!origin.trim() || !trustedName.trim()))
								}
								onClick={doPublish}
							>
								{busy ? "发布中…" : "发布"}
							</AuroraButton>
							<AuroraButton variant="default" size="md" onClick={onClose}>
								取消
							</AuroraButton>
						</div>
					</div>
				) : null}

				{step === "done" && published !== null ? (
					<div className={styles.drawerStep} data-step="done">
						<h3>已发布</h3>
						<p>
							Revision #{published.agentRevision} 已编译为版本 #{published.version.versionNumber}
							并设为当前线上版本。
						</p>
						<p>
							对外访问：
							<a className={styles.link} href={published.embedUrl} target="_blank" rel="noreferrer">
								{published.embedUrl}
							</a>
						</p>
						{selectedAccessMode === "signed_user" ? (
							<p>签名用户访问需由已配置签发密钥的宿主页面传入 Launch Token 后打开。</p>
						) : null}
						{selectedAccessMode === "trusted_app" ? (
							<p>
								{existingTrustedSystem === undefined
									? "下一步签发 Client ID 和 Secret，交给宿主后端保存。"
									: error === null
										? "已保留现有 Client ID 和密钥，宿主配置已更新。"
										: "已保留现有 Client ID 和密钥。"}
							</p>
						) : null}
						{selectedAccessMode === "trusted_app" ? (
							<div className={styles.drawerStep}>
								<p>
									宿主系统：{trustedName} · 来源：
									{origin
										.split(/[\n,]+/)
										.filter(Boolean)
										.join("、")}
								</p>
								{existingTrustedSystem === undefined && trustedSecret === null ? (
									<AuroraButton
										variant="primary"
										size="md"
										disabled={trustedBusy || !trustedName.trim() || !origin.trim()}
										onClick={() => void createTrusted()}
									>
										{trustedBusy ? "签发中…" : "签发接入密钥"}
									</AuroraButton>
								) : trustedSecret !== null ? (
									<div>
										<p>
											Client ID：<code>{trustedSecret.clientId}</code>
										</p>
										<p>
											Client Secret（仅显示一次）：<code>{trustedSecret.clientSecret}</code>
										</p>
										<p>请立即保存到宿主后端。此页面关闭后无法再次查看；可以重新生成。</p>
									</div>
								) : (
									<p>
										Client ID：<code>{existingTrustedSystem?.client_id}</code>
									</p>
								)}
								{error !== null ? <p role="alert">{error}</p> : null}
								{error !== null && existingTrustedSystem !== undefined ? (
									<AuroraButton
										variant="default"
										size="md"
										disabled={trustedBusy}
										onClick={() => void retryTrustedConfiguration()}
									>
										{trustedBusy ? "保存中…" : "重试保存宿主配置"}
									</AuroraButton>
								) : null}
							</div>
						) : null}
						<div className={styles.drawerActions}>
							{selectedAccessMode === "anonymous" ? (
								<AuroraButton
									variant="primary"
									size="md"
									onClick={() => {
										onPublished();
										window.open(published.embedUrl, "_blank", "noopener,noreferrer");
									}}
								>
									打开 Public Chat
								</AuroraButton>
							) : null}
							<AuroraButton variant="default" size="md" onClick={onPublished}>
								关闭
							</AuroraButton>
						</div>
					</div>
				) : null}

				{step === "error" ? (
					<div className={styles.drawerStep}>
						<h3>发布失败</h3>
						<p className={`${styles.banner} ${styles.error}`} role="alert">
							{error}
						</p>
						<div className={styles.drawerActions}>
							<AuroraButton variant="primary" size="md" disabled={busy || blockedByDraft} onClick={doPublish}>
								重试发布
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

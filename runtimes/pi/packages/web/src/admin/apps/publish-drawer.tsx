/**
 * Publish drawer（P2 one-click publish）。
 *
 * P2 语义：发布 = 一键调用 `publishAgent(agentId)`。服务端解析 Agent 的
 * 「当前最新 Revision」→ 编译 RuntimeSpec → 复用/创建内部 published_app →
 * 创建并激活版本。用户不再选择 Application / Agent Revision，也不再有
 * 手动 create version / activate 的流程。Application / published_app 仍是
 * 内部实现，不暴露给用户。
 *
 * 草稿未保存时禁用发布并明示原因。
 */
import type { AgentPublicId, AgentPublishResponse } from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState } from "react";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { AuroraButton } from "../aurora/index.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import styles from "./publish-drawer.module.css";

export type PublishDrawerMode = "closed" | "open";

export interface PublishDrawerProps {
	readonly agentId: AgentPublicId;
	readonly hasDraft: boolean;
	readonly mode: PublishDrawerMode;
	readonly onClose: () => void;
	readonly onPublished: () => void;
}

type Step = "confirm" | "done" | "error";

export function PublishDrawer({
	agentId,
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
		if (mode === "open") {
			setStep("confirm");
			setError(null);
			setPublished(null);
		}
	}, [mode]);

	const doPublish = async () => {
		if (hasDraft) return;
		setBusy(true);
		setError(null);
		try {
			const result = await agentApi.publishAgent(agentId);
			setPublished(result);
			setStep("done");
		} catch (err) {
			setError(err instanceof AgentApiError ? err.message : err instanceof Error ? err.message : String(err));
			setStep("error");
		} finally {
			setBusy(false);
		}
	};

	if (mode !== "open") return null;

	const blockedByDraft = hasDraft;

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

				{step === "confirm" ? (
					<div className={styles.drawerStep}>
						<p className={styles.confirmText}>
							发布后将把 Agent 的最新 Revision 编译为不可变版本并立即上线。旧会话会保留， 对外继续通过新版本的
							Public Chat 访问。
						</p>
						{error !== null ? (
							<div className={`${styles.banner} ${styles.error}`} role="alert">
								{error}
							</div>
						) : null}
						<div className={styles.drawerActions}>
							<AuroraButton variant="primary" size="md" disabled={busy || blockedByDraft} onClick={doPublish}>
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
						<div className={styles.drawerActions}>
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

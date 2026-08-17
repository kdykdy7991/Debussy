/**
 * Embed Web 入口（WB-001 / 规格 10.2、10.3、16；WB-005 预览）。
 *
 * 部署目标 `agent.example.com`；仅服务企业网站嵌入对话与管理员预览。
 * **严禁** import `src/publishing/`、`src/admin/`、`src/lib/` 或 Control API。
 *
 * 路由：
 *
 * - `/embed/:publicAppId` 走 EmbedApp，匿名或 signed_user 模式由 Embed 内部自决
 * - `/preview/:publicAppId` receives its one-time ticket from the admin opener
 *   through an in-memory postMessage handshake (WB-005)
 * - 其它路径：fallback 到「未指定应用」错误态，不连 WebSocket、不打 /api/control
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EmbedApp } from "./embed-app.tsx";
import "./embed.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing #root element");
}

const pathname = window.location.pathname;
const embedMatch = pathname.match(/^\/embed\/(pub_[0-9a-fA-F-]{36})$/);
const previewMatch = pathname.match(/^\/preview\/(pub_[0-9a-fA-F-]{36})$/);

if (embedMatch === null && previewMatch === null) {
	const container = document.createElement("div");
	container.setAttribute("role", "alert");
	container.style.padding = "24px";
	container.style.fontFamily = "system-ui, sans-serif";
	container.textContent = "Embed app requires a /embed/:publicAppId or /preview/:publicAppId URL.";
	root.replaceChildren(container);
} else if (previewMatch !== null) {
	createRoot(root).render(
		<StrictMode>
			<PreviewBootstrap publicAppId={previewMatch[1]!} />
		</StrictMode>,
	);
} else if (embedMatch !== null) {
	createRoot(root).render(
		<StrictMode>
			<EmbedApp publicAppId={embedMatch[1]!} />
		</StrictMode>,
	);
}

interface PreviewTicketMessage {
	readonly type: "pi-preview-ticket";
	readonly publicAppId: string;
	readonly ticket: string;
}

function isPreviewTicketMessage(value: unknown, publicAppId: string): value is PreviewTicketMessage {
	if (value === null || typeof value !== "object") return false;
	const message = value as Partial<PreviewTicketMessage>;
	return (
		message.type === "pi-preview-ticket" &&
		message.publicAppId === publicAppId &&
		typeof message.ticket === "string" &&
		message.ticket !== ""
	);
}

function PreviewBootstrap({ publicAppId }: { readonly publicAppId: string }): React.JSX.Element {
	const [ticket, setTicket] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (window.opener === null) {
			setError("预览必须从管理员工作台打开。");
			return;
		}
		const opener = window.opener;
		const onMessage = (event: MessageEvent<unknown>): void => {
			if (event.source !== opener || !isPreviewTicketMessage(event.data, publicAppId)) return;
			setTicket(event.data.ticket);
		};
		window.addEventListener("message", onMessage);
		opener.postMessage({ type: "pi-preview-ready", publicAppId }, "*");
		return () => window.removeEventListener("message", onMessage);
	}, [publicAppId]);

	if (error !== null) return <p role="alert">{error}</p>;
	if (ticket === null) return <output>正在建立安全预览连接…</output>;
	return <EmbedApp publicAppId={publicAppId} previewTicket={ticket} />;
}

/**
 * Embed Web 入口（WB-001 / 规格 10.2、10.3、16）。
 *
 * 部署目标 `agent.example.com`；仅服务企业网站嵌入对话。**严禁** import
 * `src/publishing/`、`src/admin/`、`src/lib/` 或 Control API。
 *
 * 路由：
 *
 * - `/embed/:publicAppId` 进入 EmbedApp，匿名或 signed-user 模式由 Embed
 *   内部自决
 * - 后续 `/preview/:publicAppId` 由 PreviewApp 接管（WB-005 实施）
 * - 其它路径：fallback 到「未指定应用」错误态，不连 WebSocket、不打
 *   `/api/control`
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EmbedApp } from "./embed-app.tsx";
import "./embed.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing #root element");
}

const pathname = window.location.pathname;
const publicAppIdMatch = pathname.match(/^\/embed\/(pub_[0-9a-fA-F-]{36})$/);

if (publicAppIdMatch === null) {
	const container = document.createElement("div");
	container.setAttribute("role", "alert");
	container.style.padding = "24px";
	container.style.fontFamily = "system-ui, sans-serif";
	container.textContent = "Embed app requires a /embed/:publicAppId URL.";
	root.replaceChildren(container);
} else {
	createRoot(root).render(
		<StrictMode>
			<EmbedApp publicAppId={publicAppIdMatch[1]!} />
		</StrictMode>,
	);
}

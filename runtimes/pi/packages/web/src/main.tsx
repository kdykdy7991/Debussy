import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { EmbedApp } from "./embed/embed-app.tsx";
import "./embed/embed.css";
import { createPiConnectionController } from "./lib/connection-controller.ts";
import { SessionController } from "./lib/session-controller.ts";
import { createUploader } from "./lib/uploader.ts";
import { createWebSocketTransportFactory } from "./lib/websocket-transport.ts";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing #root element");
}

/**
 * 路径分流（spec 25.4）：`/embed/:publicAppId` 进入 Embed App（匿名访客
 * 聊天，不建立内部 WebSocket 连接、不加载内部管理能力）；其余路径保持
 * 现有内部 Web App 行为不变。
 */
const embedMatch = window.location.pathname.match(/^\/embed\/(pub_[0-9a-fA-F-]{36})$/);
if (embedMatch !== null) {
	createRoot(root).render(
		<StrictMode>
			<EmbedApp publicAppId={embedMatch[1]!} />
		</StrictMode>,
	);
} else {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const webSocketUrl = import.meta.env.VITE_PI_WS_URL ?? `${protocol}//${window.location.host}/api/pi/v1/ws`;
	const webSocketToken = import.meta.env.VITE_PI_WEB_TOKEN;
	// The upload endpoint lives on the same backend HTTP server as the WebSocket
	// listener, so derive its origin from the WS URL.
	const webSocketOrigin = new URL(webSocketUrl).origin;
	const httpBaseUrl = webSocketOrigin.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
	const connection = createPiConnectionController(
		createWebSocketTransportFactory({
			url: webSocketUrl,
			protocols: webSocketToken ? [`pi-auth.${webSocketToken}`] : undefined,
		}),
	);
	const uploads = createUploader({ baseUrl: httpBaseUrl, token: webSocketToken });
	const sessions = new SessionController(connection.client, uploads);

	void connection
		.connect()
		.then(() => sessions.openDefaultSession())
		.catch(() => {});

	createRoot(root).render(
		<StrictMode>
			<App connection={connection} sessions={sessions} />
		</StrictMode>,
	);
}

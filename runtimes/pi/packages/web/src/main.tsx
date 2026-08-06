import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { createPiConnectionController } from "./lib/connection-controller.ts";
import { SessionController } from "./lib/session-controller.ts";
import { createWebSocketTransportFactory } from "./lib/websocket-transport.ts";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing #root element");
}

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const webSocketUrl = import.meta.env.VITE_PI_WS_URL ?? `${protocol}//${window.location.host}/api/pi/v1/ws`;
const webSocketToken = import.meta.env.VITE_PI_WEB_TOKEN;
const connection = createPiConnectionController(
	createWebSocketTransportFactory({
		url: webSocketUrl,
		protocols: webSocketToken ? [`pi-auth.${webSocketToken}`] : undefined,
	}),
);
const sessions = new SessionController(connection.client);

void connection.connect().catch(() => {});

createRoot(root).render(
	<StrictMode>
		<App connection={connection} sessions={sessions} />
	</StrictMode>,
);

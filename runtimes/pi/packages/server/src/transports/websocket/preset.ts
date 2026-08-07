import { PiServer } from "../../server.ts";
import type { PiSessionBackend } from "../../types.ts";
import { createWebSocketListener } from "./listener.ts";
import type { WebSocketServerOptions } from "./types.ts";

/** Compose PiServer with one WebSocket listener on an HTTP upgrade path. */
export function createWebSocketServer(backend: PiSessionBackend, options: WebSocketServerOptions): PiServer {
	const listener = createWebSocketListener({
		host: options.host,
		port: options.port,
		path: options.path,
		allowedOrigins: options.allowedOrigins,
		allowedHosts: options.allowedHosts,
		authorizeUpgrade: options.authorizeUpgrade,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		httpHandler: options.httpHandler,
		onError: options.onError,
	});
	return new PiServer(backend, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
		sessionEventLogMaxEvents: options.sessionEventLogMaxEvents,
		sessionEventLogRetentionMs: options.sessionEventLogRetentionMs,
		attachments: options.attachments,
	});
}

import type { IncomingMessage } from "node:http";
import type { HttpRequestHandler, PiServerOptions } from "../../types.ts";

export interface WebSocketListenerOptions {
	/** Host to bind. Defaults to 127.0.0.1 (loopback only). */
	host?: string;
	/** TCP port to bind. Required. */
	port: number;
	/** Upgrade path. Defaults to /api/pi/v1/ws. */
	path?: string;
	/**
	 * Exact or wildcard allowlist of HTTP Origin values accepted for WebSocket
	 * upgrades. `*` matches any origin, `http://127.0.0.1:*` matches any port.
	 * When omitted, any Origin is accepted (still only bound to the configured host).
	 */
	allowedOrigins?: readonly string[];
	/**
	 * Allowlist of Host header hostnames accepted for WebSocket upgrades.
	 * Defaults to [host, "localhost", "127.0.0.1", "::1"].
	 */
	allowedHosts?: readonly string[];
	/** Additional synchronous authorization check performed before upgrade. */
	authorizeUpgrade?: (request: IncomingMessage) => boolean;
	/** Maximum accepted WebSocket message payload. Defaults to DEFAULT_MAX_FRAME_LENGTH. */
	maxFrameLength?: number;
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Optional handler for non-upgrade HTTP requests on the shared HTTP server. */
	httpHandler?: HttpRequestHandler;
	onError?: (error: Error) => void;
}

export interface WebSocketServerOptions extends Omit<PiServerOptions, "listeners">, WebSocketListenerOptions {}

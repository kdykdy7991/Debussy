import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { PiServerListener } from "../../listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import type { WebSocketListenerOptions } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/api/pi/v1/ws";
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const FRAME_HEADER_LENGTH = 4;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ResolvedWebSocketListenerOptions {
	host: string;
	port: number;
	path: string;
	allowedOrigins: readonly string[] | undefined;
	allowedHosts: readonly string[];
	authorizeUpgrade: ((request: IncomingMessage) => boolean) | undefined;
	maxFrameLength: number;
	maxPendingBytes: number;
	gracefulCloseTimeoutMs: number;
	httpHandler?: HttpRequestHandler;
	onUnhandledUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	onError?: (error: Error) => void;
}

function resolveWebSocketListenerOptions(options: WebSocketListenerOptions): ResolvedWebSocketListenerOptions {
	const host = options.host ?? DEFAULT_HOST;
	if (!host) throw new TypeError("PiServer WebSocket host must not be empty");
	const port = options.port;
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new TypeError("PiServer WebSocket port must be an integer between 0 and 65535");
	}
	const path = options.path ?? DEFAULT_PATH;
	if (!path.startsWith("/")) throw new TypeError("PiServer WebSocket path must start with /");
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`PiServer maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxFrameLength + FRAME_HEADER_LENGTH) {
		throw new TypeError("PiServer maxPendingBytes must be a safe integer at least maxFrameLength + 4");
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs <= 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer gracefulCloseTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	const allowedHosts = options.allowedHosts ?? [host, "localhost", "127.0.0.1", "::1"];
	if (allowedHosts.length === 0) throw new TypeError("PiServer WebSocket allowedHosts must not be empty");
	return {
		host,
		port,
		path,
		allowedOrigins: options.allowedOrigins,
		allowedHosts: [...allowedHosts],
		authorizeUpgrade: options.authorizeUpgrade,
		maxFrameLength,
		maxPendingBytes,
		gracefulCloseTimeoutMs,
		httpHandler: options.httpHandler,
		onUnhandledUpgrade: options.onUnhandledUpgrade,
		onError: options.onError,
	};
}

function reportError(onError: ((error: Error) => void) | undefined, error: unknown): void {
	try {
		onError?.(error instanceof Error ? error : new Error(String(error)));
	} catch {
		// Error observers cannot affect listener state.
	}
}

export function requestPathname(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url, "ws://localhost").pathname;
	} catch {
		return undefined;
	}
}

export function hostHeaderHostname(hostHeader: string | undefined): string | undefined {
	if (!hostHeader) return undefined;
	const trimmed = hostHeader.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		if (end === -1) return undefined;
		return trimmed.slice(1, end);
	}
	const colon = trimmed.lastIndexOf(":");
	if (colon === -1) return trimmed;
	return trimmed.slice(0, colon);
}

/** Simple glob matcher: `*` matches any run of characters within the value. */
export function matchesPattern(value: string, pattern: string): boolean {
	if (pattern === "*") return true;
	const parts = pattern.split("*");
	let cursor = value;
	for (const part of parts) {
		const index = cursor.indexOf(part);
		if (index === -1) return false;
		cursor = cursor.slice(index + part.length);
	}
	return true;
}

function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
	if (Array.isArray(data)) {
		const length = data.reduce((total, chunk) => total + chunk.byteLength, 0);
		const merged = new Uint8Array(length);
		let offset = 0;
		for (const chunk of data) {
			merged.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
			offset += chunk.byteLength;
		}
		return merged;
	}
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

/**
 * A WebSocket transport listener that validates Origin/Host/path before the
 * upgrade completes and maps binary WebSocket messages to the server's byte
 * connection interface with ordered writes and a bounded pending queue.
 */
export class WebSocketListener implements PiServerListener {
	private readonly options: ResolvedWebSocketListenerOptions;
	private readonly connections = new Set<WebSocketByteConnection>();
	private httpServer?: Server;
	private wss?: WebSocketServer;
	private accept?: ByteConnectionAcceptor;
	private boundAddress?: string;
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(options: WebSocketListenerOptions) {
		this.options = resolveWebSocketListenerOptions(options);
	}

	get address(): string | undefined {
		return this.boundAddress;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.httpServer) throw new Error("WebSocket listener is already started");
		if (this.closing) throw new Error("WebSocket listener is closing or closed");
		this.accept = accept;

		const httpServer = createServer((request, response) => {
			void this.handleHttpRequest(request, response);
		});
		const wss = new WebSocketServer({
			noServer: true,
			maxPayload: this.options.maxFrameLength + FRAME_HEADER_LENGTH,
		});
		httpServer.on("upgrade", (request, socket, head) => {
			this.handleUpgrade(request, socket, head);
		});
		httpServer.on("clientError", (_error, socket) => {
			socket.destroy();
		});
		wss.on("connection", (webSocket, request) => {
			this.acceptWebSocket(webSocket, request);
		});
		wss.on("error", (error) => reportError(this.options.onError, error));

		this.httpServer = httpServer;
		this.wss = wss;

		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					httpServer.off("listening", onListening);
					reject(error);
				};
				const onListening = (): void => {
					httpServer.off("error", onError);
					resolve();
				};
				httpServer.once("error", onError);
				httpServer.once("listening", onListening);
				httpServer.listen(this.options.port, this.options.host);
			});
			const address = httpServer.address();
			this.boundAddress =
				typeof address === "object" && address !== null ? `${address.address}:${address.port}` : undefined;
		} catch (error) {
			this.httpServer = undefined;
			this.wss = undefined;
			httpServer.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		this.boundAddress = undefined;
		const serverClosed = this.closeServers();
		await Promise.all([...this.connections].map((connection) => connection.close()));
		await serverClosed;
		this.connections.clear();
		this.httpServer = undefined;
		this.wss = undefined;
	}

	private async closeServers(): Promise<void> {
		const wss = this.wss;
		const httpServer = this.httpServer;
		if (wss) {
			await new Promise<void>((resolve) => {
				wss.close(() => resolve());
			});
		}
		if (httpServer?.listening) {
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	}

	private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		// 非主路径 upgrade：交给可选扩展（如 embed Realtime ticket upgrade）。
		const pathname = requestPathname(request.url);
		if (pathname !== this.options.path && this.options.onUnhandledUpgrade?.(request, socket, head) === true) {
			return;
		}
		const rejection = this.authorize(request);
		if (rejection !== undefined) {
			this.respondRejection(socket, rejection.status, rejection.message);
			return;
		}
		const wss = this.wss;
		if (!wss) {
			socket.destroy();
			return;
		}
		try {
			wss.handleUpgrade(request, socket, head, (webSocket) => {
				wss.emit("connection", webSocket, request);
			});
		} catch (error) {
			reportError(this.options.onError, error);
			socket.destroy();
		}
	}

	/** Returns a rejection to send before the upgrade when the request is not authorized. */
	private authorize(request: IncomingMessage): { status: number; message: string } | undefined {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || pathname !== this.options.path) {
			return { status: 404, message: "Not found" };
		}
		const hostname = hostHeaderHostname(request.headers.host);
		if (hostname === undefined || !this.options.allowedHosts.some((allowed) => matchesPattern(hostname, allowed))) {
			return { status: 403, message: "Forbidden" };
		}
		const allowedOrigins = this.options.allowedOrigins;
		const origin = request.headers.origin;
		if (allowedOrigins !== undefined) {
			if (origin === undefined || !allowedOrigins.some((allowed) => matchesPattern(origin, allowed))) {
				return { status: 403, message: "Forbidden" };
			}
		}
		try {
			if (this.options.authorizeUpgrade && !this.options.authorizeUpgrade(request)) {
				return { status: 401, message: "Unauthorized" };
			}
		} catch (error) {
			reportError(this.options.onError, error);
			return { status: 401, message: "Unauthorized" };
		}
		return undefined;
	}

	private acceptWebSocket(webSocket: WebSocket, _request: IncomingMessage): void {
		if (this.closing) {
			webSocket.close(1001, "Server closing");
			return;
		}
		const connection = new WebSocketByteConnection(
			webSocket,
			this.options.maxPendingBytes,
			this.options.gracefulCloseTimeoutMs,
		);
		this.connections.add(connection);
		const accept = this.accept;
		if (!accept) {
			webSocket.close(1011, "Server closing");
			return;
		}
		const handler = accept(connection);
		webSocket.on("message", (data, isBinary) => {
			if (!isBinary) return;
			handler.onData(toUint8Array(data));
		});
		webSocket.on("error", (error) => {
			handler.onError(error instanceof Error ? error : new Error(String(error)));
		});
		webSocket.once("close", () => {
			connection.markClosed();
			this.connections.delete(connection);
			handler.onClose();
		});
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const handler = this.options.httpHandler;
		if (handler) {
			try {
				const handled = await handler(request, response);
				if (handled) return;
			} catch (error) {
				reportError(this.options.onError, error);
				if (!response.headersSent) {
					response.writeHead(500, { "content-type": "text/plain" });
					response.end("Internal server error");
				}
				return;
			}
		}
		this.respondNotFound(response);
	}

	private respondNotFound(response: ServerResponse): void {
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("Not found");
	}

	private respondRejection(socket: Duplex, status: number, message: string): void {
		socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	}
}

/** @internal Exported only for transport-level verification. */
export class WebSocketByteConnection implements ByteConnection {
	private readonly webSocket: WebSocket;
	private readonly maxPendingBytes: number;
	private readonly gracefulCloseTimeoutMs: number;
	private pendingBytes = 0;
	private readonly inFlightWrites = new Set<{ bytes: Uint8Array; reject: (error: Error) => void }>();
	private idleWaiters: Array<() => void> = [];
	private closedValue = false;
	private closing = false;
	private closePromise?: Promise<void>;
	private resolveClose?: () => void;

	constructor(webSocket: WebSocket, maxPendingBytes: number, gracefulCloseTimeoutMs: number) {
		this.webSocket = webSocket;
		this.maxPendingBytes = maxPendingBytes;
		this.gracefulCloseTimeoutMs = gracefulCloseTimeoutMs;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	/**
	 * Enqueue a binary frame immediately. `ws` buffers outbound messages in FIFO
	 * order and invokes the callback when each message is flushed, so writes need
	 * no serialization here; the pending-byte counter bounds how much a slow peer
	 * may buffer before writes are rejected.
	 */
	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) {
			return Promise.reject(new Error("WebSocket connection is closed"));
		}
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		}
		this.pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		return new Promise<void>((resolve, reject) => {
			const entry = { bytes, reject };
			this.inFlightWrites.add(entry);
			const callback = (error?: Error): void => {
				if (!this.inFlightWrites.delete(entry)) return;
				this.pendingBytes -= bytes.byteLength;
				if (this.inFlightWrites.size === 0) this.notifyIdle();
				if (error) reject(error instanceof Error ? error : new Error(String(error)));
				else resolve();
			};
			try {
				this.webSocket.send(bytes, { binary: true }, callback);
			} catch (error) {
				callback(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/**
	 * Gracefully close: reject new writes, wait for in-flight writes to flush so
	 * the final chunk is delivered after all pending output, then start the
	 * WebSocket closing handshake. Falls back to `terminate()` after the timeout.
	 */
	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.closedValue || this.webSocket.readyState >= WebSocket.CLOSING) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		const finalBytes = finalChunk?.slice();
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			const timer = setTimeout(() => {
				this.webSocket.terminate();
				this.markClosed();
			}, this.gracefulCloseTimeoutMs);
			timer.unref();
			void this.whenIdle().then(() => {
				if (this.closedValue) return;
				try {
					if (finalBytes) {
						this.webSocket.send(finalBytes, { binary: true }, () => {});
					}
					this.webSocket.close(1000, "server closing");
				} catch {
					this.webSocket.terminate();
					this.markClosed();
				}
			});
		});
		return this.closePromise;
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.pendingBytes = 0;
		for (const entry of this.inFlightWrites) {
			entry.reject(new Error("WebSocket connection closed"));
		}
		this.inFlightWrites.clear();
		this.notifyIdle();
		this.resolveClose?.();
		this.resolveClose = undefined;
	}

	private whenIdle(): Promise<void> {
		if (this.inFlightWrites.size === 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	private notifyIdle(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

export function createWebSocketListener(options: WebSocketListenerOptions): PiServerListener {
	return new WebSocketListener(options);
}

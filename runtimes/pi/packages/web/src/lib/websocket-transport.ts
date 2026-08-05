import type { ByteTransportFactory } from "@earendil-works/pi-client";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 8;
const WEB_SOCKET_CONNECTING = 0;
const WEB_SOCKET_OPEN = 1;

export interface WebSocketTransportOptions {
	url: string;
	protocols?: string | string[];
	connectTimeoutMs?: number;
	maxPendingBytes?: number;
	createWebSocket?: (url: string, protocols?: string | string[]) => WebSocket;
}

function toError(reason: unknown, fallback: string): Error {
	return reason instanceof Error ? reason : new Error(fallback);
}

function validateOptions(options: WebSocketTransportOptions): {
	connectTimeoutMs: number;
	maxPendingBytes: number;
} {
	if (!options.url.trim()) throw new Error("WebSocket URL must not be empty");

	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
		throw new Error("WebSocket connect timeout must be greater than zero");
	}

	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new Error("WebSocket pending byte limit must be a positive safe integer");
	}

	return { connectTimeoutMs, maxPendingBytes };
}

function createDefaultWebSocket(url: string, protocols?: string | string[]): WebSocket {
	return protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
}

/** Creates a fresh browser WebSocket transport for each PiClient connection attempt. */
export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	const { connectTimeoutMs, maxPendingBytes } = validateOptions(options);
	const createWebSocket = options.createWebSocket ?? createDefaultWebSocket;

	return (handlers) =>
		new Promise((resolve, reject) => {
			let socket: WebSocket;
			try {
				socket = createWebSocket(options.url, options.protocols);
			} catch (error) {
				reject(toError(error, "Failed to create WebSocket"));
				return;
			}

			socket.binaryType = "arraybuffer";
			let connected = false;
			let terminal = false;
			let closedByClient = false;
			let sendQueue = Promise.resolve();

			const timeout = globalThis.setTimeout(() => {
				if (connected || terminal) return;
				terminal = true;
				socket.close();
				reject(new Error(`WebSocket connection timed out after ${connectTimeoutMs} ms`));
			}, connectTimeoutMs);

			const reportError = (error: Error) => {
				if (terminal) return;
				terminal = true;
				if (connected) {
					handlers.onError(error);
				} else {
					globalThis.clearTimeout(timeout);
					reject(error);
				}
			};

			const waitForCapacity = async (byteLength: number): Promise<void> => {
				while (socket.bufferedAmount + byteLength > maxPendingBytes) {
					if (terminal || socket.readyState !== WEB_SOCKET_OPEN) {
						throw new Error("WebSocket closed while waiting for send capacity");
					}
					await new Promise<void>((resolveDelay) => globalThis.setTimeout(resolveDelay, BACKPRESSURE_POLL_MS));
				}
			};

			socket.addEventListener(
				"open",
				() => {
					if (terminal) return;
					connected = true;
					globalThis.clearTimeout(timeout);

					resolve({
						async send(chunk: Uint8Array) {
							if (chunk.byteLength > maxPendingBytes) {
								throw new Error(
									`WebSocket chunk exceeds pending byte limit (${chunk.byteLength} > ${maxPendingBytes})`,
								);
							}

							const sendTask = sendQueue.then(async () => {
								if (terminal || socket.readyState !== WEB_SOCKET_OPEN) {
									throw new Error("Cannot send while WebSocket is not open");
								}
								await waitForCapacity(chunk.byteLength);
								socket.send(chunk);
							});
							sendQueue = sendTask.catch(() => {});
							await sendTask;
						},
						close() {
							if (closedByClient) return;
							closedByClient = true;
							if (socket.readyState === WEB_SOCKET_CONNECTING || socket.readyState === WEB_SOCKET_OPEN) {
								socket.close();
							}
						},
					});
				},
				{ once: true },
			);

			socket.addEventListener("message", (event: MessageEvent) => {
				if (terminal) return;
				const data: unknown = event.data;
				if (!(data instanceof ArrayBuffer)) {
					reportError(new Error("WebSocket received a non-binary message"));
					socket.close();
					return;
				}
				handlers.onData(new Uint8Array(data));
			});

			socket.addEventListener("error", (event) => {
				reportError(toError(event, "WebSocket transport failed"));
			});

			socket.addEventListener(
				"close",
				() => {
					globalThis.clearTimeout(timeout);
					if (terminal) return;
					terminal = true;
					if (connected) {
						handlers.onClose();
					} else {
						reject(new Error("WebSocket closed before the connection was established"));
					}
				},
				{ once: true },
			);
		});
}

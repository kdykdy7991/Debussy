import { once } from "node:events";
import { WebSocket } from "ws";
import { ProtocolTestClient } from "./client.ts";

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

function sendWebSocket(webSocket: WebSocket, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		webSocket.send(chunk, { binary: true }, (error) => {
			if (error) reject(error instanceof Error ? error : new Error(String(error)));
			else resolve();
		});
	});
}

/** Connect a protocol test client over a WebSocket transport. */
export async function connectWebSocketTestClient(url: string): Promise<ProtocolTestClient> {
	const webSocket = new WebSocket(url);
	await once(webSocket, "open");
	const client = new ProtocolTestClient({
		send: (chunk) => sendWebSocket(webSocket, chunk),
		async sendFragmented(chunk, splitAt) {
			await sendWebSocket(webSocket, chunk.subarray(0, splitAt));
			await sendWebSocket(webSocket, chunk.subarray(splitAt));
		},
		async close() {
			if (webSocket.readyState >= WebSocket.CLOSING) return;
			const closed = once(webSocket, "close");
			webSocket.close();
			await closed;
		},
	});
	webSocket.on("message", (data) => {
		client.receive(toUint8Array(data));
	});
	webSocket.on("error", (error) => client.fail(error instanceof Error ? error : new Error(String(error))));
	webSocket.once("close", () => client.markClosed());
	return client;
}

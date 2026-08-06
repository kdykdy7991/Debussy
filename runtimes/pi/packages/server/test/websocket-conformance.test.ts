import { EventEmitter } from "node:events";
import { request } from "node:http";
import { encodeClientMessage, encodeFrame, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { PiServer } from "../src/index.ts";
import { connectWebSocketTestClient, type ProtocolTestClient, TestSessionBackend } from "../src/testing/index.ts";
import {
	createWebSocketServer,
	WebSocketByteConnection,
	type WebSocketServerOptions,
} from "../src/transports/websocket/index.ts";

const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

async function startServer(
	backend = new TestSessionBackend(),
	overrides: Partial<WebSocketServerOptions> = {},
): Promise<{ server: PiServer; backend: TestSessionBackend; url: string }> {
	const server = createWebSocketServer(backend, { port: 0, ...overrides });
	servers.add(server);
	await server.start();
	const address = server.addresses[0]!;
	const port = Number(address.slice(address.lastIndexOf(":") + 1));
	const url = `ws://127.0.0.1:${port}/api/pi/v1/ws`;
	return { server, backend, url };
}

async function connect(url: string): Promise<ProtocolTestClient> {
	const client = await connectWebSocketTestClient(url);
	clients.add(client);
	return client;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
});

/** Perform a raw HTTP upgrade and resolve with the response status (101 on success). */
function rawUpgrade(url: string, extraHeaders: Record<string, string> = {}): Promise<number> {
	const target = new URL(url);
	return new Promise<number>((resolve, reject) => {
		const req = request({
			host: target.hostname,
			port: Number(target.port),
			path: `${target.pathname}${target.search}`,
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "x3JJHMbDL1EzLkh9GBhXDw==",
				...extraHeaders,
			},
		});
		req.on("upgrade", () => resolve(101));
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("WebSocket transport conformance", () => {
	test("completes the protocol handshake over a binary WebSocket", async () => {
		const { url } = await startServer();
		const client = await connect(url);
		expect(await client.hello()).toMatchObject({ type: "hello", version: PROTOCOL_VERSION });
	});

	test("accepts a transport-fragmented framed-CBOR hello", async () => {
		const { url } = await startServer();
		const client = await connect(url);
		const response = client.next((message) => message.type === "hello");
		await client.sendFragmentedMessage({ type: "hello", version: PROTOCOL_VERSION }, 2);
		expect(await response).toMatchObject({ type: "hello", version: PROTOCOL_VERSION });
	});

	test("enforces version and exactly one first-message hello", async () => {
		const { url } = await startServer();

		const badVersion = await connect(url);
		expect(await badVersion.hello(PROTOCOL_VERSION + 1)).toMatchObject({
			type: "hello_error",
			error: { code: "version" },
		});
		await badVersion.waitForClose();

		const requestFirst = await connect(url);
		const firstError = requestFirst.next((message) => message.type === "hello_error");
		await requestFirst.sendMessage({ type: "request", id: "too-early", request: { command: "list" } });
		expect(await firstError).toMatchObject({ type: "hello_error", error: { code: "invalid_request" } });
		await requestFirst.waitForClose();

		const duplicate = await connect(url);
		expect(await duplicate.hello()).toMatchObject({ type: "hello" });
		const duplicateError = duplicate.next((message) => message.type === "hello_error");
		await duplicate.sendMessage({ type: "hello", version: PROTOCOL_VERSION });
		expect(await duplicateError).toMatchObject({ type: "hello_error", error: { code: "invalid_request" } });
		await duplicate.waitForClose();
	});

	test("closes connections that do not complete hello before the timeout", async () => {
		const { url } = await startServer(new TestSessionBackend(), { handshakeTimeoutMs: 20 });
		const client = await connect(url);
		await client.waitForClose();
		expect(client.messages).toContainEqual(
			expect.objectContaining({
				type: "hello_error",
				error: expect.objectContaining({ code: "invalid_request" }),
			}),
		);
	});

	test("rejects an oversized WebSocket message payload before protocol handling", async () => {
		const { url } = await startServer(new TestSessionBackend(), { maxFrameLength: 128 });
		const client = await connect(url);
		await client.sendBytes(new Uint8Array(512));
		await client.waitForClose();
		expect(client.messages.some((message) => message.type === "hello")).toBe(false);
	});

	test("rejects a protocol frame length over the limit with a hello_error", async () => {
		const { url } = await startServer(new TestSessionBackend(), { maxFrameLength: 128 });
		const client = await connect(url);
		const helloError = client.next((message) => message.type === "hello_error");
		// 4-byte length prefix claiming 256, which exceeds maxFrameLength.
		await client.sendBytes(Uint8Array.of(0, 0, 1, 0));
		expect(await helloError).toMatchObject({ type: "hello_error", error: { code: "invalid_request" } });
		await client.waitForClose();
	});

	test("rejects malformed frames", async () => {
		const { url } = await startServer();
		const client = await connect(url);
		const helloError = client.next((message) => message.type === "hello_error");
		await client.sendBytes(encodeFrame(Uint8Array.of(0xff)));
		expect(await helloError).toMatchObject({ type: "hello_error", error: { code: "invalid_request" } });
		await client.waitForClose();
	});

	test("rejects upgrades for the wrong path", async () => {
		const { server } = await startServer();
		const address = server.addresses[0]!;
		const status = await rawUpgrade(`ws://${address}/not-the-ws-path`);
		expect(status).toBe(404);
	});

	test("rejects upgrades from disallowed origins and hosts", async () => {
		const { server } = await startServer(new TestSessionBackend(), {
			allowedOrigins: ["http://127.0.0.1:5173"],
		});
		const address = server.addresses[0]!;

		expect(await rawUpgrade(`ws://${address}/api/pi/v1/ws`, { origin: "http://evil.example" })).toBe(403);
		expect(await rawUpgrade(`ws://${address}/api/pi/v1/ws`, { origin: "http://localhost:5173" })).toBe(403);
		expect(
			await rawUpgrade(`ws://${address}/api/pi/v1/ws`, {
				origin: "http://127.0.0.1:5173",
				host: "evil.example",
			}),
		).toBe(403);
		expect(await rawUpgrade(`ws://${address}/api/pi/v1/ws`, { origin: "http://127.0.0.1:5173" })).toBe(101);
	});

	test("allows a wildcard origin pattern", async () => {
		const { server } = await startServer(new TestSessionBackend(), {
			allowedOrigins: ["http://127.0.0.1:*"],
		});
		const address = server.addresses[0]!;
		expect(await rawUpgrade(`ws://${address}/api/pi/v1/ws`, { origin: "http://127.0.0.1:9999" })).toBe(101);
		expect(await rawUpgrade(`ws://${address}/api/pi/v1/ws`, { origin: "https://evil.example" })).toBe(403);
	});

	test("runs an additional authorization check before upgrading", async () => {
		const { server } = await startServer(new TestSessionBackend(), {
			authorizeUpgrade: (request) => request.headers.cookie === "pi_session=allowed",
		});
		const address = server.addresses[0]!;
		const url = `ws://${address}/api/pi/v1/ws`;

		expect(await rawUpgrade(url)).toBe(401);
		expect(await rawUpgrade(url, { cookie: "pi_session=allowed" })).toBe(101);
	});

	test("decodes multiple framed requests from one WebSocket message", async () => {
		const { url } = await startServer();
		const client = await connect(url);
		await client.hello();
		const first = encodeClientMessage({ type: "request", id: "first", request: { command: "list" } });
		const second = encodeClientMessage({ type: "request", id: "second", request: { command: "list" } });
		const combined = new Uint8Array(first.byteLength + second.byteLength);
		combined.set(first);
		combined.set(second, first.byteLength);
		const firstResponse = client.next((message) => message.type === "response" && message.id === "first");
		const secondResponse = client.next((message) => message.type === "response" && message.id === "second");
		await client.sendBytes(combined);
		expect(await firstResponse).toMatchObject({ type: "response", id: "first", ok: true });
		expect(await secondResponse).toMatchObject({ type: "response", id: "second", ok: true });
	});

	test("gracefully closes connections, sessions, and listener resources", async () => {
		const backend = new TestSessionBackend();
		backend.seed("first");
		const { server, url } = await startServer(backend);
		const client = await connect(url);
		await client.hello();
		await client.request({ command: "attach", sessionId: "first" });
		const runtime = backend.latestRuntime("first");
		const clientClosed = client.waitForClose();

		await server.close();
		await clientClosed;
		expect(runtime.disposeCount).toBe(1);
		expect(server.addresses).toEqual([]);
		await server.close();
	});
});

describe("WebSocket byte connection", () => {
	class ControlledWebSocket extends EventEmitter {
		readyState: number = WebSocket.OPEN;
		readonly sent: Array<{ chunk: Uint8Array; callback?: (error?: Error) => void }> = [];
		closedWith?: number;

		send(data: Uint8Array, _options?: unknown, callback?: (error?: Error) => void): void {
			this.sent.push({ chunk: data.slice(), callback });
		}

		close(code?: number, _reason?: string): void {
			this.closedWith = code;
			this.readyState = WebSocket.CLOSED;
			this.emit("close");
		}

		terminate(): void {
			this.readyState = WebSocket.CLOSED;
			this.emit("close");
		}
	}

	function makeConnection(maxPendingBytes: number): {
		connection: WebSocketByteConnection;
		webSocket: ControlledWebSocket;
	} {
		const webSocket = new ControlledWebSocket();
		const connection = new WebSocketByteConnection(webSocket as unknown as WebSocket, maxPendingBytes, 1_000);
		return { connection, webSocket };
	}

	test("queues a final protocol error behind pending output before closing", async () => {
		const { connection, webSocket } = makeConnection(64 * 1024);
		const pendingWrite = connection.send(new Uint8Array([1, 2, 3]));
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		expect(webSocket.sent).toHaveLength(1);

		const closing = connection.close(encodeFrame(Uint8Array.of(4, 5, 6)));
		expect(webSocket.closedWith).toBeUndefined();
		expect(webSocket.sent).toHaveLength(1);

		webSocket.sent[0]!.callback?.(undefined);
		await pendingWrite;
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		expect(webSocket.sent).toHaveLength(2);
		expect(webSocket.sent[1]!.chunk).toEqual(encodeFrame(Uint8Array.of(4, 5, 6)));
		expect(webSocket.closedWith).toBe(1000);

		connection.markClosed();
		await closing;
	});

	test("rejects writes over the pending byte limit while a slow peer is pending", async () => {
		const { connection, webSocket } = makeConnection(10);
		const pending = connection.send(new Uint8Array(8));
		// The write is queued behind the write tail; run the tail before asserting.
		await new Promise((resolve) => setImmediate(resolve));
		expect(webSocket.sent).toHaveLength(1);
		await expect(connection.send(new Uint8Array(8))).rejects.toThrow(/pending byte limit/);
		connection.markClosed();
		await pending.catch(() => {});
	});

	test("preserves send order for the server output queue", async () => {
		const { connection, webSocket } = makeConnection(1024);
		const first = connection.send(new Uint8Array([1]));
		const second = connection.send(new Uint8Array([2]));
		// Both writes chain onto the same write tail; let the queue drain.
		await new Promise((resolve) => setImmediate(resolve));
		expect(webSocket.sent.map((entry) => Array.from(entry.chunk))).toEqual([[1], [2]]);

		webSocket.sent[0]!.callback?.(undefined);
		await first;
		webSocket.sent[1]!.callback?.(undefined);
		await second;
		connection.markClosed();
	});
});

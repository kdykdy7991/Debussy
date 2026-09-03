import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceProxyTicketService } from "../../src/embed/auth/voice-proxy-ticket.ts";
import { createVoiceProxyTicketService } from "../../src/embed/auth/voice-proxy-ticket.ts";
import type { TicketStore } from "../../src/embed/auth/ws-ticket.ts";
import type { VoiceEngineConfig } from "../../src/embed/voice-engine/config.ts";
import { createVoiceEngineUpgradeHandler } from "../../src/embed/voice-engine/proxy.ts";
import { newPrincipalId, newPublishedAppId, newTenantId } from "../../src/publishing/domain/ids.ts";

function dataToBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data as readonly Buffer[]);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(typeof data === "string" ? data : "");
}

/** Test in-memory ticket store (mirrors the Task 1 voice-proxy-ticket test). */
function memoryTicketStore(): TicketStore {
	const values = new Map<string, string>();
	return {
		async set(hash, claims) {
			values.set(hash, claims);
		},
		async consume(hash) {
			const value = values.get(hash) ?? null;
			values.delete(hash);
			return value;
		},
	};
}

/** Spin up a fake upstream WS server. Records inbound messages + exposes send/close. */
class FakeUpstream {
	readonly server: Server;
	readonly wss: WebSocketServer;
	readonly received: Array<{ data: string; binary: boolean }> = [];
	readonly connected: Promise<WebSocket>;
	readonly authHeader: { value: string | null } = { value: null };
	private resolveConnect!: (ws: WebSocket) => void;

	constructor() {
		this.connected = new Promise<WebSocket>((resolve) => {
			this.resolveConnect = resolve;
		});
		this.server = createServer();
		this.wss = new WebSocketServer({ server: this.server });
		this.wss.on("connection", (ws, request) => {
			this.authHeader.value = (request.headers.authorization as string | undefined) ?? null;
			this.resolveConnect(ws);
			ws.on("message", (data, isBinary) => {
				const text = typeof data === "string" ? data : dataToBuffer(data).toString("utf8");
				this.received.push({ data: text, binary: Boolean(isBinary) });
			});
		});
	}

	async listen(): Promise<number> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
		const address = this.server.address() as AddressInfo;
		return address.port;
	}

	sendToFirst(text: string): void {
		void this.connected.then((ws) => ws.send(text));
	}

	sendBinaryToFirst(payload: Buffer): void {
		void this.connected.then((ws) => ws.send(payload, { binary: true }));
	}

	closeFirst(): void {
		void this.connected.then((ws) => ws.close(1000, "upstream shutdown"));
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

/** Issue a voice-proxy ticket directly via the service. */
async function issueTicket(tickets: VoiceProxyTicketService, origin: string): Promise<string> {
	const issued = await tickets.issue({
		tenantId: newTenantId(),
		publishedAppId: newPublishedAppId(),
		principalId: newPrincipalId(),
		principalType: "anonymous_visitor",
		tokenId: "token-test",
		origin,
	});
	return issued.ticket;
}

/** Bind the proxy handleUpgrade to a real HTTP server (mirrors Task 3 wiring). */
async function bindProxyToLocalServer(
	handle: ReturnType<typeof createVoiceEngineUpgradeHandler>,
): Promise<{ port: number; server: Server }> {
	const server = createServer();
	server.on("upgrade", (request, socket, head) => {
		handle.handleUpgrade(request, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return { port, server };
}

let upstream: FakeUpstream;
let tickets: VoiceProxyTicketService;
let config: VoiceEngineConfig;
let localHandle: ReturnType<typeof createVoiceEngineUpgradeHandler>;
let localServer: Server;

beforeEach(async () => {
	tickets = createVoiceProxyTicketService(memoryTicketStore());
	upstream = new FakeUpstream();
	const port = await upstream.listen();
	config = { upstreamUrl: `ws://127.0.0.1:${port}`, upstreamToken: "upstream-secret" };
	localHandle = createVoiceEngineUpgradeHandler({
		tickets,
		config,
		onError: () => {},
	});
	const bound = await bindProxyToLocalServer(localHandle);
	localServer = bound.server;
});

afterEach(async () => {
	await localHandle.close();
	await new Promise<void>((resolve) => localServer.close(() => resolve()));
	await upstream.stop();
});

describe("Voice Engine transparent WS proxy", () => {
	test("server-injected upstream Authorization header reaches VoxEMW", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		await new Promise<void>((resolve, reject) => {
			client.once("open", () => resolve());
			client.once("error", reject);
		});
		await upstream.connected;
		expect(upstream.authHeader.value).toBe("Bearer upstream-secret");
		client.close();
	});

	test("forwards client -> upstream text frame verbatim (no parsing)", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		await new Promise<void>((resolve, reject) => {
			client.once("open", () => resolve());
			client.once("error", reject);
		});
		await upstream.connected;

		client.send("hello-from-client");
		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (upstream.received.length > 0) {
					clearInterval(interval);
					resolve();
				}
			}, 5);
		});
		expect(upstream.received).toEqual([{ data: "hello-from-client", binary: false }]);
		client.close();
	});

	test("forwards upstream -> client text frame verbatim", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		const received: string[] = [];
		client.on("message", (data) => {
			received.push(typeof data === "string" ? data : dataToBuffer(data).toString("utf8"));
		});
		await new Promise<void>((resolve, reject) => {
			client.once("open", () => resolve());
			client.once("error", reject);
		});
		await upstream.connected;

		upstream.sendToFirst("pong-from-upstream");
		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (received.length > 0) {
					clearInterval(interval);
					resolve();
				}
			}, 5);
		});
		expect(received).toEqual(["pong-from-upstream"]);
		client.close();
	});

	test("forwards binary frames in both directions", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		const receivedBinary: Buffer[] = [];
		client.on("message", (data, isBinary) => {
			if (isBinary) receivedBinary.push(dataToBuffer(data));
		});
		await new Promise<void>((resolve, reject) => {
			client.once("open", () => resolve());
			client.once("error", reject);
		});
		await upstream.connected;

		const payload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
		client.send(payload, { binary: true });
		upstream.sendBinaryToFirst(Buffer.from([0x10, 0x20, 0x30]));

		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (upstream.received.length > 0 && receivedBinary.length > 0) {
					clearInterval(interval);
					resolve();
				}
			}, 5);
		});
		expect(upstream.received[0]!.binary).toBe(true);
		expect(upstream.received[0]!.data).toBe("\u0000\u0001\u0002\u0003");
		expect(receivedBinary[0]).toEqual(Buffer.from([0x10, 0x20, 0x30]));
		client.close();
	});

	test("upstream close propagates to the client", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		await new Promise<void>((resolve, reject) => {
			client.once("open", () => resolve());
			client.once("error", reject);
		});
		await upstream.connected;

		const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
		upstream.closeFirst();
		await clientClosed;
		client.removeAllListeners();
	});

	test("rejects when ticket origin does not match the request Origin", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://evil.example" } },
		);
		const errorMessage = await new Promise<string>((resolve) => {
			client.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/403|Forbidden|TOKEN/i);
		client.removeAllListeners();
	});

	test("rejects when the request has no Origin header", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		// node `ws` requires Origin only in browser handshake mode; for a
		// direct ws:// call without Origin, the proxy must still reject.
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
		);
		const errorMessage = await new Promise<string>((resolve) => {
			client.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/401|Unauthorized|TOKEN/i);
		client.removeAllListeners();
	});

	test("rejects when ticket is missing from query", async () => {
		const client = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws`,
			{ headers: { origin: "https://host.example" } },
		);
		const errorMessage = await new Promise<string>((resolve) => {
			client.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/401|Unauthorized|TOKEN/i);
		client.removeAllListeners();
	});

	test("rejects when ticket has already been consumed (replay)", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		// First connection succeeds; close it then try to reuse the ticket.
		const first = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		await new Promise<void>((resolve, reject) => {
			first.once("open", () => resolve());
			first.once("error", reject);
		});
		await upstream.connected;
		first.close();

		const second = new WebSocket(
			`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/voice-engine/v1/ws?ticket=${ticket}`,
			{ headers: { origin: "https://host.example" } },
		);
		const errorMessage = await new Promise<string>((resolve) => {
			second.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/403|Forbidden|TOKEN/i);
		second.removeAllListeners();
	});
});

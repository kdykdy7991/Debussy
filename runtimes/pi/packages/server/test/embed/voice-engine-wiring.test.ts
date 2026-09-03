import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceProxyTicketService } from "../../src/embed/auth/voice-proxy-ticket.ts";
import { createVoiceProxyTicketService } from "../../src/embed/auth/voice-proxy-ticket.ts";
import type { TicketStore } from "../../src/embed/auth/ws-ticket.ts";
import type { VoiceEngineConfig } from "../../src/embed/voice-engine/config.ts";
import { createVoiceEngineUpgradeHandler, type VoiceEngineUpgradeHandle } from "../../src/embed/voice-engine/proxy.ts";
import { createRedactingSink, createSecretRegistry } from "../../src/logging/redact.ts";
import { newPrincipalId, newPublishedAppId, newTenantId } from "../../src/publishing/domain/ids.ts";

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

function dataToBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data as readonly Buffer[]);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(typeof data === "string" ? data : "");
}

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

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

/**
 * Mirrors what `web/start.ts` does for the voice engine upgrade: register
 * `handleUpgrade` as the unhandled-upgrade fallback on the listener's HTTP
 * server. The real listener delegates anything not matching its main path to
 * the optional `onUnhandledUpgrade` handler, which we wire to the proxy.
 */
async function bindProxyUpgrade(handle: VoiceEngineUpgradeHandle): Promise<{ server: Server; port: number }> {
	const server = createServer();
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		handle.handleUpgrade(request, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return { server, port };
}

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

let upstream: FakeUpstream;
let tickets: VoiceProxyTicketService;
let proxy: VoiceEngineUpgradeHandle;
let proxyServer: Server;
let proxyPort: number;

beforeEach(async () => {
	tickets = createVoiceProxyTicketService(memoryTicketStore());
	upstream = new FakeUpstream();
	const upstreamPort = await upstream.listen();
	const config: VoiceEngineConfig = {
		upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
		upstreamToken: "upstream-secret-DO-NOT-LEAK",
	};
	proxy = createVoiceEngineUpgradeHandler({
		tickets,
		config,
		// Capture all error logs to assert redaction behavior.
		onError: (error) => logSpy.push(error instanceof Error ? error.message : String(error)),
	});
	const bound = await bindProxyUpgrade(proxy);
	proxyServer = bound.server;
	proxyPort = bound.port;
});

afterEach(async () => {
	await proxy.close();
	await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
	await upstream.stop();
	logSpy.length = 0;
});

const logSpy: string[] = [];

describe("Voice Engine proxy wiring (server.on('upgrade') integration)", () => {
	test("forwards client -> upstream through a real upgrade + binary messages", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`, {
			headers: { origin: "https://host.example" },
		});
		const received: string[] = [];
		client.on("message", (data) =>
			received.push(typeof data === "string" ? data : dataToBuffer(data).toString("utf8")),
		);
		await new Promise<void>((resolve, reject) => {
			client.once("open", () => resolve());
			client.once("error", reject);
		});
		await upstream.connected;

		client.send("ping-from-client");
		upstream.sendToFirst("pong-from-upstream");

		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (upstream.received.length > 0 && received.length > 0) {
					clearInterval(interval);
					resolve();
				}
			}, 5);
		});
		expect(upstream.received).toEqual([{ data: "ping-from-client", binary: false }]);
		expect(received).toEqual(["pong-from-upstream"]);
		expect(upstream.authHeader.value).toBe("Bearer upstream-secret-DO-NOT-LEAK");

		client.close();
	});

	test("missing ticket surfaces as a 401 to the connecting client", async () => {
		const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws`, {
			headers: { origin: "https://host.example" },
		});
		const errorMessage = await new Promise<string>((resolve) => {
			client.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/401|Unauthorized/);
		client.removeAllListeners();
	});

	test("replayed ticket surfaces as a 403 to the second connection", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const first = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`, {
			headers: { origin: "https://host.example" },
		});
		await new Promise<void>((resolve, reject) => {
			first.once("open", () => resolve());
			first.once("error", reject);
		});
		await upstream.connected;
		first.close();
		await new Promise<void>((resolve) => first.once("close", () => resolve()));

		const second = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`, {
			headers: { origin: "https://host.example" },
		});
		const errorMessage = await new Promise<string>((resolve) => {
			second.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/403|Forbidden/);
		second.removeAllListeners();
	});

	test("origin mismatch surfaces as a 401/403 (consume returns null)", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`, {
			headers: { origin: "https://evil.example" },
		});
		const errorMessage = await new Promise<string>((resolve) => {
			client.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/401|403|Unauthorized|Forbidden/);
		client.removeAllListeners();
	});

	test("missing Origin surfaces as a 401 (proxy refuses upgrade)", async () => {
		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`);
		const errorMessage = await new Promise<string>((resolve) => {
			client.once("error", (error) => resolve(error instanceof Error ? error.message : String(error)));
		});
		expect(errorMessage).toMatch(/401|Unauthorized/);
		client.removeAllListeners();
	});

	test("upstream connection failure surfaces to the client and closes both ends", async () => {
		// Recreate proxy against a port nobody listens on.
		await proxy.close();
		await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
		await upstream.stop();

		const brokenConfig: VoiceEngineConfig = {
			upstreamUrl: "ws://127.0.0.1:1", // port 1 is reserved; nothing listens here
			upstreamToken: "upstream-secret-DO-NOT-LEAK",
		};
		const brokenProxy = createVoiceEngineUpgradeHandler({
			tickets,
			config: brokenConfig,
			onError: (error) => logSpy.push(error instanceof Error ? error.message : String(error)),
		});
		const bound = await bindProxyUpgrade(brokenProxy);
		proxyServer = bound.server;
		proxyPort = bound.port;
		proxy = brokenProxy;

		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`, {
			headers: { origin: "https://host.example" },
		});
		const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
			client.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
			client.once("error", () => {
				// ignore; close event will follow
			});
			setTimeout(() => reject(new Error("upstream failure did not propagate within 5s")), 5_000);
		});
		expect(typeof closeEvent.code).toBe("number");
		client.removeAllListeners();
	});

	test("upstream token does not appear verbatim in proxy error logs", async () => {
		await proxy.close();
		await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
		await upstream.stop();

		const brokenConfig: VoiceEngineConfig = {
			upstreamUrl: "ws://127.0.0.1:1",
			upstreamToken: "upstream-secret-DO-NOT-LEAK",
		};
		const brokenProxy = createVoiceEngineUpgradeHandler({
			tickets,
			config: brokenConfig,
			onError: (error) => logSpy.push(error instanceof Error ? error.message : String(error)),
		});
		const bound = await bindProxyUpgrade(brokenProxy);
		proxyServer = bound.server;
		proxyPort = bound.port;
		proxy = brokenProxy;

		const ticket = await issueTicket(tickets, "https://host.example");
		const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/voice-engine/v1/ws?ticket=${ticket}`, {
			headers: { origin: "https://host.example" },
		});
		await new Promise<void>((resolve) => client.once("close", () => resolve()));
		client.removeAllListeners();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(logSpy.length).toBeGreaterThan(0);
		for (const line of logSpy) {
			expect(line).not.toContain("upstream-secret-DO-NOT-LEAK");
		}
	});

	test("redacting sink replaces an upstream token registered via SecretRegistry", () => {
		// Mirror what composeEmbedPlane does: register upstream token into the
		// SecretRegistry, then route any line through createRedactingSink before
		// it reaches the real log.
		const secrets = createSecretRegistry();
		secrets.register("upstream-secret-DO-NOT-LEAK");
		const captured: string[] = [];
		const log = createRedactingSink(
			(line) => captured.push(line),
			() => secrets.list(),
		);

		log("connecting to upstream with Bearer upstream-secret-DO-NOT-LEAK");
		expect(captured).toHaveLength(1);
		expect(captured[0]).not.toContain("upstream-secret-DO-NOT-LEAK");
		expect(captured[0]).toContain("[REDACTED]");
		// A query param containing the token would also be redacted.
		expect(captured[0]).not.toContain("Bearer upstream-secret-DO-NOT-LEAK");
	});
});

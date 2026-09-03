import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
	shouldVoiceEngineToggleConnect,
	VoiceEngineTransport,
	type WebSocketLike,
} from "../../src/embed/voice-engine-transport.ts";

beforeAll(() => {
	// Transport resolves the relative `voiceEngineUrl` against
	// `window.location.origin`. Vitest runs in node by default; stub a
	// minimal `window` so URL construction works.
	vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:3000", protocol: "http:" } } as unknown as Window &
		typeof globalThis);
});

afterAll(() => {
	vi.unstubAllGlobals();
});

type FakeListener = (event: { readonly data?: unknown }) => void;

class FakeWebSocket implements WebSocketLike {
	url: string;
	readonly sent: string[] = [];
	closeCalls = 0;
	private readonly listeners = new Map<"open" | "message" | "close" | "error", Set<FakeListener>>();

	constructor(url: string) {
		this.url = url;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closeCalls += 1;
		this.fire("close", {});
	}

	open(): void {
		this.fire("open", {});
	}

	error(): void {
		this.fire("error", {});
	}

	receiveMessage(data: string): void {
		this.fire("message", { data });
	}

	addEventListener(type: "open" | "message" | "close" | "error", listener: FakeListener): void {
		let set = this.listeners.get(type);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: "open" | "message" | "close" | "error", listener: FakeListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	private fire(type: "open" | "message" | "close" | "error", event: { readonly data?: unknown }): void {
		const set = this.listeners.get(type);
		if (set === undefined) return;
		for (const listener of [...set]) listener(event);
	}
}

describe("VoiceEngineTransport", () => {
	test("moves to connecting then connected when the WS opens", async () => {
		const socket = new FakeWebSocket("");
		const status: string[] = [];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-1",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			onStatus: (s) => status.push(s),
			wsFactory: (url) => {
				socket.url = url;
				return socket as unknown as WebSocketLike;
			},
		});
		await transport.connect("token-A");
		expect(status).toEqual(["connecting"]);
		socket.open();
		expect(status).toEqual(["connecting", "connected"]);
		expect(socket.url).toBe("ws://127.0.0.1:3000/api/voice-engine/v1/ws?ticket=T-1");
		transport.close();
	});

	test("appends ticket as a query param on a relative voiceEngineUrl", async () => {
		const socket = new FakeWebSocket("");
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-2",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			wsFactory: (url) => {
				socket.url = url;
				return socket as unknown as WebSocketLike;
			},
		});
		await transport.connect("token-A");
		expect(socket.url).toContain("?ticket=T-2");
		expect(socket.url.startsWith("ws://")).toBe(true);
		expect(socket.url.endsWith("/api/voice-engine/v1/ws?ticket=T-2")).toBe(true);
		transport.close();
	});

	test("send returns true only when the transport is connected", async () => {
		const socket = new FakeWebSocket("");
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-3",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			wsFactory: () => socket as unknown as WebSocketLike,
		});
		// before connect: send returns false and is a no-op
		expect(transport.send("frame-before-connect")).toBe(false);
		await transport.connect("token-A");
		// still connecting, send returns false
		expect(transport.send("frame-while-connecting")).toBe(false);
		socket.open();
		expect(transport.send("frame-connected")).toBe(true);
		expect(socket.sent).toEqual(["frame-connected"]);
		transport.close();
	});

	test("delivers VoxEMW text frames and detaches the listener on close", async () => {
		const socket = new FakeWebSocket("");
		const messages: string[] = [];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-message",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			onMessage: (data) => messages.push(data),
			wsFactory: () => socket,
		});
		await transport.connect("token-A");
		socket.open();
		socket.receiveMessage('{"type":"asr.final"}');
		expect(messages).toEqual(['{"type":"asr.final"}']);
		transport.close();
		socket.receiveMessage("late");
		expect(messages).toHaveLength(1);
	});

	test("close transitions to closed and disposes the underlying socket", async () => {
		const socket = new FakeWebSocket("");
		const status: string[] = [];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-4",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			onStatus: (s) => status.push(s),
			wsFactory: () => socket as unknown as WebSocketLike,
		});
		await transport.connect("token-A");
		socket.open();
		transport.close();
		expect(status).toContain("closed");
		expect(socket.closeCalls).toBe(1);
		// close is idempotent
		transport.close();
		expect(socket.closeCalls).toBe(1);
	});

	test("server-initiated close transitions to closed and disables send", async () => {
		const socket = new FakeWebSocket("");
		const status: string[] = [];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-5",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			onStatus: (s) => status.push(s),
			wsFactory: () => socket as unknown as WebSocketLike,
		});
		await transport.connect("token-A");
		socket.open();
		socket.close();
		expect(status[status.length - 1]).toBe("closed");
		expect(transport.send("after-close")).toBe(false);
	});

	test("ws error transitions to closed", async () => {
		const socket = new FakeWebSocket("");
		const status: string[] = [];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-6",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			onStatus: (s) => status.push(s),
			wsFactory: () => socket as unknown as WebSocketLike,
		});
		await transport.connect("token-A");
		socket.open();
		socket.error();
		expect(status[status.length - 1]).toBe("closed");
	});

	test("getTicket failure closes the transport (no retry in this task)", async () => {
		const socket = new FakeWebSocket("");
		const status: string[] = [];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => {
				throw new Error("ticket 503");
			}),
			onStatus: (s) => status.push(s),
			wsFactory: () => socket as unknown as WebSocketLike,
		});
		await transport.connect("token-A");
		expect(status).toEqual(["connecting", "closed"]);
		expect(socket.closeCalls).toBe(0);
	});

	test("tears down the previous socket when connect() is invoked a second time", async () => {
		const first = new FakeWebSocket("");
		const second = new FakeWebSocket("");
		const sockets: WebSocketLike[] = [first, second];
		const transport = new VoiceEngineTransport({
			getTicket: vi.fn(async () => ({
				ticket: "T-7",
				expiresAt: "2030-01-01T00:00:00Z",
				voiceEngineUrl: "/api/voice-engine/v1/ws",
			})),
			wsFactory: (url) => {
				const next = sockets.shift();
				if (!next) throw new Error("no socket queued");
				(next as FakeWebSocket).url = url;
				return next as unknown as WebSocketLike;
			},
		});
		await transport.connect("token-A");
		expect(first.closeCalls).toBe(0);
		await transport.connect("token-B");
		expect(first.closeCalls).toBe(1);
		expect((second as FakeWebSocket).url).toContain("?ticket=T-7");
		transport.close();
	});
});

describe("shouldVoiceEngineToggleConnect (Task 5 composer button rule)", () => {
	test("requests connect when the transport is idle or has just closed", () => {
		expect(shouldVoiceEngineToggleConnect("disconnected")).toBe(true);
		expect(shouldVoiceEngineToggleConnect("closed")).toBe(true);
	});

	test("requests close when the transport is busy (connecting) or live (connected)", () => {
		expect(shouldVoiceEngineToggleConnect("connecting")).toBe(false);
		expect(shouldVoiceEngineToggleConnect("connected")).toBe(false);
	});
});

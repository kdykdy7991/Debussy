import type { ResponseEnvelope } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { PiServer } from "../src/index.ts";
import { connectWebSocketTestClient, type ProtocolTestClient, TestSessionBackend } from "../src/testing/index.ts";
import { createWebSocketServer, type WebSocketServerOptions } from "../src/transports/websocket/index.ts";

const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

async function startServer(backend = new TestSessionBackend(), overrides: Partial<WebSocketServerOptions> = {}) {
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

function progress(delta: string) {
	return {
		type: "assistant_delta" as const,
		messageId: "assistant-1",
		contentIndex: 0,
		kind: "text" as const,
		delta,
	};
}

function progressSequences(client: ProtocolTestClient): number[] {
	return client.messages
		.filter((message) => message.type === "event" && message.event.type === "session_progress")
		.map((message) =>
			message.type === "event" && message.event.type === "session_progress" ? message.event.sequence : -1,
		);
}

async function resume(client: ProtocolTestClient, sessionId: string, afterSequence: number): Promise<ResponseEnvelope> {
	const response = client.next((message) => message.type === "response" && message.id === "resume-1");
	await client.sendMessage({
		type: "request",
		id: "resume-1",
		request: { command: "resume", sessionId, afterSequence },
	});
	return (await response) as ResponseEnvelope;
}

describe("protocol v2 resume", () => {
	test("resume replays events missed after a disconnect", async () => {
		const backend = new TestSessionBackend();
		backend.seed("session-1");
		const { url } = await startServer(backend);

		const client1 = await connect(url);
		await client1.hello();
		await client1.request({ command: "attach", sessionId: "session-1" });
		const runtime = backend.latestRuntime("session-1");
		runtime.emitProgress(progress("a"));
		runtime.emitProgress(progress("b"));
		runtime.emitProgress(progress("c"));
		await client1.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sequence === 3,
		);
		await client1.close();

		const client2 = await connect(url);
		await client2.hello();
		const response = await resume(client2, "session-1", 1);
		expect(response).toMatchObject({ type: "response", id: "resume-1", ok: true });
		if (!response.ok || response.result.command !== "resume") throw new Error("Expected resume result");
		expect(response.result).toMatchObject({
			command: "resume",
			replayedThrough: 3,
			resetRequired: false,
			session: { id: "session-1", lastSequence: 3 },
		});
		expect(progressSequences(client2)).toEqual([2, 3]);
	});

	test("resume with a fresh afterSequence replays the whole buffer", async () => {
		const backend = new TestSessionBackend();
		backend.seed("session-1");
		const { url } = await startServer(backend);

		const client1 = await connect(url);
		await client1.hello();
		await client1.request({ command: "attach", sessionId: "session-1" });
		const runtime = backend.latestRuntime("session-1");
		runtime.emitProgress(progress("a"));
		runtime.emitProgress(progress("b"));
		await client1.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sequence === 2,
		);
		await client1.close();

		const client2 = await connect(url);
		await client2.hello();
		const response = await resume(client2, "session-1", 0);
		if (!response.ok || response.result.command !== "resume") throw new Error("Expected resume result");
		expect(response.result).toMatchObject({ command: "resume", replayedThrough: 2, resetRequired: false });
		expect(progressSequences(client2)).toEqual([1, 2]);
	});

	test("resume after the buffer expires returns a recognizable reset", async () => {
		const backend = new TestSessionBackend();
		backend.seed("session-1");
		const { url } = await startServer(backend, { sessionEventLogMaxEvents: 1 });

		const client1 = await connect(url);
		await client1.hello();
		await client1.request({ command: "attach", sessionId: "session-1" });
		const runtime = backend.latestRuntime("session-1");
		runtime.emitProgress(progress("a"));
		runtime.emitProgress(progress("b"));
		runtime.emitProgress(progress("c"));
		await client1.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sequence === 3,
		);
		await client1.close();

		const client2 = await connect(url);
		await client2.hello();
		const response = await resume(client2, "session-1", 1);
		if (!response.ok || response.result.command !== "resume") throw new Error("Expected resume result");
		expect(response.result).toMatchObject({ command: "resume", replayedThrough: 3, resetRequired: true });
		expect(response.result.session.lastSequence).toBe(3);
		expect(progressSequences(client2)).toEqual([]);
	});

	test("resume with a future afterSequence resets to the authoritative snapshot", async () => {
		const backend = new TestSessionBackend();
		backend.seed("session-1");
		const { url } = await startServer(backend);

		const client = await connect(url);
		await client.hello();
		await client.request({ command: "attach", sessionId: "session-1" });
		const runtime = backend.latestRuntime("session-1");
		runtime.emitProgress(progress("a"));
		runtime.emitProgress(progress("b"));
		await client.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sequence === 2,
		);

		const response = await resume(client, "session-1", 5);
		if (!response.ok || response.result.command !== "resume") throw new Error("Expected resume result");
		expect(response.result).toMatchObject({ command: "resume", replayedThrough: 2, resetRequired: true });
	});

	test("resume on an unknown session rejects with not_found", async () => {
		const { url } = await startServer();
		const client = await connect(url);
		await client.hello();
		const response = await client.request({ command: "resume", sessionId: "ghost", afterSequence: 0 });
		expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	test("repeated resumes on a live session do not create new runtimes", async () => {
		const backend = new TestSessionBackend();
		backend.seed("session-1");
		const { url } = await startServer(backend);

		const client = await connect(url);
		await client.hello();
		await client.request({ command: "attach", sessionId: "session-1" });
		const runtime = backend.latestRuntime("session-1");
		runtime.emitProgress(progress("a"));
		await client.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sequence === 1,
		);

		const first = await resume(client, "session-1", 0);
		expect(first.ok).toBe(true);
		const second = await resume(client, "session-1", 0);
		expect(second.ok).toBe(true);
		expect(backend.runtimes.get("session-1")).toHaveLength(1);
	});

	test("resume on one session does not replay another session's events", async () => {
		const backend = new TestSessionBackend();
		backend.seed("a");
		backend.seed("b");
		const { url } = await startServer(backend);

		const client = await connect(url);
		await client.hello();
		await client.request({ command: "attach", sessionId: "a" });
		backend.latestRuntime("a").emitProgress(progress("x"));
		await client.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sequence === 1,
		);

		const response = await resume(client, "b", 0);
		if (!response.ok || response.result.command !== "resume") throw new Error("Expected resume result");
		expect(response.result).toMatchObject({ command: "resume", replayedThrough: 0, resetRequired: false });
		const replayed = client.messages.filter(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.sessionId === "b",
		);
		expect(replayed).toHaveLength(0);
	});
});

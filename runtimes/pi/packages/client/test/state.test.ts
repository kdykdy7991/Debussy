import type { EventEnvelope, ServerEvent } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { attachSession, collectRequests, connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

function progressEvent(sequence: number, delta = `d${sequence}`): EventEnvelope {
	return {
		type: "event",
		event: {
			type: "session_progress",
			sessionId: "session-1",
			turnId: "turn-1",
			sequence,
			progress: {
				type: "assistant_delta",
				messageId: "assistant-1",
				contentIndex: 0,
				kind: "text",
				delta,
			},
		},
	};
}

describe("PiClient", () => {
	test("reduces only authoritative snapshots and supports unsubscribe", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const initial = sessionSnapshot("session-1", { revision: 1, phase: "idle" });
		const handle = await attachSession(client, server, initial);
		const observed: number[] = [];
		const progressTypes: string[] = [];
		const unsubscribe = handle.subscribe((snapshot) => observed.push(snapshot.revision));
		const unsubscribeEvents = handle.onEvent((event) => progressTypes.push(event.type));
		server.send({
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				progress: {
					type: "assistant_delta",
					messageId: "assistant-1",
					contentIndex: 0,
					kind: "text",
					delta: "hi",
				},
			},
		});
		expect(progressTypes).toEqual(["session_progress"]);
		expect(handle.snapshot).toEqual(initial);

		const prompting = handle.prompt("hello");
		expect(handle.snapshot).toEqual(initial);
		const promptRequest = requests.find((request) => request.request.command === "prompt");
		if (!promptRequest) throw new Error("Missing prompt request");
		const updated = sessionSnapshot("session-1", { revision: 2, phase: "turn" });
		server.send({
			type: "response",
			id: promptRequest.id,
			ok: true,
			result: { command: "prompt", session: updated },
		});
		await expect(prompting).resolves.toEqual(updated);
		expect(handle.snapshot).toEqual(updated);
		expect(observed).toEqual([2]);

		unsubscribe();
		unsubscribeEvents();
		server.send({
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 3 }) },
		});
		expect(observed).toEqual([2]);
	});

	test("does not let a delayed command response replace a newer event snapshot", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const initial = sessionSnapshot("session-1", { revision: 1, thinkingLevel: "off" });
		const handle = await attachSession(client, server, initial);
		const requests = collectRequests(server);
		const changing = handle.setThinking("high");
		const request = requests.find((candidate) => candidate.request.command === "set_thinking");
		if (!request) throw new Error("Missing set_thinking request");
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { revision: 3, thinkingLevel: "high" }),
			},
		});
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: {
				command: "set_thinking",
				session: sessionSnapshot("session-1", { revision: 2, thinkingLevel: "medium" }),
			},
		});

		await changing;
		expect(handle.snapshot).toMatchObject({ revision: 3, thinkingLevel: "high" });
	});

	test("does not let an attach response replace a newer snapshot from the reacquired runtime", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { revision: 10, attached: false }),
			},
		});
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "attach") return;
			server.send({
				type: "event",
				event: {
					type: "session_snapshot",
					snapshot: sessionSnapshot("session-1", { revision: 3, thinkingLevel: "high" }),
				},
			});
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: {
					command: "attach",
					session: sessionSnapshot("session-1", { revision: 2, thinkingLevel: "medium" }),
				},
			});
		});

		const handle = await client.attachSession("session-1");
		expect(handle.snapshot).toMatchObject({ revision: 3, thinkingLevel: "high" });
	});

	test("drops duplicate and snapshot-covered session progress events", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const handle = await attachSession(client, server, sessionSnapshot("session-1", { revision: 1 }));
		const seen: ServerEvent[] = [];
		handle.onEvent((event) => seen.push(event));

		server.send(progressEvent(1));
		server.send(progressEvent(1)); // duplicate sequence
		expect(seen).toHaveLength(1);

		// A snapshot that already covers sequence 2 suppresses a late sequence-2 event.
		server.send({
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 2, lastSequence: 2 }) },
		});
		server.send(progressEvent(2));
		expect(seen).toHaveLength(2);
		expect(seen[1]).toMatchObject({ type: "session_snapshot" });

		// A higher sequence is still delivered.
		server.send(progressEvent(3));
		expect(seen).toHaveLength(3);
	});

	test("re-attaching a session after reconnect resumes from the last sequence", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		await attachSession(client, server, sessionSnapshot("session-1", { revision: 1 }));
		server.send(progressEvent(1));

		// Simulate a network drop, then reconnect to the same server.
		server.close();
		await client.connect();

		const reacquire = client.attachSession("session-1");
		const resumeRequest = requests.find((request) => request.request.command === "resume");
		expect(resumeRequest).toBeDefined();
		if (!resumeRequest || resumeRequest.request.command !== "resume") throw new Error("Expected a resume request");
		expect(resumeRequest.request.afterSequence).toBe(1);
		server.send({
			type: "response",
			id: resumeRequest.id,
			ok: true,
			result: {
				command: "resume",
				session: sessionSnapshot("session-1", { revision: 2, lastSequence: 2 }),
				replayedThrough: 2,
				resetRequired: false,
			},
		});
		const reacquired = await reacquire;
		expect(reacquired.snapshot).toMatchObject({ id: "session-1", revision: 2, lastSequence: 2 });
	});
});

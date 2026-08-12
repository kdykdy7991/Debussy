import type { Attachment, Citation, EventEnvelope, ServerEvent, Source } from "@earendil-works/pi-protocol";
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
		await expect(prompting).resolves.toEqual({ command: "prompt", session: updated });
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

describe("attachment commands and events", () => {
	function attachment(id: string): Attachment {
		return {
			id,
			name: `${id}.txt`,
			mediaType: "text/plain",
			size: 4,
			sha256: "abc",
			status: "ready",
			scope: "turn",
			createdAt: 1,
		};
	}

	async function attachedHandle() {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const handle = await attachSession(client, server, sessionSnapshot("session-1", { attached: true }));
		return { server, client, handle };
	}

	test("attach_upload sends the command and applies the returned snapshot", async () => {
		const { server, handle } = await attachedHandle();
		const requests = collectRequests(server);
		const attaching = handle.attachUpload("upload-1", "turn");
		const request = requests.find((candidate) => candidate.request.command === "attach_upload");
		expect(request).toBeDefined();
		if (!request || request.request.command !== "attach_upload") throw new Error("missing attach_upload");
		expect(request.request).toMatchObject({ sessionId: "session-1", uploadId: "upload-1", scope: "turn" });
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: {
				command: "attach_upload",
				session: sessionSnapshot("session-1", { attached: true, attachments: [attachment("upload-1")] }),
			},
		});
		const snapshot = await attaching;
		expect(snapshot.attachments?.map((a) => a.id)).toEqual(["upload-1"]);
		expect(handle.snapshot?.attachments?.map((a) => a.id)).toEqual(["upload-1"]);
	});

	test("remove_attachment sends the command and drops the attachment from the snapshot", async () => {
		const { server, handle } = await attachedHandle();
		const requests = collectRequests(server);
		const removing = handle.removeAttachment("upload-1");
		const request = requests.find((candidate) => candidate.request.command === "remove_attachment");
		expect(request).toBeDefined();
		if (!request || request.request.command !== "remove_attachment") throw new Error("missing remove_attachment");
		expect(request.request).toMatchObject({ sessionId: "session-1", attachmentId: "upload-1" });
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: {
				command: "remove_attachment",
				session: sessionSnapshot("session-1", { attached: true }),
			},
		});
		const snapshot = await removing;
		expect(snapshot.attachments ?? []).toEqual([]);
	});

	test("attachment_snapshot event merges an attachment into the session snapshot", async () => {
		const { server, handle } = await attachedHandle();
		const events: ServerEvent[] = [];
		handle.onEvent((event) => events.push(event));
		server.send({
			type: "event",
			event: { type: "attachment_snapshot", attachment: { ...attachment("upload-1"), sessionId: "session-1" } },
		});
		expect(handle.snapshot?.attachments?.map((a) => a.id)).toEqual(["upload-1"]);
		expect(events.some((event) => event.type === "attachment_snapshot")).toBe(true);
	});

	test("attachment_removed event drops the attachment from the session snapshot", async () => {
		const { server, handle } = await attachedHandle();
		server.send({
			type: "event",
			event: { type: "attachment_snapshot", attachment: { ...attachment("upload-1"), sessionId: "session-1" } },
		});
		expect(handle.snapshot?.attachments?.map((a) => a.id)).toEqual(["upload-1"]);
		server.send({
			type: "event",
			event: { type: "attachment_removed", sessionId: "session-1", attachmentId: "upload-1" },
		});
		expect(handle.snapshot?.attachments ?? []).toEqual([]);
	});

	test("prompt carries optional attachmentIds", async () => {
		const { server, handle } = await attachedHandle();
		const requests = collectRequests(server);
		const prompting = handle.prompt("read this", { attachmentIds: ["upload-1"] });
		const request = requests.find((candidate) => candidate.request.command === "prompt");
		expect(request).toBeDefined();
		if (!request || request.request.command !== "prompt") throw new Error("missing prompt");
		expect(request.request).toMatchObject({ text: "read this", attachmentIds: ["upload-1"] });
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { attached: true }) },
		});
		await prompting;
	});
});

describe("P2 citation events", () => {
	function source(id: string): Source {
		return {
			id,
			attachmentId: `att-${id}`,
			sessionId: "session-1",
			name: `${id}.txt`,
			mediaType: "text/plain",
			status: "ready",
			version: 1,
			createdAt: 1,
			updatedAt: 1,
		};
	}

	function citation(id: string): Citation {
		return {
			id,
			sessionId: "session-1",
			turnId: "turn-1",
			sourceId: "source-1",
			chunkId: "chunk-1",
			ordinal: 0,
			title: "notes.txt",
			excerpt: "excerpt",
			startLine: 1,
			endLine: 2,
			score: 1.2,
		};
	}

	async function attachedHandle() {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const handle = await attachSession(client, server, sessionSnapshot("session-1", { attached: true }));
		return { server, client, handle };
	}

	test("source_snapshot event merges a source into the session snapshot", async () => {
		const { server, handle } = await attachedHandle();
		server.send({
			type: "event",
			event: { type: "source_snapshot", source: source("source-1") },
		});
		expect(handle.snapshot?.sources?.map((s) => s.id)).toEqual(["source-1"]);
	});

	test("source_snapshot event replaces an existing source with the same id", async () => {
		const { server, handle } = await attachedHandle();
		server.send({ type: "event", event: { type: "source_snapshot", source: source("source-1") } });
		server.send({
			type: "event",
			event: { type: "source_snapshot", source: { ...source("source-1"), status: "failed" } },
		});
		expect(handle.snapshot?.sources?.map((s) => s.status)).toEqual(["failed"]);
	});

	test("citation_snapshot event sets the current turn citations", async () => {
		const { server, handle } = await attachedHandle();
		const events: ServerEvent[] = [];
		handle.onEvent((event) => events.push(event));
		server.send({
			type: "event",
			event: {
				type: "citation_snapshot",
				sessionId: "session-1",
				turnId: "turn-1",
				citations: [citation("citation-1")],
			},
		});
		expect(handle.snapshot?.citations?.map((c) => c.id)).toEqual(["citation-1"]);
		expect(events.some((event) => event.type === "citation_snapshot")).toBe(true);
	});

	test("citation_snapshot event replaces prior citations for the turn", async () => {
		const { server, handle } = await attachedHandle();
		server.send({
			type: "event",
			event: {
				type: "citation_snapshot",
				sessionId: "session-1",
				turnId: "turn-1",
				citations: [citation("citation-1")],
			},
		});
		server.send({
			type: "event",
			event: { type: "citation_snapshot", sessionId: "session-1", turnId: "turn-1", citations: [] },
		});
		expect(handle.snapshot?.citations).toEqual([]);
	});
});

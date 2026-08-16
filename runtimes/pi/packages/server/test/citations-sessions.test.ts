import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, ServerEvent } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { attachmentStoreReader, CitationService } from "../src/citations/service.ts";
import { CitationStore } from "../src/citations/store.ts";
import type { PiServer } from "../src/index.ts";
import { connectUnixTestClient, type ProtocolTestClient, TestSessionBackend } from "../src/testing/index.ts";
import { createUnixServer } from "../src/transports/unix/index.ts";
import { AttachmentStore } from "../src/uploads/store.ts";

const tempDirs = new Set<string>();
const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

interface Harness {
	backend: TestSessionBackend;
	attachments: AttachmentStore;
	citations: CitationService;
	server: PiServer;
}

async function makeHarness(): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "p2-cit-session-"));
	tempDirs.add(dir);
	const attachments = new AttachmentStore(join(dir, "uploads"));
	await attachments.init();
	const citationStore = new CitationStore(join(dir, "citations"));
	await citationStore.init();
	const citations = new CitationService({ store: citationStore, readContent: attachmentStoreReader(attachments) });
	const backend = new TestSessionBackend();
	const server = createUnixServer(backend, {
		path: join(dir, "server.sock"),
		attachments,
		citations,
	});
	servers.add(server);
	await server.start();
	return { backend, attachments, citations, server };
}

async function connect(server: PiServer): Promise<ProtocolTestClient> {
	const client = await connectUnixTestClient(server.addresses[0]!);
	clients.add(client);
	return client;
}

async function attach(client: ProtocolTestClient, sessionId: string) {
	const response = await client.request({ command: "attach", sessionId });
	if (!response.ok || response.result.command !== "attach") throw new Error("Attach failed");
	return response.result.session;
}

async function seedAndAttach(harness: Harness): Promise<{ client: ProtocolTestClient; sessionId: string }> {
	const sessionId = "session-1";
	harness.backend.seed(sessionId);
	const client = await connect(harness.server);
	await client.hello();
	await attach(client, sessionId);
	return { client, sessionId };
}

/** Stage and adopt a text attachment already bound to a session. */
async function adoptText(
	harness: Harness,
	id: string,
	sessionId: string,
	name: string,
	content: string,
): Promise<Attachment> {
	mkdirSync(join(harness.attachments.root, id), { recursive: true });
	const staged = join(harness.attachments.root, id, "file.txt");
	writeFileSync(staged, content, "utf-8");
	const attachment: Attachment = {
		id,
		sessionId,
		name,
		mediaType: "text/plain",
		size: content.length,
		sha256: "abc",
		status: "ready",
		createdAt: Date.now(),
	};
	await harness.attachments.adopt(attachment, staged);
	return attachment;
}

/** Wait for the source of `attachmentId` to reach `status` on the wire. */
function nextSourceStatus(client: ProtocolTestClient, attachmentId: string, status: string) {
	return client.next(
		(message) =>
			message.type === "event" &&
			message.event.type === "source_snapshot" &&
			message.event.source.attachmentId === attachmentId &&
			message.event.source.status === status,
	);
}

function eventsOf(client: ProtocolTestClient, type: string): ServerEvent[] {
	return client.messages
		.filter((message): message is Extract<typeof message, { type: "event" }> => message.type === "event")
		.map((message) => message.event)
		.filter((event) => event.type === type);
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
});

describe("P2 citation session flow", () => {
	test("indexes a text attachment, retrieves on prompt, and broadcasts citations", async () => {
		const harness = await makeHarness();
		const { client, sessionId } = await seedAndAttach(harness);
		await adoptText(harness, "att-1", sessionId, "notes.txt", "replay buffer behavior\n\nprotocol version two");

		// attach_upload starts background indexing; wait for the ready source.
		await client.request({ command: "attach_upload", sessionId, uploadId: "att-1", scope: "turn" });
		const readyEvent = await nextSourceStatus(client, "att-1", "ready");
		if (readyEvent.type !== "event" || readyEvent.event.type !== "source_snapshot")
			throw new Error("Expected a source event");
		expect(readyEvent.event.source).toMatchObject({
			attachmentId: "att-1",
			sessionId,
			name: "notes.txt",
			status: "ready",
		});

		// The ready source is part of the session snapshot.
		const before = await attach(client, sessionId);
		expect(before.sources?.map((source) => source.id)).toContain("source-att-1");

		const prompt = client.request({
			command: "prompt",
			sessionId,
			text: "how does the replay buffer work",
			attachmentIds: ["att-1"],
		});
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		harness.backend.latestRuntime(sessionId).finishPrompt();
		const response = await prompt;
		expect(response.ok).toBe(true);
		if (!response.ok || response.result.command !== "prompt") throw new Error("Prompt failed");
		expect(response.result.session.sources).toHaveLength(1);
		const turnCitations = response.result.session.citations ?? [];
		expect(turnCitations.length).toBeGreaterThan(0);
		expect(turnCitations[0]!.title).toBe("notes.txt");

		// The runtime received the retrieval context, and the covered attachment
		// is injected as retrieval context instead of the P1 full text.
		const input = harness.backend.latestRuntime(sessionId).promptInputs[0];
		expect(input?.attachments).toEqual([]);
		expect(input?.retrieval?.citations.length).toBeGreaterThan(0);
		expect(input?.retrieval?.context).toContain("replay buffer");
		expect(input?.retrieval?.context).toContain(`file="notes.txt"`);

		// citation_snapshot is broadcast once near the end of the turn.
		const citationEvent = await client.next(
			(message) => message.type === "event" && message.event.type === "citation_snapshot",
		);
		if (citationEvent.type !== "event" || citationEvent.event.type !== "citation_snapshot")
			throw new Error("Expected a citation event");
		expect(citationEvent.event.citations).toEqual(turnCitations);
	});

	test("rejects a prompt whose source is still indexing", async () => {
		const harness = await makeHarness();
		const { client, sessionId } = await seedAndAttach(harness);
		const attachment = await adoptText(harness, "att-pending", sessionId, "slow.txt", "still indexing content");
		// Pre-seed a pending source so background indexing never completes.
		await harness.citations.store.saveSource({
			id: `source-${attachment.id}`,
			attachmentId: attachment.id,
			sessionId,
			name: attachment.name,
			mediaType: attachment.mediaType,
			status: "pending",
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const response = await client.request({
			command: "prompt",
			sessionId,
			text: "hi",
			attachmentIds: [attachment.id],
		});
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("Expected the prompt to fail");
		expect(response.error?.code).toBe("invalid_state");
	});

	test("removing an attachment removes its source and blocks new citations", async () => {
		const harness = await makeHarness();
		const { client, sessionId } = await seedAndAttach(harness);
		await adoptText(harness, "att-1", sessionId, "notes.txt", "replay buffer content");
		await client.request({ command: "attach_upload", sessionId, uploadId: "att-1", scope: "turn" });
		await nextSourceStatus(client, "att-1", "ready");

		await client.request({ command: "remove_attachment", sessionId, attachmentId: "att-1" });
		const removedEvent = await nextSourceStatus(client, "att-1", "removed");
		if (removedEvent.type !== "event" || removedEvent.event.type !== "source_snapshot")
			throw new Error("Expected a source event");
		expect(removedEvent.event.source.attachmentId).toBe("att-1");

		// The removed source no longer participates.
		expect(harness.citations.listSourcesBySession(sessionId)).toHaveLength(0);
		const after = await attach(client, sessionId);
		expect((after.sources ?? []).map((source) => source.id)).not.toContain("source-att-1");

		// A prompt referencing the removed attachment is rejected rather than cited.
		const response = await client.request({
			command: "prompt",
			sessionId,
			text: "replay buffer",
			attachmentIds: ["att-1"],
		});
		expect(response.ok).toBe(false);
	});

	test("reconnects restore the last turn's citations without re-broadcasting them", async () => {
		const harness = await makeHarness();
		const { client, sessionId } = await seedAndAttach(harness);
		await adoptText(harness, "att-1", sessionId, "notes.txt", "replay buffer content");
		await client.request({ command: "attach_upload", sessionId, uploadId: "att-1", scope: "turn" });
		await nextSourceStatus(client, "att-1", "ready");

		const prompt = client.request({
			command: "prompt",
			sessionId,
			text: "replay buffer",
			attachmentIds: ["att-1"],
		});
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const runtime = harness.backend.latestRuntime(sessionId);
		runtime.finishPrompt();
		const response = await prompt;
		expect(response.ok).toBe(true);
		if (!response.ok || response.result.command !== "prompt") throw new Error("Prompt failed");
		const turnCitations = response.result.session.citations ?? [];
		expect(turnCitations.length).toBeGreaterThan(0);
		await client.next((message) => message.type === "event" && message.event.type === "citation_snapshot");

		// Clean disconnect disposes the idle runtime.
		await client.close();
		await runtime.disposed.promise;

		// A fresh connection restores the turn's citations from the store.
		const fresh = await connect(harness.server);
		await fresh.hello();
		const restored = await attach(fresh, sessionId);
		expect(restored.citations).toEqual(turnCitations);
		// Restoration comes from the snapshot, never a duplicate citation_snapshot.
		expect(eventsOf(fresh, "citation_snapshot")).toHaveLength(0);
	});
});

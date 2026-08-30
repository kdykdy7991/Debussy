/**
 * Phase 2C tests for the lazy Debug conversation attachment lifecycle.
 *
 * The Agent Debug page must never create a DebugConversation until the first
 * real message. A selected file uploads immediately (pending chip visible, no
 * conversation) and is only bound + forwarded to the model when Send runs.
 * Removing the pending chip must not create a conversation.
 */

import type { PiSessionHandle } from "@earendil-works/pi-client";
import type { Attachment, ServerSnapshot, SessionSnapshot, SessionSummary } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { LazyDebugSessionController, MutableEnsureAttachedRef } from "../src/lib/lazy-debug-session-controller.ts";
import type { PiSessionClient } from "../src/lib/session-controller.ts";
import type { PiUploadClient } from "../src/lib/uploader.ts";

function makeAttachment(id: string): Attachment {
	return {
		id,
		name: `${id}.txt`,
		mediaType: "text/plain",
		size: 5,
		sha256: "0".repeat(64),
		status: "ready",
		scope: "session",
		createdAt: Date.now(),
	};
}

function sessionSummary(id: string): SessionSummary {
	return {
		id,
		name: "Debug",
		cwd: "/debug",
		createdAt: 0,
		updatedAt: 0,
		phase: "idle",
		model: { provider: "pi", id: "pi:default" },
		thinkingLevel: "off",
		attached: true,
		locked: false,
	};
}

function sessionSnapshot(id: string): SessionSnapshot {
	return {
		id,
		name: "Debug",
		cwd: "/debug",
		createdAt: 0,
		updatedAt: 0,
		phase: "idle",
		model: { provider: "pi", id: "pi:default" },
		thinkingLevel: "off" as const,
		attached: true,
		locked: false,
		lastSequence: 0,
		revision: 0,
		transcript: [],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

interface PromptRecord {
	text: string;
	attachmentIds: string[] | undefined;
}

function emptyServerSnapshot(): ServerSnapshot {
	return {} as unknown as ServerSnapshot;
}

class FakeClient implements PiSessionClient {
	snapshot: ServerSnapshot;
	readonly sessionsCreated: string[] = [];
	readonly attachRequests: string[] = [];
	readonly prompts: PromptRecord[] = [];
	#listeners = new Set<(snapshot: ServerSnapshot) => void>();
	#snapshots = new Map<string, SessionSnapshot>();
	#prompted = false;

	constructor() {
		this.snapshot = emptyServerSnapshot();
	}

	private upsert(sessionId: string): void {
		if (!this.#snapshots.has(sessionId.endsWith("-conv") ? sessionId : sessionId)) {
			this.#snapshots.set(sessionId, sessionSnapshot(sessionId));
		}
		this.notify();
	}

	private notify(): void {
		this.snapshot = {
			listener: {},
			sessions: [...this.#snapshots.values()].map((s) => sessionSummary(s.id)),
			models: [],
		} as unknown as ServerSnapshot;
		for (const l of [...this.#listeners]) l(this.snapshot);
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async createSession(): Promise<PiSessionHandle> {
		const sessionId = `convo-${this.sessionsCreated.length + 1}`;
		this.sessionsCreated.push(sessionId);
		this.upsert(sessionId);
		this.attachRequests.push(sessionId);
		return this.#fakeHandle(sessionId);
	}

	async attachSession(sessionId: string): Promise<PiSessionHandle> {
		this.upsert(sessionId);
		this.attachRequests.push(sessionId);
		return this.#fakeHandle(sessionId);
	}

	#fakeHandle(sessionId: string): PiSessionHandle {
		const handle = {
			id: sessionId,
			active: true,
			attached: true,
			snapshot: this.#snapshots.get(sessionId),
			subscribe: () => () => {},
			onEvent: () => () => {},
			detach: async () => {},
			dispose: async () => {},
			prompt: async (text: string, options?: { attachmentIds?: string[] }) => {
				// Only record the first prompt emission so the assertion is
				// unambiguous; ignore later re-entries from session-switch.
				if (!this.#prompted) {
					this.#prompted = true;
					this.prompts.push({ text, attachmentIds: options?.attachmentIds });
				}
				this.upsert(sessionId);
				return { session: this.#snapshots.get(sessionId)!, command: "prompt" } as never;
			},
			steer: async (text: string, options?: { attachmentIds?: string[] }) => {
				this.prompts.push({ text, attachmentIds: options?.attachmentIds });
				return { session: this.#snapshots.get(sessionId)!, command: "steer" } as never;
			},
			abort: async () => this.#snapshots.get(sessionId)!,
			setModel: async () => this.#snapshots.get(sessionId)!,
			setThinking: async () => this.#snapshots.get(sessionId)!,
			attachUpload: async () => this.#snapshots.get(sessionId)!,
			removeAttachment: async () => this.#snapshots.get(sessionId)!,
			[Symbol.asyncDispose]: async () => {},
		};
		return handle;
	}
}

function makeUploadClient(): PiUploadClient & { uploaded: string[] } {
	const uploaded: string[] = [];
	return {
		uploaded,
		async uploadFile(file): Promise<Attachment> {
			uploaded.push(file.name);
			return makeAttachment(`upload-${uploaded.length}`);
		},
	};
}

describe("LazyDebugSessionController (Phase 2C)", () => {
	it("B. lazy create: select -> chip visible, no conversation; Send -> one conversation -> prompt with attachment ids", async () => {
		const client = new FakeClient();
		const uploads = makeUploadClient();
		const ensureRef = new MutableEnsureAttachedRef();
		const controller = new LazyDebugSessionController(client, uploads, ensureRef);

		await controller.uploadFiles([new File(["hi"], "a.txt")]);

		// Chip visible immediately via the pending list; conversation NOT created.
		expect(client.sessionsCreated.length).toBe(0);
		expect(uploads.uploaded).toEqual(["a.txt"]);
		let snap = controller.getSnapshot();
		expect(snap.uploads.length).toBe(1);
		expect(snap.uploads[0]?.status).toBe("pending-attach");
		expect(snap.uploads[0]?.attachmentId).toBe("upload-1");

		// Send → ensureRef bootstraps one conversation then binds + prompts.
		const ensureDone = (async () => {
			if (controller.activeHandle) return;
			// Any pending attachment must still be an unbound upload at this
			// point — the conversation has only now been created.
			await controller.openDebugSession("convo-1");
		})();
		ensureRef.current = () => ensureDone;
		await controller.send("use it");
		await ensureDone;

		// Exactly ONE conversation was attached (opened once), and the model
		// prompt carried the freshly-bound attachment id.
		expect(client.attachRequests).toEqual(["convo-1"]);
		expect(controller.getPendingAttachments().length).toBe(0);
		snap = controller.getSnapshot();
		expect(snap.uploads.length).toBe(0);
		expect(client.prompts[0]?.attachmentIds).toEqual(["upload-1"]);
	});

	it("K. removing the pending chip before the first Send does not create a conversation", async () => {
		const client = new FakeClient();
		const ensureRef = new MutableEnsureAttachedRef();
		const controller = new LazyDebugSessionController(client, makeUploadClient(), ensureRef);

		await controller.uploadFiles([new File(["hi"], "b.txt")]);
		const pending = controller.getPendingAttachments();
		expect(pending.length).toBe(1);
		expect(client.sessionsCreated.length).toBe(0);

		// Dump the pending chip → no conversation is ever created.
		controller.dismissUpload(pending[0]!.localId);
		expect(controller.getPendingAttachments().length).toBe(0);
		expect(controller.getSnapshot().uploads.length).toBe(0);
		expect(client.sessionsCreated.length).toBe(0);
	});

	it("clearBootstrapping exits the stuck loading state so the blank slate becomes sendable", async () => {
		const client = new FakeClient();
		const ensureRef = new MutableEnsureAttachedRef();
		const controller = new LazyDebugSessionController(client, makeUploadClient(), ensureRef);

		// Fresh controller starts bootstrapping (loading=true, no session).
		expect(controller.getSnapshot().loading).toBe(true);
		expect(controller.getSnapshot().activeSession).toBeUndefined();

		// Bound agent with no DebugConversation yet: the page resolves empty and
		// calls clearBootstrapping — loading clears WITHOUT opening a session.
		controller.clearBootstrapping();
		expect(controller.getSnapshot().loading).toBe(false);
		expect(controller.getSnapshot().activeSession).toBeUndefined();
		expect(client.attachRequests.length).toBe(0);

		// The Composer is now usable: the first Send lazily creates + attaches.
		const ensureDone = (async () => {
			if (controller.activeHandle) return;
			await controller.openDebugSession("convo-1");
		})();
		ensureRef.current = () => ensureDone;
		await controller.send("hello");
		await ensureDone;
		expect(client.attachRequests).toEqual(["convo-1"]);
		expect(controller.getSnapshot().loading).toBe(false);
	});

	it("clearBootstrapping is a no-op once a session is live", async () => {
		const client = new FakeClient();
		const ensureRef = new MutableEnsureAttachedRef();
		const controller = new LazyDebugSessionController(client, makeUploadClient(), ensureRef);
		await controller.openDebugSession("convo-1");
		expect(controller.getSnapshot().loading).toBe(false);
		expect(controller.getSnapshot().activeSession).toBeDefined();
		controller.clearBootstrapping();
		// Does not detach or wipe the attached session.
		expect(controller.getSnapshot().activeSession).toBeDefined();
		expect(controller.activeHandle?.id).toBe("convo-1");
	});
});

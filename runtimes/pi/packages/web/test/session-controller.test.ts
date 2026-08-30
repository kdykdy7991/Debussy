import type { PiSessionHandle } from "@earendil-works/pi-client";
import type {
	AssistantTranscriptItem,
	Attachment,
	Citation,
	ServerEvent,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, it, type Mock, vi } from "vitest";
import { type PiSessionClient, SessionController } from "../src/lib/session-controller.ts";
import type { PiUploadClient } from "../src/lib/uploader.ts";

const SESSION = {
	id: "session-1",
	name: "第一段对话",
	cwd: "/workspace",
	createdAt: 1,
	updatedAt: 2,
	phase: "idle",
	model: { provider: "oneapi", id: "qwen" },
	thinkingLevel: "medium",
	attached: true,
	locked: false,
	lastSequence: 0,
	revision: 1,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
} satisfies SessionSnapshot;

function attachment(id: string): Attachment {
	return {
		id,
		name: `${id}.txt`,
		mediaType: "text/plain",
		size: 3,
		sha256: "abc",
		status: "ready",
		scope: "session",
		createdAt: 1,
	};
}

function createHandle(snapshot: SessionSnapshot): PiSessionHandle {
	return {
		id: snapshot.id,
		active: true,
		attached: true,
		snapshot,
		subscribe: () => () => {},
		onEvent: () => () => {},
		detach: async () => {},
		dispose: vi.fn(async () => {}),
		prompt: async () => ({ command: "prompt", session: snapshot }),
		steer: async () => ({ command: "steer", session: snapshot }),
		abort: async () => snapshot,
		setModel: async () => snapshot,
		setThinking: async () => snapshot,
		attachUpload: async () => snapshot,
		removeAttachment: async () => snapshot,
		[Symbol.asyncDispose]: async () => {},
	};
}

function createUploadClient(): PiUploadClient {
	return {
		uploadFile: vi.fn(async (_file: File, onProgress?: (fraction: number) => void) => {
			onProgress?.(1);
			return attachment("upload-1");
		}),
	};
}

function createObservedHandle(snapshot: SessionSnapshot): {
	handle: PiSessionHandle;
	emit(next: SessionSnapshot): void;
	emitEvent(event: ServerEvent): void;
} {
	let listener: ((next: SessionSnapshot) => void) | undefined;
	let eventListener: ((event: ServerEvent) => void) | undefined;
	return {
		handle: {
			...createHandle(snapshot),
			subscribe: (nextListener) => {
				listener = nextListener;
				return () => {
					listener = undefined;
				};
			},
			onEvent: (nextListener) => {
				eventListener = nextListener;
				return () => {
					eventListener = undefined;
				};
			},
		},
		emit: (next) => listener?.(next),
		emitEvent: (event) => eventListener?.(event),
	};
}

interface FakeClient extends PiSessionClient {
	createSession: Mock<() => Promise<PiSessionHandle>>;
	attachSession: Mock<(id: string) => Promise<PiSessionHandle>>;
}

function createClient(): FakeClient {
	return {
		snapshot: undefined,
		subscribe: () => () => {},
		createSession: vi.fn<() => Promise<PiSessionHandle>>(),
		attachSession: vi.fn<(id: string) => Promise<PiSessionHandle>>(),
	};
}

describe("SessionController", () => {
	it("opens the most recently updated persisted session by default", async () => {
		const older = { ...SESSION, id: "session-older", updatedAt: 1 };
		const newer = { ...SESSION, id: "session-newer", updatedAt: 3 };
		const client = createClient();
		Object.defineProperty(client, "snapshot", { value: { sessions: [older, newer] }, configurable: true });
		client.attachSession.mockResolvedValue(createHandle(newer));
		const controller = new SessionController(client, createUploadClient());

		await controller.openDefaultSession();

		expect(client.attachSession).toHaveBeenCalledWith(newer.id);
		expect(client.createSession).not.toHaveBeenCalled();
		expect(controller.getSnapshot().activeSessionId).toBe(newer.id);
	});

	it("creates a session by default only when no persisted sessions exist", async () => {
		const client = createClient();
		client.createSession.mockResolvedValue(createHandle(SESSION));
		const controller = new SessionController(client, createUploadClient());

		await controller.openDefaultSession();

		expect(client.createSession).toHaveBeenCalledOnce();
		expect(client.attachSession).not.toHaveBeenCalled();
	});

	it("creates and selects a new session", async () => {
		const client = createClient();
		client.createSession.mockResolvedValue(createHandle(SESSION));
		const controller = new SessionController(client, createUploadClient());

		await controller.createSession();

		expect(controller.getSnapshot().activeSessionId).toBe(SESSION.id);
		expect(controller.getSnapshot().sessions).toHaveLength(1);
	});

	it("creates an ephemeral session for admin debugging", async () => {
		const client = createClient();
		client.createSession.mockResolvedValue(createHandle(SESSION));
		const controller = new SessionController(client, createUploadClient());

		await controller.createDebugSession({ provider: "oneapi", id: "qwen" });

		expect(client.createSession).toHaveBeenCalledWith({
			ephemeral: true,
			model: { provider: "oneapi", id: "qwen" },
		});
	});

	it("attaches a server-prepared revision-bound debug session", async () => {
		const client = createClient();
		client.attachSession.mockResolvedValue(createHandle(SESSION));
		const controller = new SessionController(client, createUploadClient());

		await controller.openDebugSession("opaque-debug-ticket");

		expect(client.attachSession).toHaveBeenCalledWith("opaque-debug-ticket");
		expect(client.createSession).not.toHaveBeenCalled();
	});

	it("releases the previous session when switching", async () => {
		const first = createHandle(SESSION);
		const secondSnapshot = { ...SESSION, id: "session-2", name: "第二段对话" };
		const client = createClient();
		client.attachSession.mockResolvedValueOnce(first).mockResolvedValueOnce(createHandle(secondSnapshot));
		const controller = new SessionController(client, createUploadClient());

		await controller.selectSession(first.id);
		await controller.selectSession(secondSnapshot.id);

		expect(first.dispose).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().activeSessionId).toBe(secondSnapshot.id);
	});

	it("reports attachment failures", async () => {
		const client = createClient();
		client.attachSession.mockRejectedValue(new Error("会话已锁定"));
		const controller = new SessionController(client, createUploadClient());

		await expect(controller.selectSession("locked")).rejects.toThrow("会话已锁定");

		expect(controller.getSnapshot().error).toBe("会话已锁定");
	});

	it("publishes streaming transcript snapshots", async () => {
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);
		const streaming = {
			...SESSION,
			revision: 2,
			phase: "turn",
			transcript: [
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "正在回答" }],
					model: SESSION.model,
					timestamp: 3,
					status: "streaming",
				},
			],
		} satisfies SessionSnapshot;

		observed.emit(streaming);

		expect(controller.getSnapshot().activeSession).toBe(streaming);
		expect(controller.getSnapshot().activeSession?.transcript).toHaveLength(1);
	});

	it("merges assistant progress until an authoritative snapshot arrives", async () => {
		vi.useFakeTimers();
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);
		const streamingItem = {
			id: "assistant-1",
			role: "assistant",
			content: [],
			model: SESSION.model,
			timestamp: 3,
			status: "streaming",
		} satisfies AssistantTranscriptItem;

		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-1",
			sequence: 1,
			progress: { type: "item_started", item: streamingItem },
		});
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-1",
			sequence: 2,
			progress: {
				type: "assistant_delta",
				messageId: streamingItem.id,
				contentIndex: 0,
				kind: "text",
				delta: "流式内容",
			},
		});
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-1",
			sequence: 3,
			progress: {
				type: "assistant_delta",
				messageId: streamingItem.id,
				contentIndex: 0,
				kind: "text",
				delta: "持续追加",
			},
		});
		expect(controller.getSnapshot().activeSession?.transcript[0]?.content).toEqual([]);
		vi.advanceTimersByTime(SessionController.STREAM_FLUSH_INTERVAL_MS);

		const transient = controller.getSnapshot().activeSession;
		expect(transient?.phase).toBe("turn");
		expect(transient?.transcript[0]?.content[0]).toEqual({ type: "text", text: "流式内容持续追加" });

		const authoritative = {
			...SESSION,
			revision: 2,
			transcript: [
				{ ...streamingItem, content: [{ type: "text", text: "最终内容" }], status: "complete", stopReason: "stop" },
			],
		} satisfies SessionSnapshot;
		observed.emit(authoritative);
		expect(controller.getSnapshot().activeSession).toBe(authoritative);
		vi.useRealTimers();
	});

	it("flushes a semantic streaming chunk at punctuation", async () => {
		vi.useFakeTimers();
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);
		const streamingItem = {
			id: "assistant-semantic",
			role: "assistant",
			content: [],
			model: SESSION.model,
			timestamp: 3,
			status: "streaming",
		} satisfies AssistantTranscriptItem;
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-semantic",
			sequence: 1,
			progress: { type: "item_started", item: streamingItem },
		});
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-semantic",
			sequence: 2,
			progress: {
				type: "assistant_delta",
				messageId: streamingItem.id,
				contentIndex: 0,
				kind: "text",
				delta: "这是一个语义片段。",
			},
		});
		vi.advanceTimersByTime(SessionController.STREAM_FLUSH_INTERVAL_MS);
		expect(controller.getSnapshot().activeSession?.transcript[0]?.content[0]).toEqual({
			type: "text",
			text: "这是一个语义片段。",
		});
		await controller.dispose();
		vi.useRealTimers();
	});

	it("does not miss a completed sentence when another token follows its punctuation", async () => {
		vi.useFakeTimers();
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);
		const streamingItem = {
			id: "assistant-boundary",
			role: "assistant",
			content: [],
			model: SESSION.model,
			timestamp: 3,
			status: "streaming",
		} satisfies AssistantTranscriptItem;
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-boundary",
			sequence: 1,
			progress: { type: "item_started", item: streamingItem },
		});
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-boundary",
			sequence: 2,
			progress: {
				type: "assistant_delta",
				messageId: streamingItem.id,
				contentIndex: 0,
				kind: "text",
				delta: "第一句。下一",
			},
		});

		vi.advanceTimersByTime(SessionController.STREAM_FLUSH_INTERVAL_MS);

		expect(controller.getSnapshot().activeSession?.transcript[0]?.content[0]).toEqual({
			type: "text",
			text: "第一句。下一",
		});
		await controller.dispose();
		vi.useRealTimers();
	});

	it("uses an English word boundary without waiting for the latency fallback", async () => {
		vi.useFakeTimers();
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);
		const streamingItem = {
			id: "assistant-word",
			role: "assistant",
			content: [],
			model: SESSION.model,
			timestamp: 3,
			status: "streaming",
		} satisfies AssistantTranscriptItem;
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-word",
			sequence: 1,
			progress: { type: "item_started", item: streamingItem },
		});
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
			turnId: "turn-word",
			sequence: 2,
			progress: {
				type: "assistant_delta",
				messageId: streamingItem.id,
				contentIndex: 0,
				kind: "text",
				delta: "semantic ",
			},
		});

		vi.advanceTimersByTime(SessionController.STREAM_FLUSH_INTERVAL_MS);

		expect(controller.getSnapshot().activeSession?.transcript[0]?.content[0]).toEqual({
			type: "text",
			text: "semantic ",
		});
		await controller.dispose();
		vi.useRealTimers();
	});

	it("shows a user message before the server responds", async () => {
		let resolvePrompt: ((result: { command: "prompt"; session: SessionSnapshot }) => void) | undefined;
		const prompt = vi.fn<(text: string) => Promise<{ command: "prompt"; session: SessionSnapshot }>>(
			() =>
				new Promise((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		const handle = { ...createHandle(SESSION), prompt };
		const client = createClient();
		client.attachSession.mockResolvedValue(handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);

		const sending = controller.send("立即显示");

		expect(controller.getSnapshot().activeSession?.transcript).toEqual([
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "立即显示" }] }),
		]);
		resolvePrompt?.({ command: "prompt", session: { ...SESSION, phase: "turn", revision: 2 } });
		await sending;
	});

	it("sends an idle session message as a prompt", async () => {
		const prompted = { ...SESSION, phase: "turn", revision: 2 } satisfies SessionSnapshot;
		const prompt = vi
			.fn<(text: string) => Promise<{ command: "prompt"; session: SessionSnapshot }>>()
			.mockResolvedValue({
				command: "prompt",
				session: prompted,
			});
		const handle = { ...createHandle(SESSION), prompt };
		const client = createClient();
		client.attachSession.mockResolvedValue(handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);

		await controller.send("  第一条消息  ");

		expect(prompt).toHaveBeenCalledWith("第一条消息");
		expect(controller.getSnapshot().activeSession).toBe(prompted);
	});

	it("steers and aborts a running session", async () => {
		const running = { ...SESSION, phase: "turn", revision: 2 } satisfies SessionSnapshot;
		const steered = { ...running, revision: 3 } satisfies SessionSnapshot;
		const aborted = { ...running, phase: "idle", revision: 4 } satisfies SessionSnapshot;
		const steer = vi
			.fn<(text: string) => Promise<{ command: "steer"; session: SessionSnapshot }>>()
			.mockResolvedValue({ command: "steer", session: steered });
		const abort = vi.fn<() => Promise<SessionSnapshot>>().mockResolvedValue(aborted);
		const handle = { ...createHandle(running), steer, abort };
		const client = createClient();
		client.attachSession.mockResolvedValue(handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(running.id);

		await controller.send("补充要求");
		await controller.abort();

		expect(steer).toHaveBeenCalledWith("补充要求");
		expect(abort).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().activeSession).toBe(aborted);
	});

	it("does not let a stale prompt from a superseded session clobber the new session's state", async () => {
		// Regression (admin debug → chat): the debug page re-binds a fresh
		// session while a prompt is still in flight. When the in-flight prompt
		// finally settles, it must not write `submitting` / `error` back into
		// the snapshot of the *new* session — that stuck `submitting: true`
		// used to silently disable the Send button.
		let rejectPrompt: ((error: Error) => void) | undefined;
		const prompt = vi
			.fn<(text: string) => Promise<{ command: "prompt"; session: SessionSnapshot }>>()
			.mockImplementation(
				() =>
					new Promise<never>((_resolve, reject) => {
						rejectPrompt = reject;
					}),
			);
		const first = { ...createHandle(SESSION), prompt };
		const secondSnapshot = {
			...SESSION,
			id: "session-2",
			name: "第二段对话",
			phase: "idle",
		} satisfies SessionSnapshot;
		const client = createClient();
		client.attachSession.mockResolvedValueOnce(first).mockResolvedValueOnce(createHandle(secondSnapshot));
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);

		const sending = controller.send("第一条消息");
		expect(controller.getSnapshot().submitting).toBe(true);

		// The admin debug page destroys the old session and attaches a new one.
		await controller.openDebugSession(secondSnapshot.id);
		expect(first.dispose).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().activeSessionId).toBe(secondSnapshot.id);
		expect(controller.getSnapshot().submitting).toBe(false);

		// The in-flight prompt from the disposed session finally rejects.
		rejectPrompt?.(new Error("Runtime is disposed"));
		await expect(sending).rejects.toThrow("Runtime is disposed");

		// The new session's snapshot must be untouched: no stuck `submitting`,
		// no stale error, still pointing at the new session.
		expect(controller.getSnapshot().submitting).toBe(false);
		expect(controller.getSnapshot().error).toBeUndefined();
		expect(controller.getSnapshot().activeSessionId).toBe(secondSnapshot.id);
	});

	it("unlocks submitting when activation fails", async () => {
		// Regression: a failed attach used to leave the snapshot with
		// `submitting: true` on top of the error, silently disabling Send.
		const client = createClient();
		client.attachSession.mockRejectedValue(new Error("会话已锁定"));
		const controller = new SessionController(client, createUploadClient());

		await expect(controller.selectSession("locked")).rejects.toThrow("会话已锁定");

		expect(controller.getSnapshot().submitting).toBe(false);
		expect(controller.getSnapshot().error).toBe("会话已锁定");
	});

	it("clears a surfaced session error without retrying anything", async () => {
		const client = createClient();
		client.attachSession.mockRejectedValue(new Error("会话已锁定"));
		const controller = new SessionController(client, createUploadClient());

		await expect(controller.selectSession("locked")).rejects.toThrow("会话已锁定");
		expect(controller.getSnapshot().error).toBe("会话已锁定");

		controller.clearError();

		expect(controller.getSnapshot().error).toBeUndefined();
		// Dismissing must not retry the attach.
		expect(client.attachSession).toHaveBeenCalledTimes(1);
	});
});

it("uploads files, attaches them, and removes attachments", async () => {
	const uploadClient = createUploadClient();
	const attachedSnapshot = { ...SESSION, attachments: [attachment("upload-1")] };
	const handle = {
		...createHandle(SESSION),
		attachUpload: vi.fn(async () => attachedSnapshot),
		removeAttachment: vi.fn(async () => SESSION),
	};
	const client = createClient();
	client.attachSession.mockResolvedValue(handle);
	const controller = new SessionController(client, uploadClient);
	await controller.selectSession(SESSION.id);

	await controller.uploadFiles([new File(["hi"], "notes.txt")]);

	expect(uploadClient.uploadFile).toHaveBeenCalledOnce();
	expect(handle.attachUpload).toHaveBeenCalledWith("upload-1", "session");
	expect(controller.getSnapshot().activeSession?.attachments?.map((a) => a.id)).toEqual(["upload-1"]);
	expect(controller.getSnapshot().uploads).toEqual([]);

	await controller.removeAttachment("upload-1");
	expect(handle.removeAttachment).toHaveBeenCalledWith("upload-1");
	expect(controller.getSnapshot().activeSession).toBe(SESSION);
});

it("reports failed uploads without attaching them", async () => {
	const uploadClient: PiUploadClient = {
		uploadFile: vi.fn(async () => {
			throw new Error("payload_too_large");
		}),
	};
	const handle = { ...createHandle(SESSION), attachUpload: vi.fn(async () => SESSION) };
	const client = createClient();
	client.attachSession.mockResolvedValue(handle);
	const controller = new SessionController(client, uploadClient);
	await controller.selectSession(SESSION.id);

	await controller.uploadFiles([new File(["x".repeat(64)], "big.txt")]);

	expect(handle.attachUpload).not.toHaveBeenCalled();
	expect(controller.getSnapshot().uploads).toEqual([
		expect.objectContaining({ name: "big.txt", status: "failed", error: "payload_too_large" }),
	]);
});

describe("SessionController citation merge (Phase 2D)", () => {
	function citation(turnId: string, sourceId: string, title: string): Citation {
		return {
			id: `cit-${sourceId}`,
			sessionId: SESSION.id,
			turnId,
			sourceId,
			chunkId: `chunk-${sourceId}`,
			ordinal: 0,
			title,
			excerpt: `excerpt from ${title}`,
		};
	}

	function assistantItem(id: string): AssistantTranscriptItem {
		return {
			id,
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			model: SESSION.model,
			timestamp: 3,
			status: "complete",
			stopReason: "stop",
		};
	}

	function snapshotWith(...items: AssistantTranscriptItem[]): SessionSnapshot {
		return { ...SESSION, revision: 2, transcript: items } satisfies SessionSnapshot;
	}

	async function activate(): Promise<{
		observed: ReturnType<typeof createObservedHandle>;
		controller: SessionController;
	}> {
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client, createUploadClient());
		await controller.selectSession(SESSION.id);
		return { observed, controller };
	}

	function citationEvent(
		observed: ReturnType<typeof createObservedHandle>,
		turnId: string,
		...cits: Citation[]
	): void {
		observed.emitEvent({ type: "citation_snapshot", sessionId: SESSION.id, turnId, citations: cits });
	}

	it("merges a turn's citations onto its assistant message when the event arrives after the final message", async () => {
		const { observed, controller } = await activate();
		observed.emit(snapshotWith(assistantItem("ast:turn-1")));
		citationEvent(observed, "turn-1", citation("turn-1", "src-a", "guide.txt"));
		const item = controller.getSnapshot().activeSession?.transcript[0];
		expect(item?.role).toBe("assistant");
		expect(item && "citations" in item ? item.citations : undefined).toEqual([
			citation("turn-1", "src-a", "guide.txt"),
		]);
	});

	it("merges citations onto the assistant message when the event arrives before the final message", async () => {
		const { observed, controller } = await activate();
		citationEvent(observed, "turn-1", citation("turn-1", "src-a", "guide.txt"));
		// No assistant message yet: citation stays pending, nothing attached.
		expect(controller.getSnapshot().activeSession?.transcript).toHaveLength(0);
		observed.emit(snapshotWith(assistantItem("ast:turn-1")));
		const item = controller.getSnapshot().activeSession?.transcript[0];
		expect(item && "citations" in item ? item.citations : undefined).toEqual([
			citation("turn-1", "src-a", "guide.txt"),
		]);
	});

	it("keeps each turn's citations bound to its own assistant message (no cross-turn)", async () => {
		const { observed, controller } = await activate();
		citationEvent(observed, "turn-1", citation("turn-1", "src-a", "guide.txt"));
		citationEvent(observed, "turn-2", citation("turn-2", "src-b", "keys.txt"));
		observed.emit(snapshotWith(assistantItem("ast:turn-1"), assistantItem("ast:turn-2")));
		const [t1, t2] = controller.getSnapshot().activeSession?.transcript ?? [];
		expect(t1 && "citations" in t1 ? t1.citations : undefined).toHaveLength(1);
		expect(t2 && "citations" in t2 ? t2.citations : undefined).toHaveLength(1);
		expect(t1 && "citations" in t1 ? (t1.citations as Citation[])[0]!.sourceId : undefined).toBe("src-a");
		expect(t2 && "citations" in t2 ? (t2.citations as Citation[])[0]!.sourceId : undefined).toBe("src-b");
	});

	it("does not inherit the previous turn's citations when a turn has none", async () => {
		const { observed, controller } = await activate();
		citationEvent(observed, "turn-1", citation("turn-1", "src-a", "guide.txt"));
		observed.emit(snapshotWith(assistantItem("ast:turn-1")));
		// Turn 2 has no citation_snapshot: its assistant message must stay citation-free.
		observed.emit({ ...snapshotWith(assistantItem("ast:turn-1"), assistantItem("ast:turn-2")), revision: 3 });
		const items = controller.getSnapshot().activeSession?.transcript ?? [];
		expect(items[0] && "citations" in items[0] ? items[0].citations : undefined).toHaveLength(1);
		expect(items[1] && "citations" in items[1] ? items[1].citations : undefined).toBeUndefined();
	});
});

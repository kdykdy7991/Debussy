import type { PiSessionHandle } from "@earendil-works/pi-client";
import type { AssistantTranscriptItem, ServerEvent, SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, it, type Mock, vi } from "vitest";
import { type PiSessionClient, SessionController } from "../src/lib/session-controller.ts";

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
	revision: 1,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
} satisfies SessionSnapshot;

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
		prompt: async () => snapshot,
		steer: async () => snapshot,
		abort: async () => snapshot,
		setModel: async () => snapshot,
		setThinking: async () => snapshot,
		[Symbol.asyncDispose]: async () => {},
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
	it("creates and selects a new session", async () => {
		const client = createClient();
		client.createSession.mockResolvedValue(createHandle(SESSION));
		const controller = new SessionController(client);

		await controller.createSession();

		expect(controller.getSnapshot().activeSessionId).toBe(SESSION.id);
		expect(controller.getSnapshot().sessions).toHaveLength(1);
	});

	it("releases the previous session when switching", async () => {
		const first = createHandle(SESSION);
		const secondSnapshot = { ...SESSION, id: "session-2", name: "第二段对话" };
		const client = createClient();
		client.attachSession.mockResolvedValueOnce(first).mockResolvedValueOnce(createHandle(secondSnapshot));
		const controller = new SessionController(client);

		await controller.selectSession(first.id);
		await controller.selectSession(secondSnapshot.id);

		expect(first.dispose).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().activeSessionId).toBe(secondSnapshot.id);
	});

	it("reports attachment failures", async () => {
		const client = createClient();
		client.attachSession.mockRejectedValue(new Error("会话已锁定"));
		const controller = new SessionController(client);

		await expect(controller.selectSession("locked")).rejects.toThrow("会话已锁定");

		expect(controller.getSnapshot().error).toBe("会话已锁定");
	});

	it("publishes streaming transcript snapshots", async () => {
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client);
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
		const observed = createObservedHandle(SESSION);
		const client = createClient();
		client.attachSession.mockResolvedValue(observed.handle);
		const controller = new SessionController(client);
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
			progress: { type: "item_started", item: streamingItem },
		});
		observed.emitEvent({
			type: "session_progress",
			sessionId: SESSION.id,
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
			progress: {
				type: "assistant_delta",
				messageId: streamingItem.id,
				contentIndex: 0,
				kind: "text",
				delta: "持续追加",
			},
		});

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
	});

	it("sends an idle session message as a prompt", async () => {
		const prompted = { ...SESSION, phase: "turn", revision: 2 } satisfies SessionSnapshot;
		const prompt = vi.fn<(text: string) => Promise<SessionSnapshot>>().mockResolvedValue(prompted);
		const handle = { ...createHandle(SESSION), prompt };
		const client = createClient();
		client.attachSession.mockResolvedValue(handle);
		const controller = new SessionController(client);
		await controller.selectSession(SESSION.id);

		await controller.send("  第一条消息  ");

		expect(prompt).toHaveBeenCalledWith("第一条消息");
		expect(controller.getSnapshot().activeSession).toBe(prompted);
	});

	it("steers and aborts a running session", async () => {
		const running = { ...SESSION, phase: "turn", revision: 2 } satisfies SessionSnapshot;
		const steered = { ...running, revision: 3 } satisfies SessionSnapshot;
		const aborted = { ...running, phase: "idle", revision: 4 } satisfies SessionSnapshot;
		const steer = vi.fn<(text: string) => Promise<SessionSnapshot>>().mockResolvedValue(steered);
		const abort = vi.fn<() => Promise<SessionSnapshot>>().mockResolvedValue(aborted);
		const handle = { ...createHandle(running), steer, abort };
		const client = createClient();
		client.attachSession.mockResolvedValue(handle);
		const controller = new SessionController(client);
		await controller.selectSession(running.id);

		await controller.send("补充要求");
		await controller.abort();

		expect(steer).toHaveBeenCalledWith("补充要求");
		expect(abort).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().activeSession).toBe(aborted);
	});
});

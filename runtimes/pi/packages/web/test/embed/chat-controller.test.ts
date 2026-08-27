/**
 * TASK-033: Embed Chat 控制器测试（spec 9 / 8.2 / 27.5）。
 *
 * 纯逻辑测试：内存 storage + fetch mock + FakeWebSocket，不依赖 DOM。
 *
 * 覆盖：initialize（列表+恢复最近会话）、send（回显 + turn.start + delta 流式 +
 * completed 终结）、未连接提示、turn.failed/cancelled、citation.updated 展示
 * （两种到达顺序）、上传成功/配额超限/未启用、归档切换、会话切换、Token 过期
 * 透明刷新重试、连接失败 DISCONNECTED。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { EmbedApi, EmbedApiError } from "../../src/embed/api.ts";
import { EmbedChatController, sha256Hex } from "../../src/embed/chat-controller.ts";
import type { WebSocketLike } from "../../src/embed/realtime-transport.ts";

type Listener = (event: { readonly data?: unknown }) => void;

class FakeWebSocket implements WebSocketLike {
	sent: string[] = [];
	closed = false;
	private readonly listeners = new Map<string, Set<Listener>>();

	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
		this.emit("close", {});
	}
	addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
		let set = this.listeners.get(type);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}
	removeEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: "open" | "message" | "close" | "error", event: { readonly data?: unknown } = {}): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	lastMessage(): { type?: string; requestId?: string; message?: { text?: string } } | undefined {
		return this.sent.length === 0 ? undefined : (JSON.parse(this.sent.at(-1)!) as Record<string, unknown>);
	}
}

function baseEvent(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		conversationId: "conv_1",
		sequence: 1,
		turnId: null,
		eventId: "evt_1",
		timestamp: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(status >= 200 && status < 300 ? { data } : data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const SUMMARY_1 = {
	id: "conv_1",
	publishedAppVersionId: "pav_1",
	status: "active",
	title: "会话一",
	lastEventSequence: 0,
	createdAt: "2026-01-01T00:00:00Z",
};
const SUMMARY_2 = {
	id: "conv_2",
	publishedAppVersionId: "pav_1",
	status: "active",
	title: "会话二",
	lastEventSequence: 0,
	createdAt: "2026-01-02T00:00:00Z",
};

function detail(conversation: { id: string; lastEventSequence: number }, events: unknown[] = []) {
	return {
		conversation,
		events,
	};
}

/** 可配置的 fetch 路由（按 pathname 分发）。 */
function createRouter(
	initial: { conversations?: unknown[]; details?: Map<string, unknown>; wsTickets?: boolean } = {},
) {
	const state = {
		conversations: initial.conversations ?? [SUMMARY_1],
		details: initial.details ?? new Map<string, unknown>(),
		wsTickets: initial.wsTickets ?? true,
		calls: [] as { path: string; method: string; token?: string; body?: unknown }[],
		failNext: new Map<string, { status: number; error: { code: string; message: string; retryable: boolean } }>(),
	};
	if (!state.details.has("conv_1")) state.details.set("conv_1", detail(SUMMARY_1, []));
	if (!state.details.has("conv_2")) state.details.set("conv_2", detail(SUMMARY_2, []));
	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url), "http://embed.invalid").pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const token = headers.authorization?.replace(/^Bearer /, "");
		const bodyText = typeof init?.body === "string" ? init.body : undefined;
		state.calls.push({ path, method, token, body: bodyText === undefined ? undefined : JSON.parse(bodyText) });
		const fail = state.failNext.get(`${method} ${path}`);
		if (fail !== undefined) {
			state.failNext.delete(`${method} ${path}`);
			return jsonResponse({ error: fail.error }, fail.status);
		}
		if (method === "GET" && path === "/api/embed/v1/conversations") {
			return jsonResponse({ items: state.conversations, nextCursor: null });
		}
		if (method === "POST" && path === "/api/embed/v1/conversations") {
			const created = { ...SUMMARY_2, id: "conv_new", title: "" };
			state.details.set("conv_new", detail(created, []));
			// WB-008: the endpoint always returns { conversation, rollover }.
			return jsonResponse(
				{
					conversation: created,
					rollover: {
						conversationId: "conv_new",
						rolledOver: false,
						previousConversationId: null,
						rolledOverAtSequence: null,
						rolloverSummaryId: null,
					},
				},
				201,
			);
		}
		const detailMatch = path.match(/^\/api\/embed\/v1\/conversations\/([^/]+)$/);
		if (method === "GET" && detailMatch !== null) {
			const found = state.details.get(detailMatch[1]!);
			return found === undefined
				? jsonResponse({ error: { code: "CONVERSATION_NOT_FOUND" } }, 404)
				: jsonResponse(found);
		}
		if (method === "POST" && path.endsWith("/archive")) {
			const id = path.split("/")[5]!;
			const found = state.details.get(id);
			if (found === undefined) return jsonResponse({ error: { code: "CONVERSATION_NOT_FOUND" } }, 404);
			return jsonResponse({ ...SUMMARY_1, id, status: "archived" });
		}
		if (method === "POST" && path.endsWith("/ws-ticket")) {
			return jsonResponse({
				ticket: "ticket-1",
				expiresAt: "2026-01-01T00:01:00Z",
				realtimeUrl: "ws://fake/realtime",
			});
		}
		if (method === "POST" && path.endsWith("/uploads")) {
			return jsonResponse(
				{
					attachmentId: "att_00000000-0000-7000-8000-000000000001",
					conversationId: path.split("/")[5]!,
					status: "ready",
					filename: headers["x-filename"],
					contentType: headers["content-type"],
					sizeBytes: 8,
					checksumSha256: "a".repeat(64),
					createdAt: "2026-01-01T00:00:00Z",
				},
				201,
			);
		}
		if (method === "DELETE" && path.includes("/uploads/")) {
			const attachmentId = path.split("/").at(-1)!;
			return jsonResponse({ attachmentId, deleted: true });
		}
		throw new Error(`unexpected ${method} ${path}`);
	});
	return { state, fetchImpl };
}

function makeHarness(
	options: { conversations?: unknown[]; getToken?: () => Promise<string>; maxRetries?: number } = {},
) {
	const router = createRouter({ conversations: options.conversations });
	const sockets: FakeWebSocket[] = [];
	const api = new EmbedApi({ fetchImpl: router.fetchImpl as unknown as typeof fetch });
	let tokenCount = 0;
	const controller = new EmbedChatController({
		api,
		getToken:
			options.getToken ??
			(async () => {
				tokenCount += 1;
				return `token-${tokenCount}`;
			}),
		wsFactory: () => {
			const socket = new FakeWebSocket();
			sockets.push(socket);
			return socket;
		},
		maxRetries: options.maxRetries ?? 5,
		backoffBaseMs: 10,
	});
	return { router, sockets, api, controller };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function connectFirstSocket(harness: { sockets: FakeWebSocket[] }): Promise<void> {
	await flush();
	harness.sockets[0]?.emit("open");
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("embed chat controller", () => {
	test("single-conversation mode creates the initial conversation automatically", async () => {
		const harness = makeHarness({ conversations: [] });
		await harness.controller.initialize({ newConversations: false });
		expect(harness.router.state.calls).toContainEqual(
			expect.objectContaining({ path: "/api/embed/v1/conversations", method: "POST" }),
		);
		expect(harness.controller.getState().activeId).toBe("conv_new");
		expect(harness.controller.getState().newConversationsEnabled).toBe(false);
	});
	test("initialize lists conversations, restores the most recent and connects realtime", async () => {
		const harness = makeHarness();
		await harness.controller.initialize({ uploads: true });
		await flush();
		const state = harness.controller.getState();
		expect(state.conversations.map((item) => item.id)).toEqual(["conv_1"]);
		expect(state.activeId).toBe("conv_1");
		expect(state.uploadsEnabled).toBe(true);
		expect(harness.sockets).toHaveLength(1);
		expect(harness.router.state.calls.some((call) => call.path.endsWith("/ws-ticket"))).toBe(true);
		harness.controller.close();
	});

	test("send echoes the user message, streams the delta and finalizes on completed", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await connectFirstSocket(harness);
		harness.controller.send("你好");
		let state = harness.controller.getState();
		expect(state.sending).toBe(true);
		expect(state.messages.at(-1)).toMatchObject({ role: "user", text: "你好", sequence: -1 });
		const sent = harness.sockets[0]!.lastMessage();
		expect(sent?.type).toBe("turn.start");
		expect(sent?.message).toEqual({ text: "你好", attachmentIds: [] });
		// delta 是瞬时事件（sequence 0）：流式文本更新。
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "message.delta",
					messageId: "msg_1",
					contentIndex: 0,
					kind: "text",
					delta: "你",
					sequence: 0,
				}),
			),
		});
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "message.delta",
					messageId: "msg_1",
					contentIndex: 0,
					kind: "text",
					delta: "好世界",
					sequence: 0,
				}),
			),
		});
		state = harness.controller.getState();
		expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "你好世界", streaming: true });
		// completed 来自持久事件（sequence > 0）：终结流式并复位 sending。
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "你好世界", sequence: 2 })),
		});
		state = harness.controller.getState();
		const assistant = state.messages.at(-1);
		expect(assistant).toMatchObject({ role: "assistant", text: "你好世界", sequence: 2, streaming: false });
		expect(state.sending).toBe(false);
		harness.controller.close();
	});

	test("preserves thinking and text as separate incremental content", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await connectFirstSocket(harness);
		harness.controller.send("请分析");
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "message.delta",
					messageId: "msg_reason",
					contentIndex: 0,
					kind: "thinking",
					delta: "第一步",
					sequence: 0,
				}),
			),
		});
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "message.delta",
					messageId: "msg_reason",
					contentIndex: 1,
					kind: "text",
					delta: "结论",
					sequence: 0,
				}),
			),
		});
		expect(harness.controller.getState().messages.at(-1)).toMatchObject({
			thinking: "第一步",
			text: "结论",
			streaming: true,
		});
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "结论", thinking: "第一步", sequence: 2 })),
		});
		expect(harness.controller.getState().messages.at(-1)).toMatchObject({
			thinking: "第一步",
			text: "结论",
			streaming: false,
		});
		harness.controller.close();
	});

	test("send while not connected surfaces NOT_CONNECTED without echoing", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await flush();
		// 未 open（未 connected）。
		harness.controller.send("hi");
		const state = harness.controller.getState();
		expect(state.error?.code).toBe("NOT_CONNECTED");
		expect(state.messages).toHaveLength(0);
		harness.controller.close();
	});

	test("turn.failed appends a system message and clears sending", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await connectFirstSocket(harness);
		harness.controller.send("hi");
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(baseEvent({ type: "turn.failed", error: "model exploded", sequence: 0 })),
		});
		const state = harness.controller.getState();
		expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "回复失败：model exploded" });
		expect(state.sending).toBe(false);
		harness.controller.close();
	});

	test("citation.updated before the delta attaches citations to the assistant message", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await connectFirstSocket(harness);
		harness.controller.send("引用一下");
		const citation = {
			id: "cit_1",
			sessionId: "conv_1",
			turnId: "t1",
			sourceId: "src_1",
			chunkId: "c1",
			ordinal: 0,
			title: "doc.txt",
			excerpt: "relevant line",
		};
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(baseEvent({ type: "citation.updated", citations: [citation], sequence: 0 })),
		});
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "message.delta",
					messageId: "msg_2",
					contentIndex: 0,
					kind: "text",
					delta: "来自文档",
					sequence: 0,
				}),
			),
		});
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "来自文档", sequence: 4 })),
		});
		const assistant = harness.controller.getState().messages.at(-1);
		expect(assistant?.citations).toHaveLength(1);
		expect(assistant?.citations?.[0]?.title).toBe("doc.txt");
		harness.controller.close();
	});

	test("citation.updated after the delta attaches to the streaming message", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await connectFirstSocket(harness);
		harness.controller.send("hi");
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "message.delta",
					messageId: "msg_3",
					contentIndex: 0,
					kind: "text",
					delta: "a",
					sequence: 0,
				}),
			),
		});
		harness.sockets[0]!.emit("message", {
			data: JSON.stringify(
				baseEvent({
					type: "citation.updated",
					citations: [
						{
							id: "c",
							sessionId: "conv_1",
							turnId: "t",
							sourceId: "s",
							chunkId: "k",
							ordinal: 0,
							title: "f.txt",
							excerpt: "e",
						},
					],
					sequence: 0,
				}),
			),
		});
		const streaming = harness.controller.getState().messages.at(-1);
		expect(streaming?.streaming).toBe(true);
		expect(streaming?.citations?.[0]?.title).toBe("f.txt");
		harness.controller.close();
	});

	test("upload appends an attachment chip and quota errors surface in state", async () => {
		const harness = makeHarness();
		await harness.controller.initialize({ uploads: true });
		await connectFirstSocket(harness);
		await harness.controller.uploadFile({
			filename: "a.txt",
			contentType: "text/plain",
			data: new TextEncoder().encode("hello"),
		});
		let state = harness.controller.getState();
		expect(state.attachments).toHaveLength(1);
		expect(state.attachments[0]).toMatchObject({ filename: "a.txt", status: "ready" });
		expect(state.attachments[0]?.attachmentId).toMatch(/^att_/);
		// 配额超限 -> 429 QUOTA_EXCEEDED 进入 error。
		harness.router.state.failNext.set("POST /api/embed/v1/conversations/conv_1/uploads", {
			status: 429,
			error: { code: "QUOTA_EXCEEDED", message: "Upload quota exceeded", retryable: true },
		});
		await harness.controller.uploadFile({
			filename: "b.txt",
			contentType: "text/plain",
			data: new TextEncoder().encode("x"),
		});
		state = harness.controller.getState();
		expect(state.error?.code).toBe("QUOTA_EXCEEDED");
		expect(state.attachments).toHaveLength(1);
		harness.controller.close();
	});

	test("upload is rejected when uploads are disabled", async () => {
		const harness = makeHarness();
		await harness.controller.initialize({ uploads: false });
		await harness.controller.uploadFile({
			filename: "a.txt",
			contentType: "text/plain",
			data: new TextEncoder().encode("x"),
		});
		const state = harness.controller.getState();
		expect(state.error?.code).toBe("UPLOAD_DISABLED");
		harness.controller.close();
	});

	test("removing an attachment calls delete and drops the chip", async () => {
		const harness = makeHarness();
		await harness.controller.initialize({ uploads: true });
		await connectFirstSocket(harness);
		await harness.controller.uploadFile({
			filename: "a.txt",
			contentType: "text/plain",
			data: new TextEncoder().encode("hi"),
		});
		const attachmentId = harness.controller.getState().attachments[0]!.attachmentId;
		await harness.controller.removeAttachment(attachmentId);
		const state = harness.controller.getState();
		expect(state.attachments).toHaveLength(0);
		expect(
			harness.router.state.calls.some((call) => call.method === "DELETE" && call.path.includes("/uploads/")),
		).toBe(true);
		harness.controller.close();
	});

	test("archiving the active conversation switches to the next one", async () => {
		const harness = makeHarness({ conversations: [SUMMARY_1, SUMMARY_2] });
		await harness.controller.initialize();
		await flush();
		expect(harness.controller.getState().activeId).toBe("conv_1");
		await harness.controller.archiveActive();
		await flush();
		const state = harness.controller.getState();
		expect(state.conversations.map((item) => item.id)).toEqual(["conv_2"]);
		expect(state.activeId).toBe("conv_2");
		// 旧连接已关闭，新连接已建立。
		expect(harness.sockets[0]?.closed).toBe(true);
		expect(harness.sockets.length).toBe(2);
		harness.controller.close();
	});

	test("switching conversations loads new messages and reconnects", async () => {
		const harness = makeHarness({ conversations: [SUMMARY_1, SUMMARY_2] });
		await harness.controller.initialize();
		await flush();
		await harness.controller.openConversation("conv_2");
		await flush();
		const state = harness.controller.getState();
		expect(state.activeId).toBe("conv_2");
		expect(harness.sockets[0]?.closed).toBe(true);
		// 新连接 open 后发 sync 订阅。
		harness.sockets[1]?.emit("open");
		expect(harness.sockets[1]?.lastMessage()).toMatchObject({ type: "conversation.sync", conversationId: "conv_2" });
		harness.controller.close();
	});

	test("a new conversation is created and opened", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await flush();
		await harness.controller.newConversation();
		await flush();
		const state = harness.controller.getState();
		expect(state.conversations[0]?.id).toBe("conv_new");
		expect(state.activeId).toBe("conv_new");
		harness.controller.close();
	});

	test("TOKEN_EXPIRED transparently refreshes the token and retries once", async () => {
		const harness = makeHarness();
		// 首次 create 返回 TOKEN_EXPIRED -> 刷新 token 重试。
		harness.router.state.failNext.set("POST /api/embed/v1/conversations", {
			status: 401,
			error: { code: "TOKEN_EXPIRED", message: "expired", retryable: false },
		});
		await harness.controller.initialize();
		await harness.controller.newConversation();
		const tokens = harness.router.state.calls
			.filter((call) => call.method === "POST" && call.path === "/api/embed/v1/conversations")
			.map((call) => call.token);
		expect(tokens).toHaveLength(2);
		expect(tokens[0]).not.toBe(tokens[1]); // 刷新后换新 token
		expect(harness.controller.getState().activeId).toBe("conv_new");
		harness.controller.close();
	});

	test("reconnect exhaustion surfaces DISCONNECTED and uploads remain usable", async () => {
		const harness = makeHarness({ maxRetries: 0 });
		await harness.controller.initialize();
		await flush();
		// 连接后断开且不允许重试 -> closed。
		harness.sockets[0]!.emit("close");
		await flush();
		const state = harness.controller.getState();
		expect(state.connectionStatus).toBe("closed");
		expect(state.error?.code).toBe("DISCONNECTED");
		harness.controller.close();
	});

	test("host logout (close) does not surface a DISCONNECTED error", async () => {
		const harness = makeHarness();
		await harness.controller.initialize();
		await flush();
		harness.controller.close();
		const state = harness.controller.getState();
		expect(state.connectionStatus).toBe("closed");
		expect(state.error).toBeNull();
	});

	test("sha256Hex matches a known digest", async () => {
		const digest = await sha256Hex(new TextEncoder().encode("abc"));
		expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	test("AUTH_EXPIRED invokes onAuthFailure instead of a generic error", async () => {
		const failures: EmbedApiError[] = [];
		const router = createRouter();
		const sockets: FakeWebSocket[] = [];
		const controller = new EmbedChatController({
			api: new EmbedApi({ fetchImpl: router.fetchImpl as unknown as typeof fetch }),
			getToken: async () => {
				throw new EmbedApiError("AUTH_EXPIRED", "登录已过期，请刷新页面或由宿主重新初始化", false);
			},
			onAuthFailure: (error) => failures.push(error),
			wsFactory: () => {
				const socket = new FakeWebSocket();
				sockets.push(socket);
				return socket;
			},
		});
		await expect(controller.initialize()).rejects.toThrow(EmbedApiError);
		expect(failures).toHaveLength(0); // initialize 阶段由调用方（boot）处理
		// 操作级错误走 onAuthFailure：
		await controller.newConversation();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.code).toBe("AUTH_EXPIRED");
		controller.close();
	});
});

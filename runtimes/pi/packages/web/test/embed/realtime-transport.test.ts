/**
 * TASK-026: Embed Realtime 传输层测试（spec 9.2 / TASK-026 完成条件）。
 *
 * 覆盖：Ticket 申请 + 连接 + sync 订阅、turn.start 发送、按 sequence 去重
 * （重复/乱序丢弃）、断线指数退避重连、重连保留 lastSeenSequence 且不重发
 * 用户消息、切换 Conversation 取消旧订阅、close 停止重连。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { EmbedRealtimeTransport, type RealtimeTicket, type WebSocketLike } from "../../src/embed/realtime-transport.ts";

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
	lastMessage(): any {
		return this.sent.length === 0 ? undefined : (JSON.parse(this.sent.at(-1)!) as any);
	}
}

function baseEvent(overrides: Record<string, unknown>): any {
	return {
		conversationId: "conv_1",
		sequence: 1,
		turnId: null,
		eventId: "evt_1",
		timestamp: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeHarness(options: { maxRetries?: number; backoffBaseMs?: number } = {}) {
	const tickets: { conversationId: string }[] = [];
	const sockets: FakeWebSocket[] = [];
	const socketUrls: string[] = [];
	const events: any[] = [];
	const statuses: { status: string; attempt: number }[] = [];
	const transport = new EmbedRealtimeTransport({
		getTicket: async (conversationId) => {
			tickets.push({ conversationId });
			return {
				ticket: `ticket-${tickets.length}`,
				realtimeUrl: `ws://fake/${conversationId}`,
			} satisfies RealtimeTicket;
		},
		onEvent: (event) => events.push(event),
		onStatus: (status, attempt) => statuses.push({ status, attempt }),
		wsFactory: (url) => {
			socketUrls.push(url);
			const socket = new FakeWebSocket();
			sockets.push(socket);
			return socket;
		},
		...options,
	});
	return { transport, tickets, sockets, socketUrls, events, statuses };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("embed realtime transport", () => {
	test("connects, requests a ticket and syncs with lastSeenSequence", async () => {
		const harness = makeHarness();
		harness.transport.connect("conv_1", 5);
		await Promise.resolve();
		expect(harness.tickets).toEqual([{ conversationId: "conv_1" }]);
		expect(harness.socketUrls).toEqual(["ws://fake/conv_1?ticket=ticket-1"]);
		const ws = harness.sockets[0]!;
		ws.emit("open");
		expect(ws.lastMessage()).toMatchObject({
			type: "conversation.sync",
			conversationId: "conv_1",
			lastSeenSequence: 5,
		});
		expect(harness.statuses[0]).toEqual({ status: "connecting", attempt: 0 });
		expect(harness.statuses.at(-1)).toEqual({ status: "connected", attempt: 0 });
		harness.transport.close();
	});

	test("sends user messages once and never resends them on reconnect", async () => {
		vi.useFakeTimers();
		const harness = makeHarness({ backoffBaseMs: 10 });
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		const ws1 = harness.sockets[0]!;
		ws1.emit("open");
		harness.transport.sendTurn("req-1", "conv_1", "hello");
		expect(ws1.lastMessage()).toMatchObject({ type: "turn.start", requestId: "req-1", message: { text: "hello" } });
		// 断线 -> 退避重连（新 socket + 新 ticket）。
		ws1.emit("close");
		await vi.advanceTimersByTimeAsync(20);
		expect(harness.sockets.length).toBe(2);
		expect(harness.tickets.length).toBe(2);
		expect(harness.socketUrls[1]).toBe("ws://fake/conv_1?ticket=ticket-2");
		harness.sockets[1]!.emit("open");
		// 重连只发 sync（补齐），绝不自动重发 turn.start。
		const resentTurns = harness.sockets[1]!.sent.filter((raw) => raw.includes('"turn.start"'));
		expect(resentTurns).toHaveLength(0);
		expect(harness.sockets[1]!.lastMessage()).toMatchObject({ type: "conversation.sync" });
		harness.transport.close();
	});

	test("sends an explicit cancellation command only for the active conversation", async () => {
		const harness = makeHarness();
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		const ws = harness.sockets[0]!;
		ws.emit("open");
		expect(harness.transport.cancelTurn("conv_other")).toBe(false);
		expect(harness.transport.cancelTurn("conv_1")).toBe(true);
		expect(ws.lastMessage()).toEqual({ type: "turn.cancel", conversationId: "conv_1" });
		harness.transport.close();
	});

	test("reconnects with exponential backoff and stops after max retries", async () => {
		vi.useFakeTimers();
		const harness = makeHarness({ maxRetries: 2, backoffBaseMs: 10 });
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		harness.sockets[0]!.emit("close");
		await vi.advanceTimersByTimeAsync(100); // 重试 1（10ms）
		expect(harness.sockets.length).toBe(2);
		harness.sockets[1]!.emit("close");
		await vi.advanceTimersByTimeAsync(100); // 重试 2（20ms）
		expect(harness.sockets.length).toBe(3);
		harness.sockets[2]!.emit("close");
		await vi.advanceTimersByTimeAsync(100); // 已达上限，不再重试
		expect(harness.sockets.length).toBe(3);
		expect(harness.statuses.at(-1)).toEqual({ status: "closed", attempt: 2 });
	});

	test("deduplicates and drops out-of-order events by sequence", async () => {
		const harness = makeHarness();
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		const ws = harness.sockets[0]!;
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "first", sequence: 2 })),
		});
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "duplicate", sequence: 2 })),
		});
		ws.emit("message", { data: JSON.stringify(baseEvent({ type: "message.delta", text: "stale", sequence: 1 })) });
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "second", sequence: 3 })),
		});
		expect(harness.events.map((event) => event.text)).toEqual(["first", "second"]);
		harness.transport.close();
	});

	test("TASK-033: transient sequence-0 events pass through and do not block the completed event", async () => {
		const harness = makeHarness();
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		const ws = harness.sockets[0]!;
		// turn.accepted / message.delta 是瞬时事件（sequence 0），全部放行。
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "turn.accepted", sequence: 0 })),
		});
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.delta", text: "hello", sequence: 0 })),
		});
		// completed 与 delta 同 turn（不同 sequence）：不得被 delta 屏蔽。
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "hello", sequence: 2 })),
		});
		expect(harness.events.map((event) => event.type)).toEqual([
			"turn.accepted",
			"message.delta",
			"message.completed",
		]);
		// completed(2) 推进恢复游标：重复的 completed(2) 被丢弃。
		ws.emit("message", {
			data: JSON.stringify(baseEvent({ type: "message.completed", text: "dup", sequence: 2 })),
		});
		expect(harness.events).toHaveLength(3);
		harness.transport.close();
	});

	test("ignores events for other conversations and invalid frames", async () => {
		const harness = makeHarness();
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		const ws = harness.sockets[0]!;
		ws.emit("message", {
			data: JSON.stringify(
				baseEvent({ type: "message.completed", text: "other", sequence: 2, conversationId: "conv_2" }),
			),
		});
		ws.emit("message", { data: "not-json" });
		ws.emit("message", { data: JSON.stringify(baseEvent({ type: "message.teleported", sequence: 2 })) });
		expect(harness.events).toHaveLength(0);
		harness.transport.close();
	});

	test("switching conversations closes the old subscription and connects to the new one", async () => {
		vi.useFakeTimers();
		const harness = makeHarness({ backoffBaseMs: 10 });
		harness.transport.connect("conv_1", 0);
		await Promise.resolve();
		const ws1 = harness.sockets[0]!;
		ws1.emit("open");
		harness.transport.connect("conv_2", 0);
		await Promise.resolve();
		expect(ws1.closed).toBe(true); // 旧连接已关闭（取消旧订阅）
		expect(harness.sockets.length).toBe(2);
		const ws2 = harness.sockets[1]!;
		ws2.emit("open");
		expect(ws2.lastMessage()).toMatchObject({ type: "conversation.sync", conversationId: "conv_2" });
		harness.transport.close();
	});
});

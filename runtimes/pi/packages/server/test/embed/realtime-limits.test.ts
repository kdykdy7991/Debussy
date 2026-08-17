/**
 * TASK-034：Realtime Connection 并发槽 + turn 限流集成测试（无 DB）。
 *
 * 直接用 `EmbedRealtimeConnection` + 假 WS + 可控制 `executeTurn`，验证：
 * - 正常 turn 归还并发槽（active 归零）；
 * - 异常（executeTurn 失败）也归还槽（EffectOwner finally）；
 * - 并发槽打满时第二个 turn.start 立即失败（不排队）；
 * - turn 维度分层限流：会话层最严格（principal 仍有余量时按会话拒）。
 */
import { describe, expect, test } from "vitest";
import type { WebSocket as Ws } from "ws";
import type { EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { createEmbedLimits, type EmbedLimits } from "../../src/embed/rate-limits/index.ts";
import {
	EmbedRealtimeConnection,
	type EmbedRealtimeConnectionOptions,
	type RealtimeServices,
	type TurnOutcome,
} from "../../src/embed/realtime/connection.ts";
import {
	type ConversationId,
	newConversationId,
	newPrincipalId,
	newPublishedAppId,
	newTenantId,
	toPublicId,
} from "../../src/publishing/domain/ids.ts";

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
	readonly readyState = 1 as Ws["readyState"];
	sent: { type?: string; error?: string }[] = [];
	private readonly listeners = new Map<string, Set<Listener>>();
	on(event: string, listener: Listener): void {
		let set = this.listeners.get(event);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
	}
	send(data: unknown): void {
		this.sent.push(JSON.parse(String(data)) as { type?: string; error?: string });
	}
	close(): void {}
	terminate(): void {}
	emit(event: string, payload?: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

function deferredTurn(): {
	promise: Promise<TurnOutcome>;
	resolve: (outcome: Extract<TurnOutcome, { ok: true }>) => void;
} {
	let resolve: (outcome: Extract<TurnOutcome, { ok: true }>) => void = () => {};
	const promise = new Promise<TurnOutcome>((res) => {
		resolve = res as (outcome: Extract<TurnOutcome, { ok: true }>) => void;
	});
	return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const convId: ConversationId = newConversationId();
const publicConvId = toPublicId("ConversationId", convId);
const tenantId = newTenantId();
const appId = newPublishedAppId();
const prnId = newPrincipalId();
const principal: EmbedAuthContext = {
	tokenId: "tok-1",
	tenantId,
	publishedAppId: appId,
	principalId: prnId,
	principalType: "anonymous_visitor",
	scopes: [],
	issuedAt: new Date(),
	expiresAt: new Date(),
};

function okTurn(text: string): Extract<TurnOutcome, { ok: true }> {
	return {
		ok: true,
		turnId: "turn_x" as never,
		userMessageSequence: 1,
		assistantSequence: 2,
		outputText: text,
		citations: [],
	};
}

const noopServices: RealtimeServices = {
	getConversation: async () => undefined,
	listEvents: async () => [],
	executeTurn: async () => okTurn("ok"),
};

function makeConnection(options: { services?: RealtimeServices; limits: EmbedLimits }): {
	ws: FakeWebSocket;
	limits: EmbedLimits;
} {
	const ws = new FakeWebSocket();
	new EmbedRealtimeConnection({
		ws: ws as unknown as EmbedRealtimeConnectionOptions["ws"],
		requestOrigin: undefined,
		claims: {
			conversationId: convId,
			tenantId,
			publishedAppId: appId,
			principalId: prnId,
			principalType: "anonymous_visitor",
			tokenId: "tok-1",
			origin: null,
		},
		services: options.services ?? noopServices,
		principal,
		limits: options.limits,
	});
	return { ws, limits: options.limits };
}

function sendTurn(ws: FakeWebSocket): void {
	ws.emit(
		"message",
		JSON.stringify({
			type: "turn.start",
			conversationId: publicConvId,
			requestId: "r1",
			lastSeenSequence: 0,
			message: { text: "hi", attachmentIds: [] },
		}),
	);
}

describe("embed realtime connection limits", () => {
	test("a normal turn releases the concurrency slot", async () => {
		const limits = createEmbedLimits({ turnSlotCapacity: 2, config: {} });
		const turn = deferredTurn();
		const harness = makeConnection({
			limits,
			services: { ...noopServices, executeTurn: async () => turn.promise },
		});
		sendTurn(harness.ws);
		await flush();
		expect(limits.turnSlots.active).toBe(1);
		turn.resolve(okTurn("hi"));
		await flush();
		expect(limits.turnSlots.active).toBe(0);
		expect(harness.ws.sent.some((e) => e.type === "message.completed")).toBe(true);
	});

	test("a failed turn also releases the concurrency slot", async () => {
		const limits = createEmbedLimits({ turnSlotCapacity: 1, config: {} });
		const harness = makeConnection({
			limits,
			services: {
				...noopServices,
				executeTurn: async () => ({ ok: false, code: "RUNTIME_UNAVAILABLE", message: "boom", retryable: true }),
			},
		});
		sendTurn(harness.ws);
		await flush();
		expect(limits.turnSlots.active).toBe(0);
		expect(harness.ws.sent.some((e) => e.type === "turn.failed")).toBe(true);
	});

	test("when the slot is exhausted the next turn.start fails immediately (no queue)", async () => {
		const limits = createEmbedLimits({ turnSlotCapacity: 1, config: {} });
		const turn = deferredTurn();
		const harness = makeConnection({
			limits,
			services: { ...noopServices, executeTurn: async () => turn.promise },
		});
		sendTurn(harness.ws); // 持有唯一槽
		await flush();
		expect(limits.turnSlots.active).toBe(1);
		sendTurn(harness.ws); // 无槽可等 -> 立即失败
		await flush();
		const failed = harness.ws.sent.filter((e) => e.type === "turn.failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.error).toContain("too many concurrent turns");
		turn.resolve(okTurn("first"));
		await flush();
		expect(limits.turnSlots.active).toBe(0);
	});

	test("conversation layer is the most restrictive for a single conversation", async () => {
		const limits = createEmbedLimits({
			config: {
				principal: { turn: { count: 100, windowMs: 60_000 } },
				conversation: { turn: { count: 1, windowMs: 60_000 } },
			},
		});
		const harness = makeConnection({ limits });
		sendTurn(harness.ws);
		await flush();
		sendTurn(harness.ws); // principal 仍有余量，但会话层已超限
		await flush();
		const failed = harness.ws.sent.filter((e) => e.type === "turn.failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.error).toContain("turn rate limit exceeded");
	});
});

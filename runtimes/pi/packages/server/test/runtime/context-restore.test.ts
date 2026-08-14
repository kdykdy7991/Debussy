/**
 * TASK-022: 持久事件 -> 上下文恢复纯函数测试（spec TASK-022 完成条件）。
 *
 * 覆盖：完整对恢复、长会话预算截断（保留最近对）、in-flight 收敛、
 * 未知 eventSchemaVersion 跳过、工具等不支持事件跳过、turn.failed 终止
 * pending、孤立 assistant.completed 跳过、历史序列化。
 */
import { describe, expect, test } from "vitest";
import type { ConversationEventRecord } from "../../src/publishing/repositories.ts";
import { historyToContextText, historyToReference, restoreContext } from "../../src/runtime/context-restore.ts";

function event(overrides: Partial<ConversationEventRecord> & { eventType: string }): ConversationEventRecord {
	return {
		eventId: `evt_${Math.random()}` as ConversationEventRecord["eventId"],
		tenantId: "ten" as never,
		publishedAppId: "app" as never,
		conversationId: "conv" as never,
		sequence: 0,
		eventSchemaVersion: 1,
		turnId: null,
		payload: {},
		createdAt: new Date(0),
		...overrides,
	};
}

function user(turnId: string, text: string, sequence: number): ConversationEventRecord {
	return event({ eventType: "user.message", turnId: turnId as never, payload: { text }, sequence });
}

function assistant(turnId: string, text: string, sequence: number): ConversationEventRecord {
	return event({ eventType: "assistant.completed", turnId: turnId as never, payload: { text }, sequence });
}

describe("restoreContext", () => {
	test("restores complete user/assistant pairs in order", () => {
		const result = restoreContext(
			[user("t1", "hi", 1), assistant("t1", "hello", 2), user("t2", "bye", 3), assistant("t2", "see you", 4)],
			{ maxContextTokens: 100_000 },
		);
		expect(result.messages).toEqual([
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "hello" },
			{ role: "user", text: "bye" },
			{ role: "assistant", text: "see you" },
		]);
		expect(result.interruptedTurnIds).toEqual([]);
		expect(result.skippedEvents).toBe(0);
	});

	test("an in-flight turn (no completion) converges to interrupted", () => {
		const result = restoreContext([user("t1", "hi", 1), assistant("t1", "hello", 2), user("t2", "stuck", 3)], {
			maxContextTokens: 100_000,
		});
		expect(result.messages).toEqual([
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "hello" },
		]);
		expect(result.interruptedTurnIds).toEqual(["t2"]);
	});

	test("terminal events (turn.failed / turn.interrupted) end the pending turn without recovery", () => {
		const failed = restoreContext(
			[
				user("t1", "boom", 1),
				event({ eventType: "turn.failed", turnId: "t1" as never, payload: { error: "x" }, sequence: 2 }),
			],
			{ maxContextTokens: 100_000 },
		);
		expect(failed.messages).toEqual([]);
		expect(failed.interruptedTurnIds).toEqual([]);
		// 已收敛的 interrupted 不再重复上报。
		const interrupted = restoreContext(
			[
				user("t1", "stuck", 1),
				event({ eventType: "turn.interrupted", turnId: "t1" as never, payload: {}, sequence: 2 }),
			],
			{ maxContextTokens: 100_000 },
		);
		expect(interrupted.interruptedTurnIds).toEqual([]);
	});

	test("unknown event schema versions are skipped, not restored", () => {
		const result = restoreContext(
			[
				user("t1", "hi", 1),
				event({
					eventType: "assistant.completed",
					turnId: "t1" as never,
					payload: { text: "hello" },
					sequence: 2,
					eventSchemaVersion: 99,
				}),
			],
			{ maxContextTokens: 100_000 },
		);
		expect(result.messages).toEqual([]);
		expect(result.skippedEvents).toBe(1);
		expect(result.interruptedTurnIds).toEqual(["t1"]);
	});

	test("unsupported event types (tools) are skipped", () => {
		const result = restoreContext(
			[
				user("t1", "hi", 1),
				event({ eventType: "tool.started", turnId: "t1" as never, payload: { tool: "x" }, sequence: 2 }),
				assistant("t1", "hello", 3),
			],
			{ maxContextTokens: 100_000 },
		);
		expect(result.messages).toEqual([
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "hello" },
		]);
		expect(result.skippedEvents).toBe(1);
	});

	test("an orphan assistant.completed without a pending user message is skipped", () => {
		const result = restoreContext([assistant("t0", "orphan", 1), user("t1", "hi", 2), assistant("t1", "hello", 3)], {
			maxContextTokens: 100_000,
		});
		expect(result.messages).toEqual([
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "hello" },
		]);
		expect(result.skippedEvents).toBe(1);
	});

	test("long sessions are trimmed to the token budget, keeping the newest pairs", () => {
		const events: ConversationEventRecord[] = [];
		let sequence = 1;
		for (let i = 0; i < 50; i += 1) {
			events.push(user(`t${i}`, `user-message-${i}`, sequence));
			sequence += 1;
			events.push(assistant(`t${i}`, `assistant-message-${i}`, sequence));
			sequence += 1;
		}
		// 预算极小：只保留最近的若干对。
		const result = restoreContext(events, { maxContextTokens: 8 });
		expect(result.messages.length).toBeGreaterThan(0);
		expect(result.messages.length).toBeLessThan(events.length);
		expect(result.messages.at(-1)).toEqual({ role: "assistant", text: "assistant-message-49" });
		expect(result.messages.at(-2)).toEqual({ role: "user", text: "user-message-49" });
		// 至少保留最近一对。
		expect(result.messages.at(-1)).toEqual({ role: "assistant", text: "assistant-message-49" });
	});

	test("history serialization produces context text and a short reference", () => {
		const messages = [
			{ role: "user" as const, text: "hi" },
			{ role: "assistant" as const, text: "hello" },
		];
		expect(historyToContextText(messages)).toBe("user: hi\nassistant: hello");
		expect(historyToReference(messages)).toContain("1 轮");
	});
});

/**
 * TASK-023: Embed Realtime v1 Decoder 测试（spec 9 / 25.3）。
 *
 * 覆盖：每种合法客户端命令与服务端事件、缺字段、超长文本、超量附件、
 * 未知类型、非 JSON 值、负数 sequence、可选字段缺省。Web 与 Server 共用
 * 同一 Decoder（禁止直接断言 JSON.parse 结果）。
 */
import { describe, expect, test } from "vitest";
import {
	type ClientCommand,
	decodeClientCommand,
	decodeServerEvent,
	type EmbedServerEvent,
} from "../../src/embed/realtime.ts";

const BASE_EVENT = {
	conversationId: "conv_1",
	sequence: 1,
	turnId: "turn_1",
	eventId: "evt_1",
	timestamp: "2026-01-01T00:00:00Z",
};

describe("decodeClientCommand", () => {
	test("decodes every legal command", () => {
		const cases: { input: unknown; expect: ClientCommand }[] = [
			{
				input: { type: "conversation.subscribe", conversationId: "conv_1" },
				expect: { type: "conversation.subscribe", conversationId: "conv_1" },
			},
			{
				input: { type: "conversation.subscribe", conversationId: "conv_1", lastSeenSequence: 5 },
				expect: { type: "conversation.subscribe", conversationId: "conv_1", lastSeenSequence: 5 },
			},
			{
				input: {
					type: "turn.start",
					requestId: "req-1",
					conversationId: "conv_1",
					message: { text: "hi", attachmentIds: ["att_1"] },
					lastSeenSequence: 3,
				},
				expect: {
					type: "turn.start",
					requestId: "req-1",
					conversationId: "conv_1",
					message: { text: "hi", attachmentIds: ["att_1"] },
					lastSeenSequence: 3,
				},
			},
			{
				input: { type: "turn.cancel", conversationId: "conv_1" },
				expect: { type: "turn.cancel", conversationId: "conv_1" },
			},
			{
				input: { type: "turn.cancel", conversationId: "conv_1", turnId: "turn_1" },
				expect: { type: "turn.cancel", conversationId: "conv_1", turnId: "turn_1" },
			},
			{
				input: { type: "conversation.sync", conversationId: "conv_1", lastSeenSequence: 7 },
				expect: { type: "conversation.sync", conversationId: "conv_1", lastSeenSequence: 7 },
			},
			{
				input: { type: "client.ack", conversationId: "conv_1", sequence: 9 },
				expect: { type: "client.ack", conversationId: "conv_1", sequence: 9 },
			},
		];
		for (const { input, expect: expected } of cases) {
			const result = decodeClientCommand(input);
			expect(result.ok, JSON.stringify(input)).toBe(true);
			if (result.ok) expect(result.value).toEqual(expected);
		}
	});

	test("rejects non-object input", () => {
		for (const input of [null, "x", 42, [1], true]) {
			const result = decodeClientCommand(input);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("NOT_OBJECT");
		}
	});

	test("rejects unknown command types", () => {
		const result = decodeClientCommand({ type: "turn.explode", conversationId: "conv_1" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TYPE");
	});

	test("rejects missing and mistyped fields", () => {
		const noConversation = decodeClientCommand({ type: "conversation.subscribe" });
		expect(noConversation.ok).toBe(false);
		if (!noConversation.ok) expect(noConversation.error.code).toBe("INVALID_FIELD");

		const badSequence = decodeClientCommand({
			type: "conversation.sync",
			conversationId: "conv_1",
			lastSeenSequence: -1,
		});
		expect(badSequence.ok).toBe(false);
		if (!badSequence.ok) expect(badSequence.error.code).toBe("INVALID_FIELD");

		const badText = decodeClientCommand({
			type: "turn.start",
			requestId: "r",
			conversationId: "conv_1",
			message: { text: 42, attachmentIds: [] },
			lastSeenSequence: 0,
		});
		expect(badText.ok).toBe(false);
		if (!badText.ok) expect(badText.error.code).toBe("INVALID_FIELD");
	});

	test("rejects over-long text, requestId and too many attachments", () => {
		const longText = decodeClientCommand({
			type: "turn.start",
			requestId: "r",
			conversationId: "conv_1",
			message: { text: "x".repeat(32_001), attachmentIds: [] },
			lastSeenSequence: 0,
		});
		expect(longText.ok).toBe(false);
		if (!longText.ok) expect(longText.error.code).toBe("TOO_LONG");

		const longRequestId = decodeClientCommand({
			type: "turn.start",
			requestId: "r".repeat(129),
			conversationId: "conv_1",
			message: { text: "hi", attachmentIds: [] },
			lastSeenSequence: 0,
		});
		expect(longRequestId.ok).toBe(false);
		if (!longRequestId.ok) expect(longRequestId.error.code).toBe("TOO_LONG");

		const manyAttachments = decodeClientCommand({
			type: "turn.start",
			requestId: "r",
			conversationId: "conv_1",
			message: { text: "hi", attachmentIds: Array.from({ length: 11 }, (_, i) => `att_${i}`) },
			lastSeenSequence: 0,
		});
		expect(manyAttachments.ok).toBe(false);
		if (!manyAttachments.ok) expect(manyAttachments.error.code).toBe("TOO_LONG");
	});
});

describe("decodeServerEvent", () => {
	test("decodes every legal event type", () => {
		const cases: { input: unknown; type: string }[] = [
			{ input: { ...BASE_EVENT, type: "conversation.snapshot", payload: {} }, type: "conversation.snapshot" },
			{ input: { ...BASE_EVENT, type: "turn.accepted" }, type: "turn.accepted" },
			{ input: { ...BASE_EVENT, type: "message.delta", text: "hel" }, type: "message.delta" },
			{ input: { ...BASE_EVENT, type: "message.completed", text: "hello" }, type: "message.completed" },
			{ input: { ...BASE_EVENT, type: "tool.started", tool: "web.search" }, type: "tool.started" },
			{ input: { ...BASE_EVENT, type: "tool.completed", tool: "web.search", ok: true }, type: "tool.completed" },
			{ input: { ...BASE_EVENT, type: "citation.updated", citations: [{ id: "c1" }] }, type: "citation.updated" },
			{ input: { ...BASE_EVENT, type: "usage.updated", usage: { input: 10, output: 5 } }, type: "usage.updated" },
			{ input: { ...BASE_EVENT, type: "turn.failed", error: "boom" }, type: "turn.failed" },
			{ input: { ...BASE_EVENT, type: "turn.cancelled" }, type: "turn.cancelled" },
			{ input: { ...BASE_EVENT, type: "runtime.status", status: "running" }, type: "runtime.status" },
		];
		for (const { input, type } of cases) {
			const result = decodeServerEvent(input);
			expect(result.ok, JSON.stringify(input)).toBe(true);
			if (result.ok) {
				expect(result.value.type).toBe(type);
				expect((result.value as EmbedServerEvent & { conversationId: string }).conversationId).toBe("conv_1");
				expect((result.value as EmbedServerEvent & { sequence: number }).sequence).toBe(1);
			}
		}
	});

	test("null turnId is legal (recoverable fields are validated)", () => {
		const result = decodeServerEvent({ ...BASE_EVENT, turnId: null, type: "turn.accepted" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.turnId).toBeNull();
	});

	test("rejects non-object input, unknown types and missing recoverable fields", () => {
		for (const input of [null, "x", [1]]) {
			const result = decodeServerEvent(input);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("NOT_OBJECT");
		}
		const unknown = decodeServerEvent({ ...BASE_EVENT, type: "message.teleported" });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.code).toBe("UNKNOWN_TYPE");

		const missingSequence = decodeServerEvent({
			conversationId: "conv_1",
			type: "turn.accepted",
			turnId: null,
			eventId: "e",
			timestamp: "t",
		});
		expect(missingSequence.ok).toBe(false);
		if (!missingSequence.ok) expect(missingSequence.error.code).toBe("INVALID_FIELD");

		const negativeSequence = decodeServerEvent({ ...BASE_EVENT, sequence: -1, type: "turn.accepted" });
		expect(negativeSequence.ok).toBe(false);
		if (!negativeSequence.ok) expect(negativeSequence.error.code).toBe("INVALID_FIELD");
	});

	test("rejects over-long event text", () => {
		const result = decodeServerEvent({ ...BASE_EVENT, type: "message.delta", text: "x".repeat(32_001) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("TOO_LONG");
	});
});

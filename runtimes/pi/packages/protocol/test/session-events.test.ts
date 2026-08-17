import { describe, expect, test } from "vitest";
import {
	assertEventPayloadSafe,
	DEFAULT_CONVERSATION_LIMITS,
	SESSION_EVENT_PAYLOAD_BYTE_LIMIT,
	SESSION_EVENT_TYPES,
	SESSION_LOG_LEVELS,
	SessionEventPayloadError,
	shouldInlineToolInput,
	shouldPersistAssistantChunk,
	shouldRolloverConversation,
} from "../src/index.ts";

describe("session event envelope (WB-007)", () => {
	test("event type catalogue is frozen", () => {
		expect(SESSION_EVENT_TYPES).toContain("user/message");
		expect(SESSION_EVENT_TYPES).toContain("assistant/message");
		expect(SESSION_EVENT_TYPES).toContain("tool/call");
		expect(SESSION_EVENT_TYPES).toContain("tool/error");
		expect(SESSION_EVENT_TYPES).toContain("turn/interrupted");
		expect(SESSION_EVENT_TYPES).toContain("conversation/rollover");
	});

	test("rejects sensitive keys anywhere in the payload", () => {
		const sensitive = [
			"adminToken",
			"accessToken",
			"launchToken",
			"authorization",
			"externalUserId",
			"visitorId",
			"privateKey",
			"launchKeyPem",
		];
		for (const key of sensitive) {
			expect(() => assertEventPayloadSafe({ [key]: "x" })).toThrow(SessionEventPayloadError);
		}
	});

	test("rejects nested sensitive keys", () => {
		expect(() =>
			assertEventPayloadSafe({
				turn: { metadata: { adminToken: "abc" } },
			}),
		).toThrow(/adminToken/);
	});

	test("rejects token-shaped values regardless of key", () => {
		expect(() => assertEventPayloadSafe({ note: "Bearer abc.def" })).toThrow(SessionEventPayloadError);
		expect(() => assertEventPayloadSafe({ note: "eyJabc.eyJdef.signature" })).toThrow(SessionEventPayloadError);
		expect(() => assertEventPayloadSafe({ note: "-----BEGIN RSA PRIVATE KEY-----" })).toThrow(
			SessionEventPayloadError,
		);
		expect(() => assertEventPayloadSafe({ note: "sk-1234567890abcdef1234" })).toThrow(SessionEventPayloadError);
	});

	test("rejects non-JSON-serialisable values", () => {
		expect(() => assertEventPayloadSafe({ fn: () => 1 })).toThrow(SessionEventPayloadError);
		expect(() => assertEventPayloadSafe({ sym: Symbol("x") })).toThrow(SessionEventPayloadError);
		expect(() => assertEventPayloadSafe({ nan: Number.NaN })).toThrow(SessionEventPayloadError);
	});

	test("rejects payloads larger than the byte ceiling", () => {
		const huge = { text: "x".repeat(SESSION_EVENT_PAYLOAD_BYTE_LIMIT + 1) };
		expect(() => assertEventPayloadSafe(huge)).toThrow(/exceeds/);
	});

	test("accepts a normal payload", () => {
		expect(() =>
			assertEventPayloadSafe({
				eventType: "user/message",
				text: "hello",
				metadata: { source: "embed", locale: "zh-CN" },
			}),
		).not.toThrow();
	});

	test("rejects unknown event types", () => {
		expect(() =>
			assertEventPayloadSafe({ foo: 1 }, { eventType: "wat/this-is-not-in-the-catalogue" as never }),
		).toThrow(SessionEventPayloadError);
	});
});

describe("session log level policies (WB-007)", () => {
	test("standard level drops streaming chunks", () => {
		expect(shouldPersistAssistantChunk("standard", { ordinal: 1, isFirst: true, isLast: false })).toBe(false);
		expect(shouldPersistAssistantChunk("standard", { ordinal: 99, isFirst: false, isLast: true })).toBe(false);
	});

	test("diagnostic level keeps first, last and milestone chunks", () => {
		expect(shouldPersistAssistantChunk("diagnostic", { ordinal: 1, isFirst: true, isLast: false })).toBe(true);
		expect(shouldPersistAssistantChunk("diagnostic", { ordinal: 17, isFirst: false, isLast: false })).toBe(true);
		expect(shouldPersistAssistantChunk("diagnostic", { ordinal: 5, isFirst: false, isLast: false })).toBe(false);
		expect(shouldPersistAssistantChunk("diagnostic", { ordinal: 9, isFirst: false, isLast: true })).toBe(true);
	});

	test("full level keeps every chunk", () => {
		expect(shouldPersistAssistantChunk("full", { ordinal: 7, isFirst: false, isLast: false })).toBe(true);
	});

	test("tool input is inlined only at the full level", () => {
		expect(shouldInlineToolInput("standard")).toBe(false);
		expect(shouldInlineToolInput("diagnostic")).toBe(false);
		expect(shouldInlineToolInput("full")).toBe(true);
	});

	test("log level catalogue is frozen", () => {
		expect(SESSION_LOG_LEVELS).toEqual(["standard", "diagnostic", "full"]);
	});
});

describe("conversation rollover (WB-008)", () => {
	test("does not roll over below any limit", () => {
		const counters = { eventCount: 100, eventBytes: 1000, turnCount: 10 };
		expect(shouldRolloverConversation(counters, DEFAULT_CONVERSATION_LIMITS)).toBe(false);
	});

	test("rolls over when eventCount reaches the limit", () => {
		const counters = {
			eventCount: DEFAULT_CONVERSATION_LIMITS.maxConversationEvents,
			eventBytes: 100,
			turnCount: 10,
		};
		expect(shouldRolloverConversation(counters, DEFAULT_CONVERSATION_LIMITS)).toBe(true);
	});

	test("rolls over when eventBytes reaches the limit", () => {
		const counters = {
			eventCount: 100,
			eventBytes: DEFAULT_CONVERSATION_LIMITS.maxConversationEventBytes,
			turnCount: 10,
		};
		expect(shouldRolloverConversation(counters, DEFAULT_CONVERSATION_LIMITS)).toBe(true);
	});

	test("rolls over when turnCount reaches the limit", () => {
		const counters = {
			eventCount: 100,
			eventBytes: 100,
			turnCount: DEFAULT_CONVERSATION_LIMITS.maxConversationTurns,
		};
		expect(shouldRolloverConversation(counters, DEFAULT_CONVERSATION_LIMITS)).toBe(true);
	});

	test("custom limits apply", () => {
		const limits = { maxConversationEvents: 5, maxConversationEventBytes: 100, maxConversationTurns: 2 };
		expect(shouldRolloverConversation({ eventCount: 5, eventBytes: 99, turnCount: 1 }, limits)).toBe(true);
		expect(shouldRolloverConversation({ eventCount: 4, eventBytes: 99, turnCount: 1 }, limits)).toBe(false);
	});

	test("default limits match spec §12.3 baseline", () => {
		expect(DEFAULT_CONVERSATION_LIMITS).toEqual({
			maxConversationEvents: 5_000,
			maxConversationEventBytes: 20 * 1024 * 1024,
			maxConversationTurns: 500,
		});
	});
});

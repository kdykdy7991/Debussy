import { describe, expect, test } from "vitest";
import {
	assertEventPayloadSafe,
	SESSION_EVENT_PAYLOAD_BYTE_LIMIT,
	SESSION_EVENT_TYPES,
	SESSION_LOG_LEVELS,
	SessionEventPayloadError,
	shouldInlineToolInput,
	shouldPersistAssistantChunk,
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

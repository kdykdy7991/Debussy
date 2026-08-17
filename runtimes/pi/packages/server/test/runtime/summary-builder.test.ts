/**
 * WB-008: deterministic summary builder pure-function tests (spec §12.2).
 */
import { describe, expect, test } from "vitest";
import type { ConversationEventRecord } from "../../src/publishing/repositories.ts";
import { buildSummary, DEFAULT_SUMMARY_TURN_WINDOW } from "../../src/runtime/summary-builder.ts";

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
		payloadBytes: 0,
		createdAt: new Date(0),
		...overrides,
	};
}

describe("buildSummary (WB-008)", () => {
	test("returns throughSequence = 0 when there are no assistant messages", () => {
		const result = buildSummary([event({ eventType: "user/message", payload: { text: "hi" }, sequence: 1 })]);
		expect(result.throughSequence).toBe(0);
		expect(result.body.lastUserMessage).toBe("hi");
		expect(result.body.openItems).toEqual(["hi"]);
	});

	test("captures the last completed turn in the body", () => {
		const events = [
			event({ eventType: "user/message", turnId: "t1" as never, payload: { text: "u1" }, sequence: 1 }),
			event({
				eventType: "assistant/message",
				turnId: "t1" as never,
				payload: { text: "a1" },
				sequence: 2,
			}),
			event({ eventType: "user/message", turnId: "t2" as never, payload: { text: "u2" }, sequence: 3 }),
			event({
				eventType: "assistant/message",
				turnId: "t2" as never,
				payload: { text: "a2" },
				sequence: 4,
			}),
		];
		const result = buildSummary(events);
		expect(result.throughSequence).toBe(4);
		expect(result.body.keyFacts).toEqual(["a1", "a2"]);
		expect(result.body.lastUserMessage).toBe("u2");
	});

	test("respects the turn window", () => {
		const events: ConversationEventRecord[] = [];
		let seq = 1;
		for (let i = 0; i < DEFAULT_SUMMARY_TURN_WINDOW + 5; i += 1) {
			events.push(
				event({ eventType: "user/message", turnId: `t${i}` as never, payload: { text: `u${i}` }, sequence: seq }),
			);
			seq += 1;
			events.push(
				event({
					eventType: "assistant/message",
					turnId: `t${i}` as never,
					payload: { text: `a${i}` },
					sequence: seq,
				}),
			);
			seq += 1;
		}
		const result = buildSummary(events);
		expect(result.body.text).toContain(`u${DEFAULT_SUMMARY_TURN_WINDOW + 4}`);
		expect(result.body.text).not.toContain("u0\nassistant:");
	});

	test("drops failed turns from the body verbatim", () => {
		const events = [
			event({ eventType: "user/message", turnId: "t1" as never, payload: { text: "u1" }, sequence: 1 }),
			event({ eventType: "turn/failed", turnId: "t1" as never, payload: { error: "x" }, sequence: 2 }),
			event({ eventType: "user/message", turnId: "t2" as never, payload: { text: "u2" }, sequence: 3 }),
			event({
				eventType: "assistant/message",
				turnId: "t2" as never,
				payload: { text: "a2" },
				sequence: 4,
			}),
		];
		const result = buildSummary(events);
		expect(result.body.keyFacts).toEqual(["a2"]);
		expect(result.body.lastUserMessage).toBe("u2");
	});

	test("deduplicates key facts", () => {
		const events = [
			event({ eventType: "user/message", turnId: "t1" as never, payload: { text: "u1" }, sequence: 1 }),
			event({
				eventType: "assistant/message",
				turnId: "t1" as never,
				payload: { text: "fact" },
				sequence: 2,
			}),
			event({ eventType: "user/message", turnId: "t2" as never, payload: { text: "u2" }, sequence: 3 }),
			event({
				eventType: "assistant/message",
				turnId: "t2" as never,
				payload: { text: "fact" },
				sequence: 4,
			}),
		];
		const result = buildSummary(events);
		expect(result.body.keyFacts).toEqual(["fact"]);
	});
});

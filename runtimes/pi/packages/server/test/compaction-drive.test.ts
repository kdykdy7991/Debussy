import { describe, expect, it } from "vitest";
import type { ConversationEventRecord } from "../src/publishing/repositories.ts";
import {
	deriveMeasuredRuntimeOverhead,
	estimateWorkingContextTokens,
	planCompaction,
	shouldCompactWorkingContext,
	workingContextBudget,
} from "../src/runtime/compaction-drive.ts";
import { buildSummary } from "../src/runtime/summary-builder.ts";
import { actualInputTokens, conservativeRuntimeOverhead } from "../src/runtime/token-accounting.ts";

function evt(
	sequence: number,
	eventType: string,
	turnId: string,
	payload: Record<string, unknown>,
): ConversationEventRecord {
	return {
		eventId: `ev-${sequence}` as ConversationEventRecord["eventId"],
		tenantId: "t" as never,
		publishedAppId: "a" as never,
		conversationId: "c" as never,
		sequence,
		eventType,
		eventSchemaVersion: 1,
		turnId: turnId as never,
		payload,
		payloadBytes: 0,
		createdAt: new Date(0),
	};
}

/** A complete turn: user -> ([tool call + result]) -> assistant. */
function turn(
	baseSequence: number,
	turnId: string,
	userText: string,
	assistantText: string,
	tool = false,
): ConversationEventRecord[] {
	const events: ConversationEventRecord[] = [evt(baseSequence, "user/message", turnId, { text: userText })];
	let seq = baseSequence + 1;
	if (tool) {
		events.push(evt(seq, "tool/call", turnId, { toolCallId: `tc-${turnId}`, toolName: "x", input: { q: "v" } }));
		seq += 1;
		events.push(
			evt(seq, "tool/result", turnId, {
				toolCallId: `tc-${turnId}`,
				toolName: "x",
				content: [{ type: "text", text: "r" }],
			}),
		);
		seq += 1;
	}
	events.push(evt(seq, "assistant/message", turnId, { text: assistantText }));
	return events;
}

describe("workingContextBudget (Phase-3.6 measured-overhead budget)", () => {
	const SAFETY = 512; // default safety margin (DEFAULT_SAFETY_MARGIN)

	it("uses the smaller of the model window and the platform policy, minus real output + safety", () => {
		// model window (100k) < policy (200k) => effective 100k, -maxTokens 8k -safety 512
		expect(workingContextBudget({ contextWindow: 100_000, maxTokens: 8_000 }, 200_000)).toBe(
			100_000 - 8_000 - SAFETY,
		);
		// policy (50k) < model window (128k) => effective 50k
		expect(workingContextBudget({ contextWindow: 128_000, maxTokens: 4_000 }, 50_000)).toBe(50_000 - 4_000 - SAFETY);
	});

	it("reserves real output once (does NOT gain from stacking a fixed 16384)", () => {
		const a = workingContextBudget({ contextWindow: 128_000, maxTokens: 16_384 }, 128_000);
		const b = workingContextBudget({ contextWindow: 128_000, maxTokens: 4_096 }, 128_000);
		// Larger REAL maxTokens shrinks the budget by exactly the delta.
		expect(a).toBe(b - (16_384 - 4_096));
		expect(a).toBe(128_000 - 16_384 - SAFETY);
	});

	it("subtracts a MEASURED runtime overhead (system+skills+tools), not a fixed 2048", () => {
		const budget = workingContextBudget({ contextWindow: 100_000, maxTokens: 8_000 }, 200_000, {
			runtimeOverheadTokens: 12_000,
		});
		expect(budget).toBe(100_000 - 8_000 - 12_000 - SAFETY);
	});

	it("subtracts a next-input reserve at turn/end (space for the unknown next message)", () => {
		// nextInputReserveTokens: 0 (pre-prompt, current user already counted)
		expect(
			workingContextBudget({ contextWindow: 100_000, maxTokens: 8_000 }, 200_000, {
				nextInputReserveTokens: 0,
			}),
		).toBe(100_000 - 8_000 - SAFETY);
		// turn/end reserves space for the unknown next message
		expect(
			workingContextBudget({ contextWindow: 100_000, maxTokens: 8_000 }, 200_000, {
				nextInputReserveTokens: 2_048,
			}),
		).toBe(100_000 - 8_000 - 2_048 - SAFETY);
	});

	it("falls back safely when the model window is unknown (declared policy ceiling, conservative output)", () => {
		const budget = workingContextBudget({}, 100_000);
		// Declared policy as ceiling; conservative output (8192); default safety 512.
		expect(budget).toBe(100_000 - 8_192 - SAFETY);
		expect(budget).toBeGreaterThan(0);
	});

	it("uses control-configured custom model metadata (not a guessed/default window)", () => {
		expect(workingContextBudget({ contextWindow: 200_000, maxTokens: 32_000 }, 1_000_000)).toBe(
			200_000 - 32_000 - SAFETY,
		);
	});

	it("returns 0 (compact on any non-empty context) when no ceiling is knowable", () => {
		expect(workingContextBudget({}, 0)).toBe(0);
		expect(workingContextBudget({ contextWindow: 1_000, maxTokens: 2_000 }, 100_000)).toBe(0);
	});
});

describe("actualInputTokens + conservativeRuntimeOverhead", () => {
	it("is input + cacheRead, matching Pi's overflow semantic with no cache double-count", () => {
		expect(actualInputTokens({ input: 5_000, cacheRead: 2_000 })).toBe(7_000);
		// cacheWrite is NOT part of the request input that competes for the window.
		expect(actualInputTokens({ input: 5_000, cacheRead: 2_000, cacheWrite: 9_999 })).toBe(7_000);
		expect(actualInputTokens({ input: 5_000 })).toBe(5_000);
		expect(actualInputTokens({ cacheRead: 2_000 })).toBe(2_000);
		expect(actualInputTokens(undefined)).toBe(0);
		expect(actualInputTokens(null)).toBe(0);
	});

	it("conservative fallback scales with the window (0.2), never a fixed 2048", () => {
		expect(conservativeRuntimeOverhead(100_000)).toBe(20_000);
		expect(conservativeRuntimeOverhead(200_000)).toBe(40_000);
	});
});

describe("deriveMeasuredRuntimeOverhead (from persisted turn/end usage, no new state)", () => {
	const usageTurn = (base: number, turnId: string, usage: Record<string, unknown>): ConversationEventRecord[] => [
		evt(base, "user/message", turnId, { text: "u" }),
		evt(base + 1, "assistant/message", turnId, { text: "a" }),
		evt(base + 2, "turn/end", turnId, { usage }),
	];

	it("measures overhead = last actual input minus the working context of that request", () => {
		const events = [
			...usageTurn(1, "t1", { input: 3_000, cacheRead: 1_000 }), // actual input 4000
			...usageTurn(5, "t2", { input: 3_000, cacheRead: 1_000 }), // actual input 4000
		];
		const overhead = deriveMeasuredRuntimeOverhead(events, "");
		// working context of t1/t2 request is > 0, so overhead is comfortably positive.
		expect(overhead).toBeDefined();
		expect(overhead as number).toBeGreaterThan(0);
		// overhead = last actual input (4000) - estimated working context of that request
		expect(overhead as number).toBeLessThan(4_000);
	});

	it("uses input + cacheRead (cached tokens are real input) and excludes cacheWrite", () => {
		const events = [...usageTurn(1, "t1", { input: 0, cacheRead: 0, cacheWrite: 50_000 })];
		const overhead = deriveMeasuredRuntimeOverhead(events, "");
		// cacheWrite only -> actual input 0 <= working context => clamped to 0, never negative.
		expect(overhead).toBe(0);
	});

	it("ignores an in-flight trailing user message (measurement is stable pre-prompt)", () => {
		const events = [
			...usageTurn(1, "t1", { input: 3_000, cacheRead: 1_000 }),
			evt(4, "user/message", "t2", { text: "in-flight current user (long)" }),
		];
		const withInflight = deriveMeasuredRuntimeOverhead(events, "");
		const withoutInflight = deriveMeasuredRuntimeOverhead(events.slice(0, 3), "");
		// The in-flight user is excluded from the measured request's working context.
		expect(withInflight).toBe(withoutInflight);
	});

	it("returns undefined when no turned usage exists yet (falls back to conservative)", () => {
		const events = turn(1, "t1", "only user", "only asst");
		expect(deriveMeasuredRuntimeOverhead(events, "")).toBeUndefined();
	});

	it("uses the LATEST measured usage, not the first", () => {
		const events = [
			...usageTurn(1, "t1", { input: 1_000, cacheRead: 0 }),
			...usageTurn(5, "t2", { input: 9_000, cacheRead: 0 }),
		];
		const overhead = deriveMeasuredRuntimeOverhead(events, "");
		// Based on the last usable input (9000), so larger than the first-request-only.
		expect(overhead as number).toBeGreaterThanOrEqual(9_000 - 500);
	});
});

describe("shouldCompactWorkingContext", () => {
	it("compacts only when the estimate exceeds the budget", () => {
		expect(shouldCompactWorkingContext(90_000, 80_000)).toBe(true);
		expect(shouldCompactWorkingContext(70_000, 80_000)).toBe(false);
	});
});

describe("planCompaction boundary (complete-Turn safety)", () => {
	const turns = [
		...turn(1, "t1", "first user", "first asst"),
		...turn(6, "t2", "second user", "second asst"),
		...turn(11, "t3", "third user", "third asst"),
	];

	it("returns a complete-Turn assistant/message sequence as the boundary", () => {
		// Turns: t1(user=1, asst=2) t2(user=6, asst=7) t3(user=11, asst=12).
		// Tiny keep window => t3 is kept verbatim, everything older collapses to t2's end.
		const plan = planCompaction(turns, { keepRecentTokens: 1 });
		expect(plan.shouldCompact).toBe(true);
		expect(plan.throughSequence).toBe(7);
		expect(plan.summarizeEvents[plan.summarizeEvents.length - 1]).toMatchObject({
			eventType: "assistant/message",
			turnId: "t2",
		});
		expect(plan.keepEvents[0]).toMatchObject({ eventType: "user/message", turnId: "t3" });
	});

	it("never cuts inside a tool call / result pair", () => {
		const withTool = [
			...turn(1, "t1", "first user", "first asst", true), // user(1) tool/call(2) tool/result(3) assistant(4)
			...turn(5, "t2", "second user", "second asst", true), // user(5) tool/call(6) tool/result(7) assistant(8)
		];
		const plan = planCompaction(withTool, { keepRecentTokens: 1 });
		// Keep just t2 => t1 is collapsed; boundary is t1's assistant/message (4), never a tool event.
		expect(plan.throughSequence).toBe(4);
		const last = plan.summarizeEvents[plan.summarizeEvents.length - 1];
		expect(last.eventType).toBe("assistant/message");
		// The kept t2 turn is intact: user -> tool/call -> tool/result (uninterrupted).
		expect(plan.keepEvents.slice(0, 3).map((e) => e.eventType)).toEqual(["user/message", "tool/call", "tool/result"]);
	});

	it("never collapses a pending / in-flight (incomplete) trailing turn", () => {
		const events = [
			...turn(1, "t1", "first user", "first asst"), // user(1) asst(2)
			...turn(3, "t2", "second user", "second asst"), // user(3) asst(4)
			evt(5, "user/message", "t3", { text: "pending user, no assistant yet" }),
		];
		const plan = planCompaction(events, { keepRecentTokens: 1 });
		// Keep t2 + pending t3; collapse t1 up to its assistant/message (2).
		expect(plan.throughSequence).toBe(2);
		expect(plan.keepEvents[0]).toMatchObject({ eventType: "user/message", turnId: "t2" });
		// The pending (incomplete) t3 message survives untouched as the trailing event.
		expect(plan.keepEvents[plan.keepEvents.length - 1]).toMatchObject({
			eventType: "user/message",
			turnId: "t3",
		});
	});

	it("does not compact when there is nothing old enough to collapse", () => {
		const single = turn(1, "t1", "only user", "only asst");
		const plan = planCompaction(single, { keepRecentTokens: 200_000, budget: 1, summaryText: "" });
		expect(plan.shouldCompact).toBe(false);
		expect(plan.throughSequence).toBe(0);
	});
});

describe("estimateWorkingContextTokens", () => {
	it("is positive and grows with more events", () => {
		const one = turn(1, "t1", "hello user", "hello asst");
		const two = [...one, ...turn(4, "t2", "second user", "second asst")];
		const a = estimateWorkingContextTokens(one, "");
		const b = estimateWorkingContextTokens(two, "");
		expect(a).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(a);
	});
});

describe("chained summary (Summary v1 -> v2)", () => {
	it("carries the prior summary body forward and derives throughSequence from the delta", () => {
		const v1 = buildSummary(turn(1, "t1", "u1", "a1"));
		expect(v1.throughSequence).toBe(2);

		const delta = turn(10, "t2", "u2", "a2");
		const v2 = buildSummary(delta, { previousBody: v1.body });
		// throughSequence is this slice's last assistant/message (strictly > v1.throughSequence).
		expect(v2.throughSequence).toBeGreaterThan(v1.throughSequence);
		expect(v2.body.text).toContain("# Prior context");
		expect(v2.body.text).toContain("u2");
		expect(v2.body.keyFacts).toEqual(["a1", "a2"]);
	});
});

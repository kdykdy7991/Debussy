import { describe, expect, it } from "vitest";
import type { ConversationEventRecord } from "../src/publishing/repositories.ts";
import { planCompaction } from "../src/runtime/compaction-drive.ts";
import {
	buildSummaryRestoredMessage,
	mergeRestored,
	type RestoredContext,
	restoreContext,
} from "../src/runtime/context-restore.ts";
import { buildSummary } from "../src/runtime/summary-builder.ts";

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

/** A complete turn with an optional tool call + result. */
function turn(
	baseSequence: number,
	turnId: string,
	userText: string,
	assistantText: string,
	tool = false,
): ConversationEventRecord[] {
	const out = [evt(baseSequence, "user/message", turnId, { text: userText })];
	let seq = baseSequence + 1;
	if (tool) {
		out.push(evt(seq, "tool/call", turnId, { toolCallId: `tc-${turnId}`, toolName: "x", input: { q: "v" } }));
		seq += 1;
		out.push(
			evt(seq, "tool/result", turnId, {
				toolCallId: `tc-${turnId}`,
				toolName: "x",
				content: [{ type: "text", text: "r" }],
			}),
		);
		seq += 1;
	}
	out.push(evt(seq, "assistant/message", turnId, { text: assistantText }));
	return out;
}

const LOG = "standard" as const;

describe("Debussy Working-Context reconstruction (summary + structured recent)", () => {
	// Scenario: 4 turns // t1,t2,t3 collapsed into a summary up to t2; t3,t4 stay
	// as structured recent events (keepRecentTokens huge enough to retain t3..t4).
	const all = [
		...turn(1, "t1", "first user", "first asst", true),
		...turn(5, "t2", "second user", "second asst"),
		...turn(8, "t3", "third user", "third asst"),
		...turn(11, "t4", "fourth user", "fourth asst", true),
	];

	it("mergeRestored(heads summary) + structured recent produces a deterministic Working Context", () => {
		const plan = planCompaction(all, { keepRecentTokens: 8, budget: 1, summaryText: "" });
		expect(plan.shouldCompact).toBe(true);
		expect(plan.throughSequence).toBeGreaterThan(0);

		const summary = buildSummary(plan.summarizeEvents);
		const recent = restoreContext(
			plan.keepEvents as unknown as readonly ConversationEventRecord[],
			{ maxContextTokens: Number.MAX_SAFE_INTEGER },
			LOG,
		);
		const context = mergeRestored(
			buildSummaryRestoredMessage((summary.body as { text: string }).text, summary.throughSequence, LOG),
			recent,
		);

		// Head is the synthetic summary pair; the rest is verbatim structured recent.
		expect(context.transcript[0]).toMatchObject({ role: "user" });
		expect(context.transcript[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Understood. I will continue from summary." }],
		});
		expect(context.transcript[2]).toMatchObject({ role: "user" });
	});

	it("reconstructing the same Working Context twice is byte-identical (restart equivalence)", () => {
		const plan = planCompaction(all, { keepRecentTokens: 8, budget: 1, summaryText: "" });
		const summary = buildSummary(plan.summarizeEvents);

		const buildOnce = (): RestoredContext => {
			const recent = restoreContext(
				plan.keepEvents as unknown as readonly ConversationEventRecord[],
				{ maxContextTokens: Number.MAX_SAFE_INTEGER },
				LOG,
			);
			return mergeRestored(
				buildSummaryRestoredMessage((summary.body as { text: string }).text, summary.throughSequence, LOG),
				recent,
			);
		};
		const a = buildOnce();
		const b = buildOnce();
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("tool call + result of the most recent kept turn remain intact in the structured recent tail", () => {
		const plan = planCompaction(all, { keepRecentTokens: 1 });
		// keepRecent=1 => only t4 (the newest, with a tool pair) is recent.
		expect(plan.keepEvents[0].eventType).toBe("user/message");
		expect(plan.keepEvents.map((e) => e.eventType)).toContain("tool/call");
		expect(plan.keepEvents.map((e) => e.eventType)).toContain("tool/result");
		const recentRoles = restoreContext(
			plan.keepEvents as unknown as readonly ConversationEventRecord[],
			{ maxContextTokens: Number.MAX_SAFE_INTEGER },
			LOG,
		).transcript.map((m) => m.role);
		expect(recentRoles).toContain("toolResult");
	});
});

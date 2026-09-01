import { describe, expect, it } from "vitest";
import type { ConversationEventRecord } from "../src/publishing/repositories.ts";
import type { RuntimeSpec } from "../src/publishing/runtime-spec/schema.ts";
import { estimateWorkingContextTokens } from "../src/runtime/compaction-drive.ts";
import {
	type DebussyCompactionStore,
	type DebussyHeadSummary,
	type DebussySummaryRecord,
	runDebussyCompaction,
} from "../src/runtime/debussy-compaction.ts";

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

function turn(
	baseSequence: number,
	turnId: string,
	userText: string,
	assistantText: string,
): ConversationEventRecord[] {
	return [
		evt(baseSequence, "user/message", turnId, { text: userText }),
		evt(baseSequence + 1, "assistant/message", turnId, { text: assistantText }),
		evt(baseSequence + 2, "turn/end", turnId, { usage: { input: 10, cacheRead: 0 } }),
	];
}

function inFlightUser(sequence: number, turnId: string, text: string): ConversationEventRecord {
	return evt(sequence, "user/message", turnId, { text });
}

/** A fully in-memory DebussyCompactionStore (no persistence, no new table). */
class MemStore implements DebussyCompactionStore {
	latest: DebussyHeadSummary | null = null;
	events: ConversationEventRecord[] = [];

	async getLatest(): Promise<DebussyHeadSummary | null> {
		return this.latest;
	}
	async listEventsAfter(afterSequence: number, limit: number): Promise<readonly ConversationEventRecord[]> {
		return this.events.filter((e) => e.sequence > afterSequence).slice(0, limit);
	}
	async insert(record: DebussySummaryRecord): Promise<boolean> {
		this.latest = {
			id: record.id,
			throughSequence: record.throughSequence,
			tokensBefore: record.tokensBefore,
			body: record.body,
		};
		return true;
	}
	async advanceLatest(throughSequence: number): Promise<void> {
		if (this.latest === null) return;
		this.latest = { ...this.latest, throughSequence };
	}
}

function makeSpec(policy: number): RuntimeSpec {
	return {
		contextPolicy: { maxTurns: 1000, maxContextTokens: policy, toolResultMaxBytes: 65536, logLevel: "standard" },
		agent: { model: { provider: "test", modelId: "test" } },
	} as unknown as RuntimeSpec;
}

describe("runDebussyCompaction budget (Phase-3.6 measured runtime overhead)", () => {
	// Prior context large enough to make the conservative fallback vs measured
	// overhead budgets meaningfully different (needs c0 > ~26k tokens).
	const priorCount = 60;
	const prior: ConversationEventRecord[] = [];
	for (let i = 0; i < priorCount; i += 1) {
		prior.push(...turn(1 + i * 3, `t${i}`, `user ${i}: ${"x".repeat(3000)}`, `asst ${i}`));
	}
	const c0 = estimateWorkingContextTokens(prior, "");

	it("measured usage calibrates the budget; its absence falls back to a conservative WRAP fraction", async () => {
		// Policy chosen ~20k above the estimated Working Context.
		const policy = c0 + 20_000;
		const spec = makeSpec(policy);

		// Measured store: a turn/end with small usage -> measured overhead ~0.
		const measured = new MemStore();
		measured.events = prior.slice();
		// Fallback store: identical events but WITHOUT the turn/end usage, so no
		// measurement exists -> conservative WRAP (20% of effective window).
		const fallback = new MemStore();
		fallback.events = prior.filter((e) => e.eventType !== "turn/end");

		expect(c0).toBeGreaterThan(26_240); // guards the margin in the assertion below

		// Measured overhead (~0) leaves room: the Working Context fits, so NO compaction.
		const withUsage = await runDebussyCompaction(measured, spec, { model: {}, nextInputReserveTokens: 0 });
		expect(withUsage.compacted).toBe(false);

		// Conservative fallback (0.2 * 100k+ window) shrinks the budget enough that the
		// SAME Working Context now exceeds it -> compaction, purely from lost measurement.
		const noUsage = await runDebussyCompaction(fallback, spec, { model: {}, nextInputReserveTokens: 0 });
		expect(noUsage.compacted).toBe(true);
	});

	it("pre-prompt guard (nextInputReserve 0) compacts an oversized CURRENT user that turn/end (default reserve) would not", async () => {
		// At turn/end the (unknown) next message is reserved a small fixed space;
		// policy sits ~20k above the estimated prior Working Context.
		const huge = "huge current user message ".repeat(4_000); // ~>20k tokens
		const policy = c0 + 20_000;
		const spec = makeSpec(policy);

		// turn/end: prior turns only, default next-input reserve when the next msg was unknown.
		const turnEnd = new MemStore();
		turnEnd.events = prior.slice();
		const afterTurn = await runDebussyCompaction(turnEnd, spec, { model: {}, nextInputReserveTokens: 2_048 });
		expect(afterTurn.compacted).toBe(false);

		// pre-prompt: the huge current user is now known and in the estimate; reserve 0.
		const preprompt = new MemStore();
		const inFlightSeq = prior.length + 1; // contiguous next sequence, as in production
		preprompt.events = [...prior, inFlightUser(inFlightSeq, "cur", huge)];
		const estPre = estimateWorkingContextTokens(preprompt.events, "");
		expect(estPre - c0).toBe(0); // a trailing in-flight user is excluded from the restored transcript
		const guard = await runDebussyCompaction(preprompt, spec, {
			model: {},
			nextInputReserveTokens: 0,
			currentUserText: huge,
		});
		expect(guard.compacted).toBe(true);
		// The current turn was never collapsed (a single in-flight user is the trailing
		// event and the boundary stays a prior Turn's assistant).
		const boundary = guard.throughSequence;
		expect(boundary).toBeGreaterThan(0);
		expect(boundary).toBeLessThan(inFlightSeq); // before the in-flight user's sequence
	});
});

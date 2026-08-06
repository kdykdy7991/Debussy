import type { SessionProgressEvent } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { SessionEventLog } from "../src/event-log.ts";

function progress(delta: string): Omit<SessionProgressEvent, "sequence"> {
	return {
		type: "session_progress",
		sessionId: "session-1",
		turnId: "turn-1",
		progress: {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta,
		},
	};
}

function deltaOf(event: SessionProgressEvent): string {
	return event.progress.type === "assistant_delta" ? event.progress.delta : "?";
}

describe("SessionEventLog", () => {
	test("assigns increasing sequences starting at one", () => {
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 60_000 });
		expect(log.lastSequence).toBe(0);
		const first = log.append(progress("a"));
		const second = log.append(progress("b"));
		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(log.lastSequence).toBe(2);
	});

	test("replays events after a requested sequence in order", async () => {
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 60_000 });
		log.append(progress("a"));
		log.append(progress("b"));
		log.append(progress("c"));
		const sent: string[] = [];
		const result = await log.replay(1, async (event) => {
			sent.push(deltaOf(event));
			return true;
		});
		expect(sent).toEqual(["b", "c"]);
		expect(result).toEqual({ replayedThrough: 3, resetRequired: false });
	});

	test("replays everything for a fresh afterSequence of zero", async () => {
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 60_000 });
		log.append(progress("a"));
		log.append(progress("b"));
		const sent: number[] = [];
		const result = await log.replay(0, async (event) => {
			sent.push(event.sequence);
			return true;
		});
		expect(sent).toEqual([1, 2]);
		expect(result).toEqual({ replayedThrough: 2, resetRequired: false });
	});

	test("stops replaying when a connection stops accepting events", async () => {
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 60_000 });
		log.append(progress("a"));
		log.append(progress("b"));
		log.append(progress("c"));
		let accepted = 0;
		const sent: number[] = [];
		const result = await log.replay(0, async (event) => {
			if (accepted >= 2) return false;
			accepted += 1;
			sent.push(event.sequence);
			return true;
		});
		expect(sent).toEqual([1, 2]);
		expect(result).toEqual({ replayedThrough: 2, resetRequired: false });
	});

	test("reports resetRequired when the requested sequence is ahead of the log", async () => {
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 60_000 });
		log.append(progress("a"));
		log.append(progress("b"));
		const result = await log.replay(5, async () => true);
		expect(result).toEqual({ replayedThrough: 2, resetRequired: true });
	});

	test("reports resetRequired when the requested sequence predates evicted events", async () => {
		const log = new SessionEventLog({ maxEvents: 1, retentionMs: 60_000 });
		log.append(progress("a")); // sequence 1
		log.append(progress("b")); // sequence 2, evicts sequence 1
		log.append(progress("c")); // sequence 3, evicts sequence 2
		const result = await log.replay(1, async () => true);
		expect(result).toEqual({ replayedThrough: 3, resetRequired: true });
	});

	test("evicts old events by wall-clock retention", async () => {
		let now = 1_000;
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 500, now: () => now });
		log.append(progress("a")); // appended at 1000
		now = 1_200;
		log.append(progress("b")); // appended at 1200
		now = 1_600;
		log.append(progress("c")); // appended at 1600; cutoff 1100 evicts "a"
		expect(log.lastSequence).toBe(3);

		// A fresh client (afterSequence 0) is missing the evicted sequence 1.
		expect(await log.replay(0, async () => true)).toEqual({ replayedThrough: 3, resetRequired: true });
		// A client that saw sequence 1 can still catch up on 2 and 3.
		const sent: string[] = [];
		const result = await log.replay(1, async (event) => {
			sent.push(deltaOf(event));
			return true;
		});
		expect(sent).toEqual(["b", "c"]);
		expect(result).toEqual({ replayedThrough: 3, resetRequired: false });
	});

	test("an empty log accepts a zero afterSequence without reset", async () => {
		const log = new SessionEventLog({ maxEvents: 100, retentionMs: 60_000 });
		expect(await log.replay(0, async () => true)).toEqual({ replayedThrough: 0, resetRequired: false });
	});
});

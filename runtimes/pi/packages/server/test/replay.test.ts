import { describe, expect, it } from "vitest";
import { replayAllAfter, REPLAY_PAGE_SIZE } from "../src/runtime/replay.ts";

function seqRows(from: number, count: number) {
	return Array.from({ length: count }, (_, i) => ({ sequence: from + i + 1, data: `e${from + i + 1}` }));
}

describe("replayAllAfter (cursor pagination, Phase-1)", () => {
	it("pages through more than one repository page without truncation, preserving order", async () => {
		// Simulate a post-summary window of 10_000 events across 500-row pages.
		const total = 10_000;
		const pageCalls: number[] = [];
		let cursor = 0;
		const page = async (after: number, limit: number) => {
			pageCalls.push(after);
			return seqRows(after, Math.min(limit, total - after));
		};
		const all = await replayAllAfter(page, 0);
		expect(all.length).toBe(total);
		// strict ascending, gapless sequence order
		expect(all[0].sequence).toBe(1);
		expect(all[all.length - 1].sequence).toBe(total);
		for (let i = 1; i < all.length; i += 1) {
			expect(all[i].sequence).toBe(all[i - 1].sequence + 1);
		}
		// cursors advanced correctly and we did not just call once
		expect(pageCalls.length).toBeGreaterThan(1);
	});

	it("stops when a short (final) page is returned", async () => {
		const calls: number[] = [];
		const page = async (after: number, limit: number) => {
			calls.push(after);
			if (after === 0) return seqRows(0, 500);
			return seqRows(500, 10); // short final page
		};
		const all = await replayAllAfter(page, 0);
		expect(all.length).toBe(510);
		expect(calls).toEqual([0, 500]);
	});

	it("honours a non-zero starting cursor (afterSequence)", async () => {
		const page = async (after: number, limit: number) =>
			after === 1234 ? seqRows(1234, 60) : [];
		const all = await replayAllAfter(page, 1234);
		expect(all.length).toBe(60);
		expect(all[0].sequence).toBe(1235);
	});

	it("REPLAY_PAGE_SIZE matches the repository page ceiling the restore relies on", () => {
		expect(REPLAY_PAGE_SIZE).toBe(500);
	});
});
/**
 * MVP-05 tests.
 *
 *  - `appendUnique` dedup across cursor pages.
 */

import { describe, expect, it } from "vitest";
import { appendUnique } from "../../src/admin/pages/cursor-merge.ts";

describe("appendUnique (MVP-05 cursor pagination)", () => {
	it("appends a fresh page with no overlap", () => {
		const existing = [
			{ id: "a", revision: 1 },
			{ id: "b", revision: 1 },
		];
		const next = [{ id: "c", revision: 1 }];
		expect(appendUnique(existing, next).map((x) => x.id)).toEqual(["a", "b", "c"]);
	});

	it("dedups an overlapping boundary row", () => {
		const existing = [{ id: "a", revision: 1 }];
		const next = [
			{ id: "a", revision: 1 }, // boundary duplicate
			{ id: "b", revision: 2 },
		];
		expect(appendUnique(existing, next).map((x) => x.id)).toEqual(["a", "b"]);
	});

	it("keeps the full list when last page is fully overlapping", () => {
		const existing = [{ id: "a" }, { id: "b" }];
		expect(appendUnique(existing, [{ id: "a" }]).map((x) => x.id)).toEqual(["a", "b"]);
	});

	it("returns a new array and does not mutate inputs", () => {
		const existing = [{ id: "a" }];
		const next = [{ id: "b" }];
		const out = appendUnique(existing, next);
		expect(out).not.toBe(existing);
		expect(existing).toHaveLength(1);
		expect(next).toHaveLength(1);
	});
});

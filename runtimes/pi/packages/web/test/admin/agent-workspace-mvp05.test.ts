/**
 * MVP-05 tests.
 *
 *  - `appendUnique` dedup across cursor pages.
 *  - `createDebugSessionStore` per-agent mapping underpinning the Agent
 *    workspace "调试记录" tab (reads the same source as the admin chat page,
 *    so any id saved there shows up here).
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { createDebugSessionStore } from "../../src/admin/conversation/debug-session-store.ts";
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

describe("debug-session-store (MVP-05 调试记录 backing)", () => {
	const agentA = "agent_aaaa0000-0000-0000-0000-000000000000" as AgentPublicId;
	const agentB = "agent_bbbb0000-0000-0000-0000-000000000000" as AgentPublicId;

	it("persists a per-agent session id that the workspace can read back", () => {
		const store = createDebugSessionStore();
		store.set(agentA, "session_debug_A");
		expect(store.get(agentA)).toBe("session_debug_A");
	});

	it("keeps agent mappings isolated", () => {
		const store = createDebugSessionStore();
		store.set(agentA, "session_debug_A");
		expect(store.get(agentB)).toBeNull();
	});

	it("clear() removes only that agent", () => {
		const store = createDebugSessionStore();
		store.set(agentA, "session_debug_A");
		store.set(agentB, "session_debug_B");
		store.clear(agentA);
		expect(store.get(agentA)).toBeNull();
		expect(store.get(agentB)).toBe("session_debug_B");
	});

	it("all() returns a copy of the mapping", () => {
		const store = createDebugSessionStore();
		store.set(agentA, "session_debug_A");
		const snapshot = store.all();
		snapshot[agentA] = "tampered";
		expect(store.get(agentA)).toBe("session_debug_A");
	});
});

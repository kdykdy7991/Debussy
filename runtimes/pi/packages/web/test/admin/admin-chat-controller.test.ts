/**
 * AdminChatController + safe-render-event tests (MVP-04).
 *
 * Covers the contract the chat UI relies on:
 *
 *  - Selecting an agent creates an isolated controller; switching to a
 *    different agent and back returns the SAME controller (or a fresh one
 *    with the previously persisted debug session id).
 *  - The DebugSession store is shared: an id set on agent A is visible
 *    after switching to agent A again.
 *  - Connection state transitions are observable to subscribers.
 *  - Sending a message marks the controller as sending, then clears it.
 *  - `eventToTranscriptEntry` and `eventsToTranscript` never throw on
 *    unknown / malformed events; they render a "未知事件" placeholder.
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { AdminChatController } from "../../src/admin/chat/chat-controller.ts";
import { eventsToTranscript, eventToTranscriptEntry, isKnownEvent } from "../../src/admin/chat/safe-render-event.ts";

const agentA = "agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as AgentPublicId;
const agentB = "agent_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as AgentPublicId;

describe("AdminChatController (MVP-04)", () => {
	it("selectAgent returns the same controller for the same id", () => {
		const ctrl = new AdminChatController();
		const first = ctrl.selectAgent(agentA, 1);
		const second = ctrl.selectAgent(agentA);
		expect(second).toBe(first);
	});

	it("selectAgent switches to a fresh controller for a different agent", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA);
		const b = ctrl.selectAgent(agentB);
		expect(a).not.toBe(b);
		expect(ctrl.current).toBe(b);
	});

	it("remembers DebugSession ids across agent switches", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA);
		a.rememberSession("session_a_1");
		ctrl.selectAgent(agentB);
		const aAgain = ctrl.selectAgent(agentA);
		expect(aAgain.getSnapshot().debugSessionId).toBe("session_a_1");
	});

	it("clearSession wipes the store entry and the snapshot", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA);
		a.rememberSession("session_a_1");
		a.clearSession();
		expect(a.getSnapshot().debugSessionId).toBeNull();
		expect(ctrl.debugStore.get(agentA)).toBeNull();
	});

	it("notifies subscribers on connection state changes", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA);
		let calls = 0;
		const off = a.subscribe(() => {
			calls += 1;
		});
		a.setConnection({ kind: "connecting" });
		a.setConnection({ kind: "connected" });
		expect(calls).toBe(2);
		expect(a.getSnapshot().connection).toEqual({ kind: "connected" });
		off();
		// After unsubscribe, state still updates but listeners do not fire.
		a.setConnection({ kind: "error", message: "x", retryable: false });
		expect(calls).toBe(2);
		expect(a.getSnapshot().connection.kind).toBe("error");
	});

	it("pins a revision number when switching agents", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA, 3);
		expect(a.getSnapshot().pinnedRevision).toBe(3);
		a.setPinnedRevision("draft");
		expect(a.getSnapshot().pinnedRevision).toBe("draft");
	});

	it("does not crash when appending transcript entries", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA);
		a.appendTranscript({
			id: "1",
			role: "user",
			text: "hello",
			timestamp: 0,
		});
		expect(a.getSnapshot().transcript).toHaveLength(1);
	});

	it("markSending toggles the sending flag", () => {
		const ctrl = new AdminChatController();
		const a = ctrl.selectAgent(agentA);
		expect(a.getSnapshot().sending).toBe(false);
		a.markSending(true);
		expect(a.getSnapshot().sending).toBe(true);
		a.markSending(false);
		expect(a.getSnapshot().sending).toBe(false);
	});
});

describe("safe-render-event (MVP-04)", () => {
	it("renders a known assistant message", () => {
		const entry = eventToTranscriptEntry({ type: "assistant.message", text: "hi" });
		expect(entry.role).toBe("assistant");
		expect(entry.text).toBe("hi");
	});

	it("renders a tool result with meta", () => {
		const entry = eventToTranscriptEntry({ type: "tool.result", name: "search", payload: { q: "x" } });
		expect(entry.role).toBe("tool");
		expect(entry.text.startsWith("工具：")).toBe(true);
		expect(entry.meta).toBeDefined();
	});

	it("falls back to a system placeholder for unknown event types", () => {
		const entry = eventToTranscriptEntry({ type: "future_event_type" });
		expect(entry.role).toBe("system");
		expect(entry.text).toContain("未知事件");
	});

	it("never throws on null / undefined / non-objects", () => {
		expect(() => eventToTranscriptEntry(null)).not.toThrow();
		expect(() => eventToTranscriptEntry(undefined)).not.toThrow();
		expect(() => eventToTranscriptEntry("string")).not.toThrow();
		expect(() => eventToTranscriptEntry(42)).not.toThrow();
		expect(() => eventToTranscriptEntry({})).not.toThrow();
	});

	it("eventsToTranscript wraps mixed shapes without throwing", () => {
		const events: unknown[] = [
			{ type: "user.message", text: "hi" },
			null,
			{ type: "weird_event", payload: { foo: 1 } },
			"oops",
		];
		const list = eventsToTranscript(events);
		expect(list).toHaveLength(4);
		expect(list[0]?.role).toBe("user");
		expect(list[1]?.text).toContain("非对象");
		expect(list[2]?.text).toContain("未知事件");
	});

	it("isKnownEvent accepts events with a string type", () => {
		expect(isKnownEvent({ type: "x" })).toBe(true);
		expect(isKnownEvent(null)).toBe(false);
		expect(isKnownEvent({})).toBe(false);
	});
});

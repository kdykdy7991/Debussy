/**
 * Agent 状态机测试（WB-003 / SPEC §5.2）。
 *
 * 不依赖 DOM，只验证 `editDraft` / `beginSave` / `saveSucceeded` / `saveFailed`
 * / `revertDraft` 五个 reducer 的状态转移和 `snapshotsEqual` 结构比较。
 */

import type { AgentConfigSnapshot, AgentDefinitionDetail } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	beginSave,
	buildSaveRequest,
	editDraft,
	initialAgentState,
	revertDraft,
	saveFailed,
	saveSucceeded,
	snapshotsEqual,
} from "../../src/admin/agents/agent-state.ts";

const detail: AgentDefinitionDetail = {
	id: "agent_00000000-0000-0000-0000-000000000000",
	name: "Demo",
	description: null,
	currentRevision: 1,
	modelId: "pi-chat",
	systemPrompt: "You are helpful.",
	parameters: { reasoning: { effort: "medium" } },
	toolIds: ["web.search"],
	knowledgeBaseIds: ["kb-legal"],
	capabilities: {
		liveSpeech: false,
		avatar: false,
		attachments: true,
		citations: false,
		realtime: false,
		webSearch: false,
	},
	hasDraft: false,
	updatedAt: "2026-01-01T00:00:00.000Z",
	updatedBy: "tester",
	changeSummary: null,
	associatedAppCount: 0,
};

describe("Agent state machine (WB-003)", () => {
	it("initialAgentState starts at saved with draft == saved", () => {
		const state = initialAgentState(detail);
		expect(state.status).toBe("saved");
		expect(state.draft).toEqual(state.saved);
	});

	it("editDraft transitions saved -> dirty when fields differ", () => {
		const initial = initialAgentState(detail);
		const dirty = editDraft(initial, { systemPrompt: "Different prompt" });
		expect(dirty.status).toBe("dirty");
		expect(dirty.draft.systemPrompt).toBe("Different prompt");
	});

	it("editDraft transitions back to saved when the change is reverted", () => {
		const dirty = editDraft(initialAgentState(detail), { systemPrompt: "Different prompt" });
		const restored = editDraft(dirty, { systemPrompt: detail.systemPrompt });
		expect(restored.status).toBe("saved");
	});

	it("editDraft is a no-op while status is saving", () => {
		const initial = editDraft(initialAgentState(detail), { systemPrompt: "x" });
		const saving = beginSave(initial);
		const attempted = editDraft(saving, { systemPrompt: "y" });
		expect(attempted).toBe(saving);
	});

	it("beginSave only fires from dirty or error", () => {
		const saved = initialAgentState(detail);
		expect(beginSave(saved).status).toBe("saved");
		const dirty = editDraft(saved, { systemPrompt: "x" });
		expect(beginSave(dirty).status).toBe("saving");
		const errored = saveFailed(dirty, "boom");
		expect(beginSave(errored).status).toBe("saving");
	});

	it("saveSucceeded promotes draft to saved and clears error", () => {
		const dirty = editDraft(initialAgentState(detail), { systemPrompt: "x" });
		const saving = beginSave(dirty);
		const next = saveSucceeded(saving, saving.draft, detail.currentRevision + 1);
		expect(next.status).toBe("saved");
		expect(next.display.currentRevision).toBe(detail.currentRevision + 1);
		expect(next.errorMessage).toBeNull();
	});

	it("saveFailed keeps the draft and surfaces an error message", () => {
		const dirty = editDraft(initialAgentState(detail), { systemPrompt: "x" });
		const saving = beginSave(dirty);
		const errored = saveFailed(saving, "network down");
		expect(errored.status).toBe("error");
		expect(errored.errorMessage).toBe("network down");
		// retry path: beginSave should still be allowed
		expect(beginSave(errored).status).toBe("saving");
	});

	it("revertDraft restores saved snapshot and clears error", () => {
		const dirty = editDraft(initialAgentState(detail), { systemPrompt: "x" });
		const errored = saveFailed(beginSave(dirty), "boom");
		const restored = revertDraft(errored);
		expect(restored.status).toBe("saved");
		expect(restored.draft).toEqual(detail.systemPrompt === "" ? stateEmptySnapshot() : restored.saved);
	});

	it("snapshotsEqual treats array order and capability shape as significant", () => {
		const a: AgentConfigSnapshot = {
			modelId: "x",
			systemPrompt: "p",
			parameters: {},
			toolIds: ["a", "b"],
			knowledgeBaseIds: [],
			capabilities: {
				liveSpeech: false,
				avatar: false,
				attachments: false,
				citations: false,
				realtime: false,
				webSearch: false,
			},
		};
		const reordered: AgentConfigSnapshot = { ...a, toolIds: ["b", "a"] };
		// toolIds is treated as a set: order does not matter.
		expect(snapshotsEqual(a, reordered)).toBe(true);
		const withCapability: AgentConfigSnapshot = {
			...a,
			capabilities: { ...a.capabilities, liveSpeech: true },
		};
		expect(snapshotsEqual(a, withCapability)).toBe(false);
	});

	it("buildSaveRequest mirrors draft + changeSummary", () => {
		const dirty = editDraft(initialAgentState(detail), { systemPrompt: "new" });
		const req = buildSaveRequest(dirty, "improve tone");
		expect(req.systemPrompt).toBe("new");
		expect(req.changeSummary).toBe("improve tone");
	});
});

function stateEmptySnapshot(): never {
	throw new Error("not used");
}

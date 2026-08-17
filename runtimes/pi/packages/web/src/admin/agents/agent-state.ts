/**
 * Agent 草稿状态机（WB-003 / SPEC §5.2）。
 *
 * 严格按规格的状态转换：
 *
 *     saved revision ──edit──▶ dirty draft ──save──▶ saving ──┬─ok──▶ saved
 *                                                              └─err─▶ error (保留草稿)
 *
 * - `dirty` 表示草稿与 latest revision 的 configSnapshot 不同（结构比较）
 * - `saving` 期间不接收新 edit
 * - `error` 保留草稿内容，可重试 `save`
 * - `saved` 后草稿清空，`currentRevision` 更新
 */
import type { AgentConfigSnapshot, AgentDefinitionDetail, AgentPublicId } from "@earendil-works/pi-protocol";

export type AgentStateStatus = "saved" | "dirty" | "saving" | "error";

export interface AgentState {
	readonly status: AgentStateStatus;
	readonly agentId: AgentPublicId;
	/** Latest saved revision. Always populated; cleared drafts are derived from this. */
	readonly saved: AgentConfigSnapshot;
	/** Mutable draft, only meaningful when status is `dirty` | `saving` | `error`. */
	readonly draft: AgentConfigSnapshot;
	/** Display fields sourced from the latest detail response. */
	readonly display: {
		readonly name: string;
		readonly currentRevision: number;
		readonly updatedAt: string;
	};
	readonly errorMessage: string | null;
}

export function snapshotsEqual(a: AgentConfigSnapshot, b: AgentConfigSnapshot): boolean {
	return (
		(a.modelId ?? "") === (b.modelId ?? "") &&
		a.systemPrompt === b.systemPrompt &&
		JSON.stringify(a.parameters) === JSON.stringify(b.parameters) &&
		arrEqual(a.toolIds, b.toolIds) &&
		arrEqual(a.knowledgeBaseIds, b.knowledgeBaseIds) &&
		JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities)
	);
}

function arrEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sb = new Set(b);
	return a.every((id) => sb.has(id));
}

/** Build the initial state from a freshly-loaded detail. */
export function initialAgentState(detail: AgentDefinitionDetail): AgentState {
	const snapshot = snapshotFromDetail(detail);
	return {
		status: "saved",
		agentId: detail.id,
		saved: snapshot,
		draft: snapshot,
		display: {
			name: detail.name,
			currentRevision: detail.currentRevision,
			updatedAt: detail.updatedAt,
		},
		errorMessage: null,
	};
}

function snapshotFromDetail(detail: AgentDefinitionDetail): AgentConfigSnapshot {
	return {
		modelId: detail.modelId,
		systemPrompt: detail.systemPrompt,
		parameters: detail.parameters,
		toolIds: detail.toolIds,
		knowledgeBaseIds: detail.knowledgeBaseIds,
		capabilities: detail.capabilities,
	};
}

/** Edit the draft. Triggers `saved` -> `dirty` if the draft now diverges. */
export function editDraft(state: AgentState, patch: Partial<AgentConfigSnapshot>): AgentState {
	if (state.status === "saving") return state;
	const nextDraft: AgentConfigSnapshot = { ...state.draft, ...patch };
	const nextStatus: AgentStateStatus = snapshotsEqual(nextDraft, state.saved) ? "saved" : "dirty";
	return { ...state, draft: nextDraft, status: nextStatus, errorMessage: null };
}

/** Revert the draft to the latest saved snapshot. */
export function revertDraft(state: AgentState): AgentState {
	return { ...state, draft: state.saved, status: "saved", errorMessage: null };
}

/** Begin a save. Only valid from `dirty` or `error`. */
export function beginSave(state: AgentState): AgentState {
	if (state.status !== "dirty" && state.status !== "error") return state;
	return { ...state, status: "saving", errorMessage: null };
}

/** Save succeeded. Promote draft to saved. */
export function saveSucceeded(state: AgentState, saved: AgentConfigSnapshot, nextRevision: number): AgentState {
	return {
		...state,
		status: "saved",
		saved,
		draft: saved,
		display: { ...state.display, currentRevision: nextRevision },
		errorMessage: null,
	};
}

/** Save failed. Keep the draft, transition to `error`. */
export function saveFailed(state: AgentState, message: string): AgentState {
	return { ...state, status: "error", errorMessage: message };
}

/** Build the request body for a save call. */
export function buildSaveRequest(
	state: AgentState,
	changeSummary: string,
): {
	readonly modelId: string | null;
	readonly systemPrompt: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly toolIds: readonly string[];
	readonly knowledgeBaseIds: readonly string[];
	readonly capabilities: AgentConfigSnapshot["capabilities"];
	readonly changeSummary: string;
} {
	return {
		modelId: state.draft.modelId,
		systemPrompt: state.draft.systemPrompt,
		parameters: state.draft.parameters,
		toolIds: state.draft.toolIds,
		knowledgeBaseIds: state.draft.knowledgeBaseIds,
		capabilities: state.draft.capabilities,
		changeSummary,
	};
}

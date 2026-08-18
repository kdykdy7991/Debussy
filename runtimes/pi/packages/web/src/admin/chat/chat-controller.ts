/**
 * Admin debug chat controller (MVP-04).
 *
 * Owns the per-agent debug-chat state for the administrator workbench:
 *
 *  - The selected Agent (from `AgentPublicId`).
 *  - A per-agent DebugSession mapping backed by `debug-session-store` (the
 *    Web side does not own real session history; that lives on the server).
 *  - A small transcript projection (user / assistant / system placeholders)
 *    built from the {@link SessionController} snapshot when available.
 *
 * The real Pi WebSocket round-trip is intentionally delegated to the
 * shared `connection-controller` + `session-controller` pair so we never
 * introduce a second message protocol (MVP-04 §1). When the WebSocket
 * backend exposes an admin debug path the wire format is reused as-is.
 *
 * The controller is pure UI state — it never writes to Storage / URL /
 * console, and never persists the admin token.
 */

import type { AgentPublicId, AgentRevisionSummary } from "@earendil-works/pi-protocol";
import { createDebugSessionStore, type DebugSessionStore } from "../conversation/debug-session-store.ts";
import type { ChatTranscriptEntry } from "./safe-render-event.ts";

export type ChatConnectionState =
	| { readonly kind: "idle" }
	| { readonly kind: "connecting" }
	| { readonly kind: "connected" }
	| { readonly kind: "reconnecting"; readonly attempt: number }
	| { readonly kind: "error"; readonly message: string; readonly retryable: boolean };

export interface AgentDebugState {
	readonly agentId: AgentPublicId;
	readonly debugSessionId: string | null;
	readonly connection: ChatConnectionState;
	readonly transcript: readonly ChatTranscriptEntry[];
	readonly sending: boolean;
	readonly error: string | null;
	/**
	 * Either the pinned `revisionNumber` of the Agent revision this debug
	 * session was started against, or `"draft"` for an unsaved draft test.
	 */
	readonly pinnedRevision: number | "draft";
}

export interface AgentChatObserver {
	readonly getSnapshot: () => AgentDebugState;
	subscribe(listener: () => void): () => void;
}

/**
 * Per-agent debug controller. A new instance is created whenever the workbench
 * switches to an Agent that has never been opened (or whose previous handle
 * was released). The previous handle is held in a `WeakRef` so the new
 * controller can keep its session id while the previous one is still tearing
 * down.
 */
export class AgentChatController implements AgentChatObserver {
	readonly #agentId: AgentPublicId;
	readonly #debugStore: DebugSessionStore;
	readonly #listeners = new Set<() => void>();
	#state: AgentDebugState;

	constructor(input: {
		readonly agentId: AgentPublicId;
		readonly debugStore?: DebugSessionStore;
		readonly pinnedRevision?: number | "draft";
	}) {
		this.#agentId = input.agentId;
		this.#debugStore = input.debugStore ?? createDebugSessionStore();
		this.#state = {
			agentId: input.agentId,
			debugSessionId: this.#debugStore.get(input.agentId),
			connection: { kind: "idle" },
			transcript: [],
			sending: false,
			error: null,
			pinnedRevision: input.pinnedRevision ?? "draft",
		};
	}

	get agentId(): AgentPublicId {
		return this.#agentId;
	}

	get debugStore(): DebugSessionStore {
		return this.#debugStore;
	}

	getSnapshot = (): AgentDebugState => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	setPinnedRevision(revision: number | "draft"): void {
		this.#update({ pinnedRevision: revision });
	}

	setConnection(connection: ChatConnectionState): void {
		this.#update({ connection });
	}

	appendTranscript(item: ChatTranscriptEntry): void {
		this.#update({ transcript: [...this.#state.transcript, item] });
	}

	replaceTranscript(transcript: readonly ChatTranscriptEntry[]): void {
		this.#update({ transcript });
	}

	markSending(sending: boolean): void {
		this.#update({ sending });
	}

	markError(error: string | null): void {
		this.#update({ error });
	}

	rememberSession(sessionId: string): void {
		this.#debugStore.set(this.#agentId, sessionId);
		this.#update({ debugSessionId: sessionId });
	}

	clearSession(): void {
		this.#debugStore.clear(this.#agentId);
		this.#update({ debugSessionId: null, transcript: [] });
	}

	#update(patch: Partial<AgentDebugState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) listener();
	}
}

/**
 * Top-level admin debug chat controller. Keeps one `AgentChatController`
 * per agent id so switching agents is O(1) and the previous handle keeps
 * its session id in storage.
 */
export class AdminChatController {
	readonly #cache = new Map<AgentPublicId, AgentChatController>();
	readonly #globalStore: DebugSessionStore;
	#current: AgentChatController | null = null;

	constructor(debugStore?: DebugSessionStore) {
		this.#globalStore = debugStore ?? createDebugSessionStore();
	}

	/** Switch to (or initialise) the controller for an agent. */
	selectAgent(agentId: AgentPublicId, initialRevision?: AgentRevisionSummary | number | "draft"): AgentChatController {
		const existing = this.#cache.get(agentId);
		if (existing !== undefined) {
			this.#current = existing;
			if (initialRevision !== undefined) {
				existing.setPinnedRevision(toPinned(initialRevision));
			}
			return existing;
		}
		const controller = new AgentChatController({
			agentId,
			debugStore: this.#globalStore,
			pinnedRevision: initialRevision === undefined ? "draft" : toPinned(initialRevision),
		});
		this.#cache.set(agentId, controller);
		this.#current = controller;
		return controller;
	}

	get current(): AgentChatController | null {
		return this.#current;
	}

	all(): readonly AgentChatController[] {
		return [...this.#cache.values()];
	}

	get debugStore(): DebugSessionStore {
		return this.#globalStore;
	}

	dispose(): void {
		this.#cache.clear();
		this.#current = null;
	}
}

function toPinned(value: AgentRevisionSummary | number | "draft"): number | "draft" {
	if (value === "draft") return "draft";
	if (typeof value === "number") return value;
	return value.revision;
}

/**
 * Debug Conversation Realtime facade (Phase 2, Option A).
 *
 * A `DebugConversationRuntimeAdapter` implements the server `PiSessionRuntime`
 * so the existing `/api/pi/v1/ws` + `LiveSessionManager` + `SessionController` +
 * `ConversationWorkspace` stack can stream a persistent Debug Conversation with
 * zero client/UI changes. The Adapter is a stable identity facade:
 *
 *   Adapter (id = public debugConversationId)  --stable--
 *       └─ DebugConversationService
 *              └─ DebugRuntimeCache
 *                     └─ inner per-revision ConversationRuntime (may rebuild)
 *
 * The conversation identity stays the Adapter; only the inner runtime rebuilds
 * on a revision/spec change. Streaming is single-execution: one inner
 * `runtime.prompt()` drives both the realtime progress (via the Adapter to
 * LiveSessionManager) and the persisted `debug_conversation_events`.
 */
import type {
	Attachment,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { PiServerError } from "../../errors.ts";
import type { PiSessionBackend, PiSessionRuntime, PiSessionRuntimeEvent, PromptInput } from "../../types.ts";
import { type DebugConversationId, fromPublicId, newTurnId, toPublicId } from "../domain/ids.ts";
import type { DebugConversationService } from "./service.ts";
import type { DebugConversationEventRecord, DebugConversationRecord } from "./types.ts";

const FALLBACK_MODEL: ModelRef = { provider: "pi", id: "pi:default" };
const FALLBACK_THINKING: ThinkingLevel = "off";

function modelRef(id: string | undefined): ModelRef {
	return id ? ({ provider: "pi", id } as ModelRef) : FALLBACK_MODEL;
}

/**
 * Rebuild the UI transcript snapshot from the persisted Debug event stream.
 * User + assistant text (Phase 1) and Tool lifecycle (Phase 2A) are rebuilt
 * here as UI items. Reasoning/citation replay is a later phase.
 *
 * This is deliberately NOT `restoreContext` — the latter is the LLM context
 * feed (text only, never tools), this is the authoritative UI transcript for
 * first attach / reconnect / cache loss.
 *
 * Tool rebuild rules:
 *   - `tool/call`  -> push `role:"tool"` (status running)  for the toolCallId
 *   - `tool/result` -> replace the running item (status complete)
 *   - `tool/error`  -> replace the running item (status error)
 * The persisted payload deliberately contains no `input` / `content` — only
 * metadata (toolCallId / toolName / status / timestamps / error). The
 * resulting UI item therefore has empty `content` and `input:null`; the
 * `AgentTrace` rail renders `toolName + status`, which is what we want for a
 * refresh-resumed transcript.
 */
function buildDebugSnapshot(
	conversation: DebugConversationRecord,
	events: readonly DebugConversationEventRecord[],
): SessionSnapshot {
	const publicId = toPublicId("DebugConversationId", conversation.debugConversationId);
	const transcript: TranscriptItem[] = [];
	let lastModelId: string | undefined;
	// toolCallId -> index in `transcript`, so the terminal event can replace
	// the running item in place.
	const toolIndex = new Map<string, number>();
	// attachment_id -> Attachment. attachment_snapshot inserts/updates;
	// attachment_removed drops the entry. This rebuilds the same set the
	// legacy ephemeral debug session surfaces in `activeSession.attachments`
	// after server restart / reconnect, without ever touching the file bytes.
	const attachmentsById = new Map<string, Attachment>();
	for (const event of events) {
		const payload = (event.payload ?? {}) as {
			text?: string;
			thinking?: string;
			model?: string;
			toolCallId?: string;
			toolName?: string;
			status?: string;
			startedAt?: number;
			finishedAt?: number;
			error?: string;
		};
		if (event.eventType === "turn/start" && typeof payload.model === "string" && payload.model !== "") {
			lastModelId = payload.model;
		}
		// Attachment events are not tied to a Turn and must be handled BEFORE
		// the turnId gate that filters out turnId-less events (user/assistant/
		// tool events are all skipped when turnId is null).
		if (event.eventType === "attachment_snapshot") {
			const attachment = payload as unknown as Attachment;
			if (attachment.id !== undefined) attachmentsById.set(attachment.id, attachment);
			continue;
		}
		if (event.eventType === "attachment_removed") {
			const removed = payload as { readonly attachmentId?: string };
			if (removed.attachmentId !== undefined) attachmentsById.delete(removed.attachmentId);
			continue;
		}
		const turnId = event.turnId;
		if (turnId === null || turnId === undefined) continue;
		const eventTime = event.createdAt.getTime();
		if (event.eventType === "user/message") {
			transcript.push({
				id: `user:${turnId}`,
				role: "user",
				content: [{ type: "text", text: payload.text ?? "" }],
				timestamp: eventTime,
			} as TranscriptItem);
		} else if (event.eventType === "assistant/message") {
			transcript.push({
				id: `ast:${turnId}`,
				role: "assistant",
				model: modelRef(lastModelId),
				status: payload.status === "interrupted" ? "aborted" : "complete",
				stopReason: payload.status === "interrupted" ? "aborted" : "stop",
				content: [
					...(typeof payload.thinking === "string" && payload.thinking !== ""
						? [{ type: "thinking" as const, thinking: payload.thinking }]
						: []),
					...(payload.text !== undefined && payload.text !== ""
						? [{ type: "text" as const, text: payload.text }]
						: []),
				],
				timestamp: eventTime,
			} as TranscriptItem);
		} else if (event.eventType === "tool/call") {
			const toolCallId = payload.toolCallId ?? "";
			if (toolCallId === "") continue;
			const startedAt = typeof payload.startedAt === "number" ? payload.startedAt : eventTime;
			const item: TranscriptItem = {
				id: `tool-${toolCallId}`,
				role: "tool",
				toolCallId,
				toolName: payload.toolName ?? "",
				input: null,
				content: [],
				status: "running",
				isError: false,
				timestamp: startedAt,
			};
			toolIndex.set(toolCallId, transcript.length);
			transcript.push(item);
		} else if (event.eventType === "tool/result") {
			const toolCallId = payload.toolCallId ?? "";
			const idx = toolIndex.get(toolCallId);
			if (idx === undefined) continue;
			const finishedAt = typeof payload.finishedAt === "number" ? payload.finishedAt : eventTime;
			transcript[idx] = {
				id: `tool-${toolCallId}`,
				role: "tool",
				toolCallId,
				toolName: payload.toolName ?? "",
				input: null,
				content: [],
				status: "complete",
				isError: false,
				timestamp: finishedAt,
			};
		} else if (event.eventType === "tool/error") {
			const toolCallId = payload.toolCallId ?? "";
			const idx = toolIndex.get(toolCallId);
			if (idx === undefined) continue;
			const finishedAt = typeof payload.finishedAt === "number" ? payload.finishedAt : eventTime;
			transcript[idx] = {
				id: `tool-${toolCallId}`,
				role: "tool",
				toolCallId,
				toolName: payload.toolName ?? "",
				input: null,
				content: [],
				status: "error",
				isError: true,
				timestamp: finishedAt,
			};
		}
	}
	const attachments = [...attachmentsById.values()];
	return {
		id: publicId,
		name: "Agent Debug Conversation",
		cwd: "/debug",
		createdAt: conversation.createdAt.getTime(),
		updatedAt: conversation.createdAt.getTime(),
		phase: "idle",
		model: modelRef(lastModelId),
		thinkingLevel: FALLBACK_THINKING,
		attached: false,
		locked: false,
		lastSequence: conversation.lastEventSequence,
		revision: 0,
		transcript,
		...(attachments.length > 0 ? { attachments } : {}),
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

/** Turn metadata surface for a Debug realtime Adapter. */
export interface DebugRealtimeTurnInfo {
	readonly model?: ModelRef;
	readonly terminal: "end" | "failed" | "interrupted";
	readonly outputText: string;
	/** Final thinking content (non-redacted) for this Turn, if any. */
	readonly thinkingText?: string;
	readonly error?: string;
}

/**
 * Stable `PiSessionRuntime` facade over a Debug Conversation. The identity is
 * the public `debugConversationId`; the inner runtime may be rebuilt at will.
 */
export class DebugConversationRuntimeAdapter implements PiSessionRuntime {
	readonly id: string;
	private readonly conversationId: DebugConversationId;
	private readonly service: DebugConversationService;
	private readonly onReleased: () => void;
	private snapshotValue: SessionSnapshot;
	private phase: SessionPhase = "idle";
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private revisionCounter = 0;
	private closed = false;
	private closedPromise: Promise<void> | undefined;

	constructor(
		service: DebugConversationService,
		conversationId: DebugConversationId,
		id: string,
		snapshot: SessionSnapshot,
		onReleased: () => void,
	) {
		this.service = service;
		this.conversationId = conversationId;
		this.id = id;
		this.snapshotValue = snapshot;
		this.onReleased = onReleased;
	}

	static async create(
		service: DebugConversationService,
		conversation: DebugConversationRecord,
		onReleased: () => void,
	): Promise<DebugConversationRuntimeAdapter> {
		const events = await service.listEvents(conversation.debugConversationId);
		const snapshot = buildDebugSnapshot(conversation, events);
		const publicId = toPublicId("DebugConversationId", conversation.debugConversationId);
		// Pin the conversation so the headless path never releases a runtime a
		// live realtime adapter owns. Released in `dispose()`.
		service.markRealtimeOwned(conversation.debugConversationId);
		return new DebugConversationRuntimeAdapter(
			service,
			conversation.debugConversationId,
			publicId,
			snapshot,
			onReleased,
		);
	}

	snapshot(): SessionSnapshot {
		return this.snapshotValue;
	}

	getPhase(): SessionPhase {
		return this.phase;
	}

	async prompt(input: PromptInput): Promise<void> {
		if (this.closed) throw new Error("Debug conversation realtime adapter is closed");
		// LiveSessionManager calls `beginTurn()` before the prompt op, which both
		// atomically reserves the single active Turn slot and returns the durable
		// Turn id; the same id flows into `live.currentTurnId`, every
		// `session_progress.turnId`, and the persisted `debug_conversation_events`.
		// Direct callers (tests) fall back to owning the id themselves.
		const turnId = this.service.peekReservedTurn(this.conversationId) ?? newTurnId();
		const baseSnapshot = this.snapshotValue;
		// Enter running state + surface the user message BEFORE execution so the
		// first phase-"turn" snapshot already includes the user's own text.
		this.phase = "turn";
		this.snapshotValue = {
			...baseSnapshot,
			phase: "turn",
			revision: this.revisionCounter + 1,
			transcript: [...baseSnapshot.transcript, this.userItem(turnId, input.text)],
		};
		this.revisionCounter += 1;
		this.emit({ type: "snapshot" });

		const result = await this.service.executeTurnRealtime(this.conversationId, input.text, {
			inputTurnId: turnId,
			...(input.attachmentIds && input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
			...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
			onCompactionChange: (compacting) => this.setTurnPhase(compacting ? "compaction" : "turn"),
			onProgress: (progress) => {
				this.snapshotValue = applyToolProgress(this.snapshotValue, progress);
				this.emit({ type: "progress", progress });
			},
		});

		this.phase = "idle";
		// A rejected Turn never started (busy/missing conversation/compile/
		// persist failure): restore the pre-turn snapshot and surface it as an RPC
		// error so the client reverts its optimistic message instead of leaving a
		// stuck "turn" phase or a misleading error item.
		if (result.rejected === true) {
			this.snapshotValue = baseSnapshot;
			this.emit({ type: "snapshot" });
			throw new PiServerError("invalid_request", result.error ?? "Debug Turn was rejected");
		}
		this.revisionCounter += 1;
		this.snapshotValue = {
			...this.snapshotValue,
			phase: "idle",
			model: result.model ?? this.snapshotValue.model,
			revision: this.revisionCounter,
			transcript: [...this.snapshotValue.transcript, this.assistantItem(turnId, result)],
		};
		// Surface the Turn's full citations to the Debug UI through the Pi Session
		// protocol (`citation_snapshot`); LiveSessionManager forwards the event to
		// the connection verbatim (same vocabulary as internal retrieval turns).
		if (result.citations !== undefined && result.citations.length > 0) {
			this.emit({ type: "citation_snapshot", turnId, citations: [...result.citations] });
		}
		this.emit({ type: "snapshot" });
	}

	/** Reserve the single active Turn slot and return the durable Turn id. */
	beginTurn(): string {
		const turnId = this.service.beginTurn(this.conversationId);
		if (turnId === null) {
			throw new PiServerError("busy", "Debug conversation is already running another Turn");
		}
		return turnId;
	}

	async steer(): Promise<void> {
		// Steering is not supported for Debug conversations at this phase.
	}

	async abort(): Promise<void> {
		if (this.closed) return;
		await this.service.interruptActiveTurn(this.conversationId);
	}

	async setModel(): Promise<void> {
		// Model is resolved per-Turn from the Agent revision; not mutable here.
	}

	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {
		// MVP (WB-Agent 简化): Debug has no second runtime configuration — model,
		// thinking enabled and effort all come from the frozen Agent revision.
		// A per-session thinking override would make Debug diverge from what is
		// published, so it is deliberately unsupported.
		throw new PiServerError(
			"invalid_request",
			"Debug thinking level is fixed by the Agent revision; a session override is not supported",
		);
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		if (this.closedPromise !== undefined) return this.closedPromise;
		this.closed = true;
		this.closedPromise = (async () => {
			try {
				this.service.unmarkRealtimeOwned(this.conversationId);
				await this.service.releaseRuntime(this.conversationId);
			} finally {
				this.onReleased();
				this.listeners.clear();
			}
		})();
		return this.closedPromise;
	}

	private userItem(turnId: string, text: string): TranscriptItem {
		return {
			id: `user:${turnId}`,
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
	}

	private assistantItem(turnId: string, result: DebugRealtimeTurnInfo): TranscriptItem {
		const model = result.model ?? this.snapshotValue.model;
		if (result.terminal === "interrupted") {
			return {
				id: `ast:${turnId}`,
				role: "assistant",
				model,
				status: "aborted",
				stopReason: "aborted",
				// Cancel keeps whatever thinking/text was already streamed; the
				// Turn stays `interrupted` (never a fabricated complete).
				content: [
					...(result.thinkingText ? [{ type: "thinking" as const, thinking: result.thinkingText }] : []),
					...(result.outputText ? [{ type: "text" as const, text: result.outputText }] : []),
				],
				timestamp: Date.now(),
			} as TranscriptItem;
		}
		if (result.terminal === "failed") {
			return {
				id: `ast:${turnId}`,
				role: "assistant",
				model,
				status: "error",
				stopReason: "error",
				errorMessage: result.error,
				content: [],
				timestamp: Date.now(),
			} as TranscriptItem;
		}
		return {
			id: `ast:${turnId}`,
			role: "assistant",
			model,
			status: "complete",
			stopReason: "stop",
			content: [
				...(result.thinkingText ? [{ type: "thinking" as const, thinking: result.thinkingText }] : []),
				...(result.outputText ? [{ type: "text" as const, text: result.outputText }] : []),
			],
			timestamp: Date.now(),
		} as TranscriptItem;
	}

	private emit(event: PiSessionRuntimeEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private setTurnPhase(phase: "compaction" | "turn"): void {
		this.phase = phase;
		this.revisionCounter += 1;
		this.snapshotValue = { ...this.snapshotValue, phase, revision: this.revisionCounter };
		this.emit({ type: "snapshot" });
	}
}

/** Keep completed tool items in the Adapter's authoritative final snapshot. */
function applyToolProgress(snapshot: SessionSnapshot, progress: TranscriptProgress): SessionSnapshot {
	if (progress.type === "assistant_delta" || progress.item.role !== "tool") return snapshot;
	const index = snapshot.transcript.findIndex((item) => item.id === progress.item.id);
	if (index === -1) return { ...snapshot, transcript: [...snapshot.transcript, progress.item] };
	const transcript = [...snapshot.transcript];
	transcript[index] = progress.item;
	return { ...snapshot, transcript };
}

/**
 * Per-conversation Adapter registry + authorization gate for the debug WS path.
 * Conversations outside this tenant/owner fail to resolve (they cannot be
 * attached by guessing another tenant's id).
 */
export class DebugConversationRealtime {
	private readonly service: DebugConversationService;
	private readonly adapters = new Map<DebugConversationId, DebugConversationRuntimeAdapter>();

	constructor(service: DebugConversationService) {
		this.service = service;
	}

	/** Parse a `dconv_<uuid>` WS sessionId into a DebugConversationId, or null. */
	static parseConversationId(sessionId: string): DebugConversationId | null {
		return fromPublicId("DebugConversationId", sessionId);
	}

	async acquire(conversationId: DebugConversationId): Promise<DebugConversationRuntimeAdapter> {
		// Tenant + owner scoping lives inside the service: another tenant's (or
		// another owner's) conversation does not resolve, so a guessed id is
		// rejected here.
		const conversation = await this.service.getOwned(conversationId);
		if (conversation === undefined || conversation.status !== "active") {
			throw new Error(`Debug conversation is not available: ${conversationId}`);
		}
		const existing = this.adapters.get(conversationId);
		if (existing !== undefined) return existing;
		const adapter = await DebugConversationRuntimeAdapter.create(this.service, conversation, () => {
			if (this.adapters.get(conversationId) === adapter) this.adapters.delete(conversationId);
		});
		this.adapters.set(conversationId, adapter);
		return adapter;
	}
}

/**
 * Wrap a `PiSessionBackend` so `dconv_*` session ids resolve to the Debug
 * Conversation realtime Adapter while every other id is served by the inner
 * backend unchanged (the old ephemeral debug-session path stays intact).
 */
export function createDebugRealtimeBackend(
	inner: PiSessionBackend,
	realtime: DebugConversationRealtime,
): PiSessionBackend {
	return {
		listSessions: () => inner.listSessions(),
		listModels: () => inner.listModels(),
		createSession: (options) => inner.createSession(options),
		async openSession(sessionId: string): Promise<PiSessionRuntime> {
			const conversationId = DebugConversationRealtime.parseConversationId(sessionId);
			if (conversationId === null) return inner.openSession(sessionId);
			return realtime.acquire(conversationId);
		},
	};
}

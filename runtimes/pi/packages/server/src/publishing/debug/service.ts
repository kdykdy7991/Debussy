/**
 * DebugConversationService (Phase 1, admin workbench).
 *
 * Owning service for persistent, per-agent Debug Conversations. It is kept
 * independent from the Production `ConversationService`; it depends only on the
 * self-contained Debug repositories plus the shared compile/restore/runtime
 * helpers. An Agent revision change does NOT destroy the conversation and does
 * NOT drop its history: revision is resolved per Turn and the Runtime is rebuilt
 * (old session closed, new session created) only when the frozen spec hash — and
 * therefore the materialised system prompt / skills / model — actually changed.
 * History is restored from the Debug event stream via the shared
 * `restoreContext` (user + assistant text only; never tool/reasoning).
 */
import type { Citation, ModelRef, ToolTranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";
import { type CitationService, conversationRetrievalEnabled } from "../../citations/service.ts";
import { resolveEffectiveModelOptions } from "../../model-parameters.ts";
import {
	buildSummaryRestoredMessage,
	mergeRestored,
	type RestoredContext,
	restoreContext,
} from "../../runtime/context-restore.ts";
import type { ConversationRuntime, ConversationRuntimeEvent } from "../../runtime/conversation-runtime.ts";
import { runDebussyCompaction } from "../../runtime/debussy-compaction.ts";
import { createDebugConversationEventCompactionStore } from "../../runtime/debussy-compaction-stores.ts";
import {
	type BuiltinToolNameResolver,
	createPiRuntimeAdapter,
	type PiRuntimeAdapter,
	type RuntimeSessionOptions,
} from "../../runtime/pi-runtime-adapter.ts";
import { replayAllAfter } from "../../runtime/replay.ts";
import type { ScopeContext } from "../../runtime/scope-context.ts";
import { toToolProgressEvent } from "../../runtime/tool-event-payload.ts";
import { lastAssistantResult, lastAssistantResultAnyStatus } from "../../runtime/turn-executor.ts";
import type { PiSessionRuntime, ResolvedAttachmentInput, RetrievalInput } from "../../types.ts";
import type { AttachmentStore } from "../../uploads/store.ts";
import {
	type AgentDefinitionId,
	type DebugConversationId,
	fromPublicId,
	newDebugConversationId,
	newTurnId,
	type PrincipalId,
	type TenantId,
	type TurnId,
	toPublicId,
} from "../domain/ids.ts";
import type { McpRuntimeToolFactory } from "../mcp/runtime-tools.ts";
import type { ConversationEventRecord, PublishingRepositories } from "../repositories.ts";
import type { SkillMaterializer } from "../runtime/skill-materializer.ts";
import type { CapabilityCatalog } from "../runtime-spec/compiler.ts";
import type { RuntimeSpec } from "../runtime-spec/schema.ts";
import { compileDebugAgentRevision, type DebugCompileDeps } from "./compile.ts";
import type { DebugConversationEventRecord, DebugConversationRecord, DebugRepositories } from "./types.ts";

export type DebugSessionFactory = (options: RuntimeSessionOptions) => Promise<PiSessionRuntime>;

export interface DebugConversationServiceOptions {
	/** Full publishing repositories (read-only use for agent/skill/mcp resolution). */
	readonly repositories: PublishingRepositories;
	/** Self-contained Debug repositories. */
	readonly debug: DebugRepositories;
	/** Capability whitelist used to compile Debug RuntimeSpecs. */
	readonly catalog: CapabilityCatalog;
	/** Creates the underlying Pi session for a Debug conversation runtime. */
	readonly createSession: DebugSessionFactory;
	/** Materialises frozen Skill revisions to server-controlled runtime dirs. */
	readonly skillMaterializer?: SkillMaterializer;
	/**
	 * Builds MCP `customTools` from the frozen `RuntimeSpec` + scope. Reused
	 * from the Production `createMcpRuntimeToolFactory` so MCP credentials are
	 * still read execute-time (never frozen into spec or persisted). When
	 * omitted the Debug runtime is MCP-free.
	 */
	readonly createMcpTools?: McpRuntimeToolFactory;
	/** The control-plane tenant this service serves. */
	readonly tenantId: TenantId;
	/** The admin owner identity owning Debug conversations. */
	readonly ownerPrincipalId: PrincipalId;
	/**
	 * Shared process-level CitationService (same instance as the internal and
	 * embed flows). Debug Sources are keyed by `dconv_<uuid>`; the read path
	 * enumerates this conversation's ready Sources and reuses
	 * `retrieveForConversation` under the Production retrieval policy. Optional
	 * so unit harnesses that never attach/retrieve need no store; the production
	 * Debug service always wires the shared instance (web/start.ts).
	 */
	readonly citations?: CitationService;
	/**
	 * Shared AttachmentStore (same instance as internal/embed). Used by Phase
	 * 2F physical GC to drop a deleted conversation's uploaded records/files.
	 * Optional so unit harnesses need no store.
	 */
	readonly attachments?: AttachmentStore;
	/** Error sink for GC/background failures. Defaults to no-op. */
	readonly reportError?: (error: Error) => void;
	/**
	 * Optional injected shared PiRuntimeAdapter (the SAME one the Published path
	 * uses). When absent, the service builds one from the same
	 * `createPiRuntimeAdapter` factory — Debug and Published therefore always go
	 * through the exact same RuntimeSpec → Pi Agent construction.
	 */
	readonly openAdapter?: PiRuntimeAdapter;
	/** Builtin Tool id → name resolver (only used when building the fallback adapter). */
	readonly resolveToolName?: BuiltinToolNameResolver;
}

/** Cached Debug Runtime entry, keyed by `debugConversationId`. */
export interface DebugRuntimeEntry {
	readonly runtime: ConversationRuntime;
	readonly runtimeSpecHash: string;
	readonly resolvedRevision: number;
}

/** Phase 2E: History list row, surface shape for the admin History panel. */
export interface DebugConversationHistoryItem {
	readonly conversationId: string;
	readonly agentId: string | null;
	readonly status: DebugConversationRecord["status"];
	readonly lastActiveAt: string;
	readonly lastEventSequence: number;
	/**
	 * First `user/message` event's `text` payload, truncated to 60 chars on a
	 * single line. `null` when the conversation has no user message yet
	 * (e.g. an empty binding created by lazy-create that has not sent). This
	 * is raw first-message display, NOT auto-generated title synthesis —
	 * Phase 2E explicitly defers title generation.
	 */
	readonly firstUserMessagePreview: string | null;
}

const DEBUG_HISTORY_PREVIEW_MAX_CHARS = 60;
const DEBUG_HISTORY_DEFAULT_LIMIT = 50;
const DEBUG_HISTORY_HARD_LIMIT = 100;

function truncatePreview(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= DEBUG_HISTORY_PREVIEW_MAX_CHARS) return singleLine;
	return `${singleLine.slice(0, DEBUG_HISTORY_PREVIEW_MAX_CHARS - 1)}…`;
}

export type DebugTurnResult =
	| {
			readonly ok: true;
			readonly conversation: DebugConversationRecord;
			readonly turnId: TurnId;
			readonly outputText: string;
			readonly thinkingText?: string;
			readonly usage?: unknown;
	  }
	| { readonly ok: false; readonly error: string };

/** Realtime extension of a Debug Turn: exposes streaming + a single terminal state. */
export interface DebugRealtimeTurnResult {
	readonly ok: boolean;
	/** Mutually-exclusive terminal state persisted for this Turn. */
	readonly terminal: "end" | "failed" | "interrupted";
	readonly turnId: TurnId;
	readonly outputText: string;
	/** Final thinking content (non-redacted) for this Turn, if any. */
	readonly thinkingText?: string;
	readonly error?: string;
	/**
	 * True when the Turn never actually started (busy reject, missing/stopped
	 * conversation, compile failure, persist failure). The Adapter surfaces
	 * these as an RPC error rather than an error transcript item.
	 */
	readonly rejected?: boolean;
	/** Snapshot metadata for the frozen spec that ran this Turn (absent pre-execution failures). */
	readonly model?: ModelRef;
	/**
	 * Full citations retrieved for this Turn (when retrieval context was actually
	 * produced under the Production policy). The Adapter surfaces these to the
	 * Debug UI via the Pi Session `citation_snapshot` event; nothing else here.
	 */
	readonly citations?: readonly Citation[];
}

export interface DebugRealtimeTurnOptions {
	readonly inputTurnId?: TurnId;
	/** Forwarded streaming progress (single execution). Tool items are dropped for P0. */
	readonly onProgress?: (progress: TranscriptProgress) => void;
	/** Resolved attachments bound to this Debug conversation; injected into the inner runtime prompt. */
	readonly attachments?: readonly ResolvedAttachmentInput[];
	/** Stable attachment ids from the same Debug conversation; surfaced to the runtime as prompt-time input. */
	readonly attachmentIds?: readonly string[];
}

/** One actively-running Realtime Turn, so the abort command can reach the inner agent. */
interface ActiveDebugTurn {
	readonly turnId: TurnId;
	readonly done: Promise<void>;
	readonly interrupt: () => Promise<void>;
}

export class DebugConversationService {
	private readonly repositories: PublishingRepositories;
	private readonly debug: DebugRepositories;
	private readonly catalog: CapabilityCatalog;
	private readonly tenantId: TenantId;
	private readonly ownerPrincipalId: PrincipalId;
	private readonly citations: CitationService | undefined;
	private readonly attachments: AttachmentStore | undefined;
	private readonly reportError: (error: Error) => void;
	private readonly openAdapter: PiRuntimeAdapter;

	/** Runtime cache: `Map<debugConversationId, RuntimeEntry>` (Phase 1, in-memory). */
	private readonly runtimes = new Map<DebugConversationId, DebugRuntimeEntry>();
	/** Process-level single-writer guard: one Turn per Debug conversation. */
	private readonly running = new Set<DebugConversationId>();
	/** Turn id reserved by `beginTurn` for the imminent realtime prompt. */
	private readonly reservedTurn = new Map<DebugConversationId, TurnId>();
	/** Currently-running Realtime Turn per conversation, for the abort command. */
	private readonly activeTurns = new Map<DebugConversationId, ActiveDebugTurn>();
	/**
	 * Conversations currently pinned by a live realtime adapter (a WS is open).
	 * The headless `executeTurn` path must NOT release a runtime a realtime
	 * adapter still owns — that disposal is driven by the LiveSession lifecycle.
	 */
	private readonly realtimeOwned = new Set<DebugConversationId>();

	constructor(options: DebugConversationServiceOptions) {
		this.repositories = options.repositories;
		this.debug = options.debug;
		this.catalog = options.catalog;
		this.tenantId = options.tenantId;
		this.ownerPrincipalId = options.ownerPrincipalId;
		this.citations = options.citations;
		this.attachments = options.attachments;
		this.reportError = options.reportError ?? (() => {});
		// Debug and Published go through the SAME RuntimeSpec → Pi Agent builder:
		// inject the shared adapter instance, or build one from the same factory
		// (used when `createSession` is a mock in unit harnesses).
		this.openAdapter =
			options.openAdapter ??
			createPiRuntimeAdapter({
				createSession: options.createSession,
				...(options.createMcpTools !== undefined ? { createMcpTools: options.createMcpTools } : {}),
				...(options.skillMaterializer !== undefined ? { skillMaterializer: options.skillMaterializer } : {}),
				...(options.resolveToolName !== undefined
					? { resolveToolName: options.resolveToolName }
					: { resolveToolName: (id) => this.catalog.tools.find((candidate) => candidate.id === id)?.name }),
			});
	}

	/** Most recent `active` Debug conversation for (tenant, owner, agent), if any. */
	async resume(agentId: AgentDefinitionId | null): Promise<DebugConversationRecord | undefined> {
		return this.debug.conversations.getRecentActive({
			tenantId: this.tenantId,
			ownerPrincipalId: this.ownerPrincipalId,
			agentId,
		});
	}

	/**
	 * Phase 2E: History list for the (owner, agent) scope, ordered by most
	 * recent activity. The repository call joins the first user-message
	 * preview in a single round trip (LATERAL subquery) so this method does
	 * NOT issue N follow-up `events.list` calls.
	 *
	 * Returns public DTOs ready for the History panel; `lastActiveAt` is
	 * serialised to ISO string so the client never has to know about the
	 * repository's `Date` type.
	 *
	 * Out of scope: title generation, search, archive, pin, folder — those
	 * are deferred per Phase 2E.
	 */
	async listHistory(
		agentId: AgentDefinitionId | null,
		limit?: number,
	): Promise<readonly DebugConversationHistoryItem[]> {
		const requested = limit ?? DEBUG_HISTORY_DEFAULT_LIMIT;
		const clamped = Math.min(Math.max(requested, 1), DEBUG_HISTORY_HARD_LIMIT);
		const rows = await this.debug.conversations.listByScope({
			tenantId: this.tenantId,
			ownerPrincipalId: this.ownerPrincipalId,
			agentId,
			limit: clamped,
		});
		return rows.map((row) => ({
			conversationId: toPublicId("DebugConversationId", row.conversation.debugConversationId),
			agentId: row.conversation.agentId === null ? null : toPublicId("AgentDefinitionId", row.conversation.agentId),
			status: row.conversation.status,
			lastActiveAt: row.conversation.lastActiveAt.toISOString(),
			lastEventSequence: row.conversation.lastEventSequence,
			firstUserMessagePreview:
				row.firstUserMessagePreview === null ? null : truncatePreview(row.firstUserMessagePreview),
		}));
	}

	/** Insert a brand-new active Debug conversation for (owner, agent). */
	async createNew(agentId: AgentDefinitionId | null): Promise<DebugConversationRecord> {
		const now = new Date();
		const record: DebugConversationRecord = {
			debugConversationId: newDebugConversationId(),
			tenantId: this.tenantId,
			agentId,
			ownerPrincipalId: this.ownerPrincipalId,
			status: "active",
			lastEventSequence: 0,
			createdAt: now,
			lastActiveAt: now,
			deletedAt: null,
		};
		await this.debug.conversations.insert(record);
		return record;
	}

	/** Fetch a conversation by its id (scoped to the tenant). */
	async get(conversationId: DebugConversationId): Promise<DebugConversationRecord | undefined> {
		return this.debug.conversations.getByRef(this.conversationRef(conversationId));
	}

	/** Fetch a conversation that belongs to this tenant AND this service's owner. */
	async getOwned(conversationId: DebugConversationId): Promise<DebugConversationRecord | undefined> {
		const record = await this.get(conversationId);
		if (record === undefined || record.ownerPrincipalId !== this.ownerPrincipalId) return undefined;
		return record;
	}

	/** List events for a conversation (incremental replay / reload restore). */
	async listEvents(
		conversationId: DebugConversationId,
		afterSequence = 0,
	): Promise<readonly DebugConversationEventRecord[]> {
		return this.debug.events.list(this.conversationRef(conversationId), { limit: 10_000, afterSequence });
	}

	/** Close every cached Runtime (used at shutdown / after tests). */
	async close(): Promise<void> {
		await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.runtime.close()));
		this.runtimes.clear();
	}

	/**
	 * Atomically reserve the single active Turn slot and return the real durable
	 * Turn id. Called synchronously by the Adapter's `beginTurn()` (from
	 * LiveSessionManager before a prompt op) so the realtime frame's turnId, the
	 * `live.currentTurnId`, and the persisted `debug_conversation_events` all
	 * share one identity. Returns `null` when another Turn is already running
	 * (the concurrent prompt is rejected before any transcript mutation).
	 */
	beginTurn(conversationId: DebugConversationId): TurnId | null {
		if (this.running.has(conversationId)) return null;
		this.running.add(conversationId);
		const turnId = newTurnId();
		this.reservedTurn.set(conversationId, turnId);
		return turnId;
	}

	/** Synchronously read the Turn id reserved by `beginTurn`, if any. */
	peekReservedTurn(conversationId: DebugConversationId): TurnId | undefined {
		return this.reservedTurn.get(conversationId);
	}

	/**
	 * Realtime Turn: the SAME single `runtime.prompt()` drives both the streaming
	 * progress (delivered to a live adapter/WS) and the `debug_conversation_events`
	 * persistence. There is exactly one terminal event per Turn
	 * (`end` | `failed` | `interrupted`), never a double terminal.
	 *
	 * When a Turn was reserved by `beginTurn` (the LiveSessionManager prompt path)
	 * that reservation is consumed and reused; otherwise the adapter acquires the
	 * slot itself (direct/fallback callers).
	 */
	async executeTurnRealtime(
		conversationId: DebugConversationId,
		text: string,
		options: DebugRealtimeTurnOptions = {},
	): Promise<DebugRealtimeTurnResult> {
		const reserved = this.reservedTurn.get(conversationId);
		if (reserved !== undefined) {
			this.reservedTurn.delete(conversationId);
			// `beginTurn` already acquired the single-turn slot for the realtime
			// prompt path; release it no matter how the Turn resolves (including
			// the pre-execution rejections that return before runTurnRealtime's
			// own finally block runs).
			try {
				return await this.runTurnRealtime(conversationId, text, { ...options, inputTurnId: reserved });
			} finally {
				this.running.delete(conversationId);
			}
		}
		if (this.running.has(conversationId)) {
			return {
				ok: false,
				terminal: "failed",
				turnId: options.inputTurnId ?? newTurnId(),
				outputText: "",
				rejected: true,
				error: "another Turn is already running",
			};
		}
		this.running.add(conversationId);
		try {
			return await this.runTurnRealtime(conversationId, text, options);
		} finally {
			this.running.delete(conversationId);
		}
	}

	/**
	 * Abort the currently-running Realtime Turn for a conversation. Never deletes
	 * the conversation, never clears history, never disposes the conversation
	 * identity. Returns `false` when no Turn is running. The single interrupted
	 * terminal event is persisted by the (still-in-flight) `runTurnRealtime`.
	 */
	async interruptActiveTurn(conversationId: DebugConversationId): Promise<boolean> {
		const active = this.activeTurns.get(conversationId);
		if (active === undefined) return false;
		await active.interrupt();
		await active.done;
		return true;
	}

	private async runTurnRealtime(
		conversationId: DebugConversationId,
		text: string,
		options: DebugRealtimeTurnOptions,
	): Promise<DebugRealtimeTurnResult> {
		const conversation = await this.debug.conversations.getByRef(this.conversationRef(conversationId));
		if (conversation === undefined || conversation.status !== "active") {
			return {
				ok: false,
				terminal: "failed",
				turnId: options.inputTurnId ?? newTurnId(),
				outputText: "",
				error: "Debug conversation is unavailable",
				rejected: true,
			};
		}
		if (conversation.agentId === null) {
			return {
				ok: false,
				terminal: "failed",
				turnId: options.inputTurnId ?? newTurnId(),
				outputText: "",
				error: "Debug conversation has no bound agent",
				rejected: true,
			};
		}

		const compiled = await compileDebugAgentRevision(
			this.compileDeps(),
			{ tenantId: this.tenantId },
			conversation.agentId,
		);
		if (!compiled.ok) {
			return {
				ok: false,
				terminal: "failed",
				turnId: options.inputTurnId ?? newTurnId(),
				outputText: "",
				error: compiled.error,
				rejected: true,
			};
		}
		const { spec, runtimeSpecHash, agentRevision } = compiled;
		const model: ModelRef = { provider: spec.agent.model.provider, id: spec.agent.model.modelId };
		// Effective thinkingLevel for THIS Turn (same resolver as Production):
		// recorded on turn/start so the reasoning behaviour of any Debug Turn is
		// auditable from the event stream.
		const revisionThinkingLevel = resolveEffectiveModelOptions({
			params: spec.agent.model.params,
			modelId: spec.agent.model.modelId,
			parameterCapabilities: spec.agent.model.parameterCapabilities,
			conversationEffort: null,
		}).thinkingLevel;
		const effectiveThinkingLevel = revisionThinkingLevel;

		// History restored from the Debug event stream before this Turn's events
		// are written so it excludes the in-flight user message. Phase-3
		// (Debussy): when a compaction summary exists we replay only the events
		// after its throughSequence and prepend the summary, so the rebuilt
		// Working Context is bounded and mirrors Production. Cursor-paginated
		// replay so a post-summary window is never silently truncated.
		const debugRef = this.conversationRef(conversationId);
		const summary = await this.debug.summaries.getLatest(debugRef);
		const afterSequence = summary?.throughSequence ?? 0;
		const events = await replayAllAfter(
			(after, limit) => this.debug.events.list(debugRef, { afterSequence: after, limit }),
			afterSequence,
		);
		let history: RestoredContext = restoreContext(
			events as unknown as readonly ConversationEventRecord[],
			{ maxContextTokens: spec.contextPolicy.maxContextTokens },
			spec.contextPolicy.logLevel,
		);
		if (summary !== undefined) {
			history = mergeRestored(
				buildSummaryRestoredMessage(
					(summary.body as { text?: string }).text ?? "",
					summary.throughSequence,
					spec.contextPolicy.logLevel,
				),
				history,
			);
		}

		const turnId = options.inputTurnId ?? newTurnId();
		const persisted = await this.appendAll(conversationId, [
			{
				eventType: "turn/start",
				turnId,
				payload: {
					turnId,
					model: spec.agent.model.modelId,
					...(effectiveThinkingLevel !== undefined ? { thinkingLevel: effectiveThinkingLevel } : {}),
					runtimeSpecHash,
					agentRevisionId: agentRevision,
					actualPublishedAppVersionId: null,
					resolutionSource: "followLatest",
				},
			},
			{
				eventType: "user/message",
				turnId,
				payload: {
					text: text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text,
					attachmentIds: [...(options.attachmentIds ?? [])],
				},
			},
		]);
		if (persisted === false) {
			return {
				ok: false,
				terminal: "failed",
				turnId,
				outputText: "",
				error: "failed to persist Debug turn start",
				rejected: true,
				model,
			};
		}

		let aborted = false;
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});

		try {
			const directAttachments = this.resolveDirectAttachments(conversationId, options);
			const runtime = await this.ensureRuntime(
				conversationId,
				conversation.agentId,
				spec,
				runtimeSpecHash,
				agentRevision,
			);
			this.activeTurns.set(conversationId, {
				turnId,
				done,
				interrupt: () => {
					aborted = true;
					return runtime.abort();
				},
			});

			const onProgress = options.onProgress;
			let unsub: (() => void) | undefined;
			// Tool-event persistence is strictly serialised through a promise
			// chain: `tool/call` must land BEFORE `tool/result`/`tool/error` in
			// the event stream (sequence order), so the rebuild + UI history keep
			// per-Turn tool ordering. A parallel `Promise.all` would let PG
			// commit the terminal event first when the pool is busy.
			let persistChain: Promise<void> = Promise.resolve();
			unsub = runtime.subscribe((event: ConversationRuntimeEvent) => {
				if (event.event.type !== "progress") return;
				const progress = event.event.progress;
				// 1) Realtime UI: forward through rekey/unkey rules (see
				//    forwardStream).
				if (onProgress !== undefined) this.forwardStream(progress, turnId, onProgress);
				// 2) Persistence: mirror Production `tool/call | tool/result |
				//    tool/error` vocabulary for `role:"tool"` items, scoped to
				//    the same turnId. Same single progress stream drives both
				//    realtime + persistence — no second listener, no second
				//    execution.
				if (
					progress.type === "item_started" ||
					progress.type === "item_updated" ||
					progress.type === "item_finished"
				) {
					if (progress.item.role === "tool") {
						const toolItem = progress.item as ToolTranscriptItem;
						persistChain = persistChain.then(() =>
							this.persistToolProgress(conversationId, turnId, spec, progress.type, toolItem),
						);
					}
				}
			});

			try {
				const retrieval = await this.buildRetrieval(conversationId, spec, text, turnId);
				await runtime.prompt(text, {
					history,
					retrieval,
					...(options.attachmentIds && options.attachmentIds.length > 0
						? { attachmentIds: [...options.attachmentIds] }
						: {}),
					...(directAttachments.length > 0 ? { attachments: directAttachments } : {}),
				});
				// Drain tool-event persistence BEFORE writing the Turn terminal
				// so the event stream is strictly ordered (tool/call/result
				// before assistant/message + turn/end).
				await persistChain.catch(() => {});
				if (aborted) {
					// Cancel semantics: keep whatever thinking/text the provider
					// already streamed (never clear it on Stop), but the Turn is
					// still `turn/interrupted` — NOT a fabricated complete
					// assistant/message + turn/end. Mirrors the Production
					// aborted item which retains its content.
					const partial = lastAssistantResultAnyStatus(runtime.snapshot());
					await this.appendAll(conversationId, [
						...(partial.outputText || partial.thinkingText
							? [
									{
										eventType: "assistant/message",
										turnId,
										payload: {
											text: partial.outputText,
											...(partial.thinkingText ? { thinking: partial.thinkingText } : {}),
											status: "interrupted",
										},
									},
								]
							: []),
						{ eventType: "turn/interrupted", turnId, payload: { aborted: true } },
					]);
					return {
						ok: true,
						terminal: "interrupted",
						turnId,
						outputText: partial.outputText,
						...(partial.thinkingText ? { thinkingText: partial.thinkingText } : {}),
						model,
					};
				}
				const output = lastAssistantResult(runtime.snapshot());
				await this.appendAll(conversationId, [
					{
						eventType: "assistant/message",
						turnId,
						payload: {
							text: output.outputText,
							...(output.thinkingText ? { thinking: output.thinkingText } : {}),
						},
					},
					// Production-equivalent citation persistence: metadata +
					// reference only (never the excerpt cards), so reconnect keeps
					// the citation footprint without a full-card restore.
					...(retrieval !== undefined && retrieval.citations.length > 0
						? [
								{
									eventType: "citation/updated",
									turnId,
									payload: {
										reference: retrieval.reference,
										count: retrieval.citations.length,
										turnId,
									},
								},
							]
						: []),
					{
						eventType: "turn/end",
						turnId,
						payload: { ok: true, ...(output.usage ? { usage: output.usage } : {}) },
					},
				]);
				// Debussy-owned compaction (Phase-3): persist a chained summary at
				// a complete-Turn boundary when the Working Context exceeds the
				// unified budget. On compaction, evict the runtime so the next
				// Turn rebuilds an equivalent Working Context from Postgres and
				// there is no second, divergent in-memory context (Debug parity).
				const compaction = await runDebussyCompaction(
					createDebugConversationEventCompactionStore(this.debug, this.conversationRef(conversationId)),
					spec,
				);
				if (compaction.compacted) {
					await this.releaseRuntime(conversationId);
				}
				return {
					ok: true,
					terminal: "end",
					turnId,
					outputText: output.outputText,
					...(output.thinkingText ? { thinkingText: output.thinkingText } : {}),
					...(retrieval !== undefined && retrieval.citations.length > 0
						? { citations: [...retrieval.citations] }
						: {}),
					model,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (aborted) {
					// Cancel during a provider error: keep streamed content.
					const partial = lastAssistantResultAnyStatus(runtime.snapshot());
					await this.appendAll(conversationId, [
						...(partial.outputText || partial.thinkingText
							? [
									{
										eventType: "assistant/message",
										turnId,
										payload: {
											text: partial.outputText,
											...(partial.thinkingText ? { thinking: partial.thinkingText } : {}),
											status: "interrupted",
										},
									},
								]
							: []),
						{ eventType: "turn/interrupted", turnId, payload: { aborted: true, error: message } },
					]);
					return {
						ok: true,
						terminal: "interrupted",
						turnId,
						outputText: partial.outputText,
						...(partial.thinkingText ? { thinkingText: partial.thinkingText } : {}),
						model,
					};
				}
				await this.appendAll(conversationId, [{ eventType: "turn/failed", turnId, payload: { error: message } }]);
				return {
					ok: false,
					terminal: "failed",
					turnId,
					outputText: "",
					error: `Debug Turn failed: ${message}`,
					model,
				};
			} finally {
				unsub?.();
				// Defensive: drain the serialised persist chain even on the error
				// path (already drained on the happy path).
				await persistChain.catch(() => {});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.appendAll(conversationId, [{ eventType: "turn/failed", turnId, payload: { error: message } }]);
			return {
				ok: false,
				terminal: "failed",
				turnId,
				outputText: "",
				error: `Debug Turn failed: ${message}`,
				model,
			};
		} finally {
			this.activeTurns.delete(conversationId);
			resolveDone?.();
		}
	}

	private resolveDirectAttachments(
		conversationId: DebugConversationId,
		options: DebugRealtimeTurnOptions,
	): readonly ResolvedAttachmentInput[] {
		const ids = options.attachmentIds ?? [];
		if (ids.length === 0 || this.attachments === undefined) return options.attachments ?? [];
		const publicConversationId = toPublicId("DebugConversationId", conversationId);
		return ids.map((id) => {
			this.attachments!.assertOwnership(id, {
				tenantId: this.tenantId,
				principalId: this.ownerPrincipalId,
			});
			const record = this.attachments!.get(id);
			if (
				record === undefined ||
				record.attachment.sessionId !== publicConversationId ||
				record.attachment.status !== "ready"
			) {
				throw new Error(`Attachment is not ready and owned by this Debug conversation: ${id}`);
			}
			return {
				id,
				name: record.attachment.name,
				mediaType: record.attachment.mediaType,
				path: this.attachments!.filePath(id),
			};
		});
	}

	/**
	 * Conversation-scoped retrieval for a Debug Turn (Phase 2D read path).
	 * Mirrors the Production retrieval policy (`prepareRetrieval`): gated by
	 * `capabilities.uploads.enabled`, enumerates only THIS conversation's READY
	 * Sources (keyed by public dconv id from the shared CitationStore), reuses
	 * `retrieveForConversation` so ranking / topK / context budget / reference /
	 * citation shaping are identical to Production, and returns `undefined` when
	 * no Source matches — so a Turn without retrieval context is never served an
	 * empty retrieval block.
	 */
	private async buildRetrieval(
		conversationId: DebugConversationId,
		spec: RuntimeSpec,
		query: string,
		turnId: TurnId,
	): Promise<RetrievalInput | undefined> {
		if (this.citations === undefined || !conversationRetrievalEnabled(spec)) return undefined;
		const publicConversationId = toPublicId("DebugConversationId", conversationId);
		const sourceIds = this.citations
			.listSourcesBySession(publicConversationId)
			.filter((source) => source.status === "ready")
			.map((source) => source.id);
		if (sourceIds.length === 0) return undefined;
		const result = await this.citations.retrieveForConversation(
			{
				tenantId: this.tenantId,
				publishedAppId: "",
				principalId: this.ownerPrincipalId,
				conversationId: publicConversationId,
			},
			{ sourceIds, query, turnId },
		);
		if (result.citations.length === 0) return undefined;
		return { context: result.context, reference: result.reference, citations: result.citations };
	}

	/**
	 * Forward one streaming progress event to the live UI. Assistant deltas/items
	 * are re-keyed to the stable, DB-backed `ast:<turnId>` identity so streaming
	 * and the reloaded transcript coalesce. Tool items (`role:"tool"`) carry
	 * their own stable identity (`tool-<toolCallId>` from the coding-agent
	 * progress adapter) and pass through verbatim — they are NOT re-keyed.
	 * `ConversationWorkspace` (`AiMessageFlow` `groupTurns`) renders
	 * `role:"tool"` items directly in the AgentTrace rail.
	 */
	private forwardStream(
		progress: TranscriptProgress,
		turnId: TurnId,
		onProgress: (progress: TranscriptProgress) => void,
	): void {
		if (progress.type === "assistant_delta") {
			onProgress({ ...progress, messageId: `ast:${turnId}` });
			return;
		}
		if (progress.type === "item_started" || progress.type === "item_updated" || progress.type === "item_finished") {
			if (progress.item.role === "tool") {
				onProgress(progress);
				return;
			}
			if (progress.item.role === "assistant") {
				onProgress({ ...progress, item: { ...progress.item, id: `ast:${turnId}` } } as TranscriptProgress);
				return;
			}
			return;
		}
		onProgress(progress);
	}

	/**
	 * Mirror Production `persistToolProgress` (embed/conversations/service.ts) for
	 * the Debug event stream. Writes one of `tool/call` (item_started,running),
	 * `tool/result` (item_finished,complete) or `tool/error`
	 * (item_finished,error). `item_updated` is intentionally not persisted (same
	 * as Production).
	 *
	 * Built entirely through the shared `toToolProgressEvent`, so Debug persists
	 * EXACTLY what Production does: the model-generated `tool/call` arguments and
	 * the runtime-bounded model-visible `tool/result` content — guaranteeing a
	 * Postgres-only rebuild can reproduce the same model context on both planes.
	 * MCP-specific audit lives in `mcp_call_audit` (separate) and is never
	 * duplicated into the Debug event stream.
	 */
	private async persistToolProgress(
		conversationId: DebugConversationId,
		turnId: TurnId,
		spec: RuntimeSpec,
		progressType: "item_started" | "item_updated" | "item_finished",
		item: ToolTranscriptItem,
	): Promise<void> {
		if (progressType === "item_updated") return;
		const event = toToolProgressEvent(spec, progressType, item);
		if (event === null) return;
		await this.appendAll(conversationId, [
			{
				eventType: event.eventType,
				turnId,
				payload: event.payload,
			},
		]);
	}

	/** Close + evict a cached Runtime (used when a realtime adapter is released). */
	async releaseRuntime(conversationId: DebugConversationId): Promise<void> {
		const existing = this.runtimes.get(conversationId);
		if (existing === undefined) return;
		this.runtimes.delete(conversationId);
		await existing.runtime.close().catch(() => {});
	}

	/** Mark a conversation as pinned by a live realtime adapter. */
	markRealtimeOwned(conversationId: DebugConversationId): void {
		this.realtimeOwned.add(conversationId);
	}

	/** Release the realtime pin (adapter disposed / WS fully closed). */
	unmarkRealtimeOwned(conversationId: DebugConversationId): void {
		this.realtimeOwned.delete(conversationId);
	}

	/**
	 * Close a cached runtime only when nothing else owns it. The headless path
	 * calls this after each Turn; it stands down if a realtime adapter still
	 * pins the conversation or a realtime Turn is in flight.
	 */
	async releaseRuntimeIfUnpinned(conversationId: DebugConversationId): Promise<void> {
		if (this.realtimeOwned.has(conversationId) || this.activeTurns.has(conversationId)) return;
		await this.releaseRuntime(conversationId);
	}

	/**
	 * Phase 2F: soft-delete (expire) every `active` Debug conversation for this
	 * service's (tenant, owner) scope whose last activity is older than `cutoff`.
	 * Atomic against a concurrent `append` — the conditional UPDATE on the row
	 * means exactly one of expire / turn-start wins (see repo). Returns the
	 * conversations that were expired. Callers (startup / periodic sweep) must
	 * pass a `cutoff` of `now - slidingTtl`.
	 */
	async expireIdleSessions(cutoff: Date): Promise<readonly DebugConversationId[]> {
		return this.debug.conversations.expireActiveBefore(
			{ tenantId: this.tenantId, ownerPrincipalId: this.ownerPrincipalId },
			cutoff,
		);
	}

	/**
	 * Phase 2F physical GC: purge soft-deleted conversations past their grace
	 * window, including their runtime, AttachmentStore records/files and
	 * CitationStore sources/chunks/turn-data, in an idempotent, re-runnable
	 * order (external resources have no PG FK, so the canonical row is deleted
	 * only last). Returns the number of conversations physically removed.
	 */
	async gcPhysical(cutoff: Date): Promise<number> {
		const candidates = await this.debug.conversations.listDeletedBefore(
			{ tenantId: this.tenantId, ownerPrincipalId: this.ownerPrincipalId },
			cutoff,
		);
		let removed = 0;
		for (const record of candidates) {
			if (await this.gcOne(record)) removed += 1;
		}
		return removed;
	}

	private async gcOne(record: DebugConversationRecord): Promise<boolean> {
		const { debugConversationId } = record;
		const publicId = DebugConversationService.publicConversationId(debugConversationId);
		try {
			// 1) Release the owning runtime (if a WS holds it, dispose first).
			await this.releaseRuntime(debugConversationId);
			// 2) Capture + clean attachments bound to this session (record + files).
			if (this.attachments !== undefined) {
				for (const attachment of this.attachments.listBySession(publicId)) {
					await this.attachments.remove(attachment.id);
				}
			}
			// 3) Clean retrieval data owned by this session.
			if (this.citations !== undefined) {
				await this.citations.deleteSessionData(publicId);
			}
			// 4) Remove the DB events + canonical row last.
			return await this.debug.conversations.deletePhysical(
				this.conversationRef(debugConversationId),
				debugConversationId,
			);
		} catch (error) {
			// Never let one conversation abort the sweep; the row stays deleted
			// (grace window) and the next pass retries.
			this.reportError?.(error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	}

	/** Execute one Turn against an existing Debug conversation (lazy revision resolve). */
	async executeTurn(
		conversationId: DebugConversationId,
		text: string,
		inputTurnId?: TurnId,
		options: {
			readonly attachmentIds?: readonly string[];
			readonly attachments?: readonly ResolvedAttachmentInput[];
		} = {},
	): Promise<DebugTurnResult> {
		if (this.running.has(conversationId)) return { ok: false, error: "another Turn is already running" };
		this.running.add(conversationId);
		try {
			const result = await this.runTurnRealtime(conversationId, text, {
				...(inputTurnId !== undefined ? { inputTurnId } : {}),
				...options,
			});
			if (!result.ok) return { ok: false, error: result.error ?? "Debug Turn failed" };
			const conversation = await this.getOwned(conversationId);
			if (conversation === undefined) return { ok: false, error: "Debug conversation is unavailable" };
			return {
				ok: true,
				conversation,
				turnId: result.turnId,
				outputText: result.outputText,
				...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
			};
		} finally {
			this.running.delete(conversationId);
			// Headless runtime is process-cache ownership only: no LiveSession/
			// realtime drives its disposal, so release it once the Turn finishes.
			await this.releaseRuntimeIfUnpinned(conversationId);
		}
	}

	/**
	 * Get-or-build the Runtime entry for a conversation, rebuilding the bottom
	 * session when the frozen spec hash (system prompt / model / skills / MCP
	 * shape / policies) changed, or when the resolution revision changed. Live
	 * resources (credentials, MCP status, Skill artifact existence) are never
	 * part of this decision — they are read at call time.
	 */
	private async ensureRuntime(
		conversationId: DebugConversationId,
		agentId: AgentDefinitionId,
		spec: RuntimeSpec,
		runtimeSpecHash: string,
		resolvedRevision: number,
	): Promise<ConversationRuntime> {
		const existing = this.runtimes.get(conversationId);
		if (
			existing !== undefined &&
			existing.runtimeSpecHash === runtimeSpecHash &&
			existing.resolvedRevision === resolvedRevision
		) {
			return existing.runtime;
		}
		if (existing !== undefined) {
			await existing.runtime.close().catch(() => {});
			this.runtimes.delete(conversationId);
		}
		const created = await this.openRuntime(conversationId, agentId, spec, runtimeSpecHash, resolvedRevision);
		this.runtimes.set(conversationId, created);
		return created.runtime;
	}

	private async openRuntime(
		conversationId: DebugConversationId,
		_agentId: AgentDefinitionId,
		spec: RuntimeSpec,
		runtimeSpecHash: string,
		resolvedRevision: number,
	): Promise<DebugRuntimeEntry> {
		const scope: ScopeContext = {
			tenantId: this.tenantId,
			publishedAppId: conversationId as unknown as ScopeContext["publishedAppId"],
			publishedAppVersionId: conversationId as unknown as ScopeContext["publishedAppVersionId"],
			principalId: this.ownerPrincipalId,
			conversationId: conversationId as unknown as ScopeContext["conversationId"],
			conversationEffort: null,
			limits: {
				maxTurns: spec.contextPolicy.maxTurns,
				maxContextTokens: spec.contextPolicy.maxContextTokens,
				toolResultMaxBytes: spec.contextPolicy.toolResultMaxBytes,
				turnTimeoutMs: spec.runtimePolicy.turnTimeoutMs,
				maxConcurrentTurnsPerConversation: spec.runtimePolicy.maxConcurrentTurnsPerConversation,
			},
		};
		// Debug and Published go through the EXACT same RuntimeSpec → Pi Agent
		// construction (createPiRuntimeAdapter.open). Model / thinking / skills /
		// MCP customTools / allowedToolNames all come from the frozen spec; there
		// is no second Debug-only Runtime configuration path.
		const opened = await this.openAdapter.open(spec, scope);
		if (!opened.ok) throw new Error(`open RuntimeSpec: ${opened.reason}`);
		return { runtime: opened.runtime, runtimeSpecHash, resolvedRevision };
	}

	/**
	 * Persist an attachment_snapshot / attachment_removed event to the
	 * conversation's event stream. Called by the realtime adapter's
	 * attachment-event hook (see {@link DebugConversationRealtime}); the bytes
	 * stay in the {@link AttachmentStore}, only metadata is recorded so the
	 * snapshot rebuild can rehydrate `SessionSnapshot.attachments` on reconnect.
	 */
	async persistAttachmentEvent(
		conversationId: DebugConversationId,
		eventType: "attachment_snapshot" | "attachment_removed",
		payload: unknown,
	): Promise<void> {
		await this.appendAll(conversationId, [{ eventType, payload }]);
	}

	private compileDeps(): DebugCompileDeps {
		return { repositories: this.repositories, catalog: this.catalog };
	}

	private conversationRef(conversationId: DebugConversationId) {
		return {
			tenantId: this.tenantId,
			ownerPrincipalId: this.ownerPrincipalId,
			debugConversationId: conversationId,
		};
	}

	private async appendAll(
		conversationId: DebugConversationId,
		events: readonly { readonly eventType: string; readonly turnId?: TurnId; readonly payload: unknown }[],
	): Promise<boolean> {
		for (const event of events) {
			const appended = await this.debug.events.append(this.conversationRef(conversationId), conversationId, {
				eventType: event.eventType,
				turnId: event.turnId ?? null,
				payload: event.payload,
			});
			if (appended === undefined) return false;
		}
		return true;
	}

	/** Map an agent public id to its internal id; returns null on invalid input. */
	static parseAgentId(agentId: string): AgentDefinitionId | null {
		return fromPublicId("AgentDefinitionId", agentId);
	}

	/** Public id for a Debug conversation. */
	static publicConversationId(conversationId: DebugConversationId): string {
		return toPublicId("DebugConversationId", conversationId);
	}
}

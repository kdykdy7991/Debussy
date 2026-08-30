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
import type { ModelRef, ReasoningEffort, ToolTranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";
import { resolveEffectiveModelOptions } from "../../model-parameters.ts";
import { type RestoredContext, restoreContext } from "../../runtime/context-restore.ts";
import type { ConversationRuntimeEvent } from "../../runtime/conversation-runtime.ts";
import { ConversationRuntime } from "../../runtime/conversation-runtime.ts";
import type { RuntimeSessionOptions } from "../../runtime/pi-runtime-adapter.ts";
import type { ScopeContext } from "../../runtime/scope-context.ts";
import { lastAssistantResult, lastAssistantResultAnyStatus } from "../../runtime/turn-executor.ts";
import type { MaterializedSkill, PiSessionRuntime, ResolvedAttachmentInput } from "../../types.ts";
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
import { deriveToolType } from "../runtime/tool-type.ts";
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
}

/** Cached Debug Runtime entry, keyed by `debugConversationId`. */
export interface DebugRuntimeEntry {
	readonly runtime: ConversationRuntime;
	readonly runtimeSpecHash: string;
	readonly resolvedRevision: number;
	/** Open-time baked effort override; null when not used (Phase 1). */
	readonly conversationEffort: ReasoningEffort | null;
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
	private readonly createSession: DebugSessionFactory;
	private readonly skillMaterializer: SkillMaterializer | undefined;
	private readonly createMcpTools: McpRuntimeToolFactory | undefined;
	private readonly tenantId: TenantId;
	private readonly ownerPrincipalId: PrincipalId;

	/** Runtime cache: `Map<debugConversationId, RuntimeEntry>` (Phase 1, in-memory). */
	private readonly runtimes = new Map<DebugConversationId, DebugRuntimeEntry>();
	/** Process-level single-writer guard: one Turn per Debug conversation. */
	private readonly running = new Set<DebugConversationId>();
	/** Turn id reserved by `beginTurn` for the imminent realtime prompt. */
	private readonly reservedTurn = new Map<DebugConversationId, TurnId>();
	/** Currently-running Realtime Turn per conversation, for the abort command. */
	private readonly activeTurns = new Map<DebugConversationId, ActiveDebugTurn>();

	constructor(options: DebugConversationServiceOptions) {
		this.repositories = options.repositories;
		this.debug = options.debug;
		this.catalog = options.catalog;
		this.createSession = options.createSession;
		this.skillMaterializer = options.skillMaterializer;
		this.createMcpTools = options.createMcpTools;
		this.tenantId = options.tenantId;
		this.ownerPrincipalId = options.ownerPrincipalId;
	}

	/** Most recent `active` Debug conversation for (tenant, owner, agent), if any. */
	async resume(agentId: AgentDefinitionId | null): Promise<DebugConversationRecord | undefined> {
		return this.debug.conversations.getRecentActive({
			tenantId: this.tenantId,
			ownerPrincipalId: this.ownerPrincipalId,
			agentId,
		});
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
		};
		await this.debug.conversations.insert(record);
		return record;
	}

	/** Fetch a conversation by its id (scoped to the tenant). */
	async get(conversationId: DebugConversationId): Promise<DebugConversationRecord | undefined> {
		return this.debug.conversations.getByRef({ tenantId: this.tenantId, debugConversationId: conversationId });
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
		return this.debug.events.list(
			{ tenantId: this.tenantId, debugConversationId: conversationId },
			{ limit: 10_000, afterSequence },
		);
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
		const conversation = await this.debug.conversations.getByRef({
			tenantId: this.tenantId,
			debugConversationId: conversationId,
		});
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
		const effectiveThinkingLevel = resolveEffectiveModelOptions({
			params: spec.agent.model.params,
			modelId: spec.agent.model.modelId,
			parameterCapabilities: spec.agent.model.parameterCapabilities,
			conversationEffort: null,
		}).thinkingLevel;

		// History restored from the Debug event stream before this Turn's events
		// are written so it excludes the in-flight user message.
		const events = await this.debug.events.list(
			{ tenantId: this.tenantId, debugConversationId: conversationId },
			{ limit: 10_000, afterSequence: 0 },
		);
		const history: RestoredContext = restoreContext(
			events as unknown as readonly ConversationEventRecord[],
			{ maxContextTokens: spec.contextPolicy.maxContextTokens },
			spec.contextPolicy.logLevel,
		);

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
				payload: { text: text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text },
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
			if (onProgress !== undefined) {
				unsub = runtime.subscribe((event: ConversationRuntimeEvent) => {
					if (event.event.type !== "progress") return;
					const progress = event.event.progress;
					// 1) Realtime UI: forward through rekey/unkey rules (see
					//    forwardStream).
					this.forwardStream(progress, turnId, onProgress);
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
			}

			try {
				await runtime.prompt(text, {
					history,
					retrieval: undefined,
					...(options.attachmentIds && options.attachmentIds.length > 0
						? { attachmentIds: [...options.attachmentIds] }
						: {}),
					...(options.attachments && options.attachments.length > 0
						? { attachments: [...options.attachments] }
						: {}),
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
					{
						eventType: "turn/end",
						turnId,
						payload: { ok: true, ...(output.usage ? { usage: output.usage } : {}) },
					},
				]);
				return {
					ok: true,
					terminal: "end",
					turnId,
					outputText: output.outputText,
					...(output.thinkingText ? { thinkingText: output.thinkingText } : {}),
					model,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (aborted) {
					// Cancel during a provider error: keep streamed content.
					const partial = lastAssistantResultAnyStatus(runtime.snapshot());
					await this.appendAll(conversationId, [
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
		} finally {
			this.activeTurns.delete(conversationId);
			resolveDone?.();
		}
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
	 * Payload strictly mirrors Production vocabulary — NO tool input, NO tool
	 * output, NO truncation policy. MCP-specific audit lives in
	 * `mcp_call_audit` (separate) and is never duplicated into the Debug event
	 * stream.
	 */
	private async persistToolProgress(
		conversationId: DebugConversationId,
		turnId: TurnId,
		spec: RuntimeSpec,
		progressType: "item_started" | "item_updated" | "item_finished",
		item: ToolTranscriptItem,
	): Promise<void> {
		const base = {
			toolCallId: item.toolCallId,
			toolName: item.toolName,
			toolType: deriveToolType(spec, item.toolName),
		};
		if (progressType === "item_started") {
			if (item.status !== "running") return;
			await this.appendAll(conversationId, [
				{
					eventType: "tool/call",
					turnId,
					payload: { ...base, status: "running", startedAt: item.timestamp },
				},
			]);
			return;
		}
		if (progressType === "item_updated") return;
		// item_finished.
		if (item.status === "complete") {
			await this.appendAll(conversationId, [
				{
					eventType: "tool/result",
					turnId,
					payload: { ...base, status: "complete", finishedAt: item.timestamp },
				},
			]);
			return;
		}
		if (item.status === "error") {
			await this.appendAll(conversationId, [
				{
					eventType: "tool/error",
					turnId,
					payload: {
						...base,
						status: "error",
						error: deriveToolError(item),
						finishedAt: item.timestamp,
					},
				},
			]);
		}
	}

	/** Close + evict a cached Runtime (used when a realtime adapter is released). */
	async releaseRuntime(conversationId: DebugConversationId): Promise<void> {
		const existing = this.runtimes.get(conversationId);
		if (existing === undefined) return;
		this.runtimes.delete(conversationId);
		await existing.runtime.close().catch(() => {});
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
			return await this.runTurn(conversationId, text, inputTurnId, options);
		} finally {
			this.running.delete(conversationId);
		}
	}

	private async runTurn(
		conversationId: DebugConversationId,
		text: string,
		inputTurnId?: TurnId,
		options: {
			readonly attachmentIds?: readonly string[];
			readonly attachments?: readonly ResolvedAttachmentInput[];
		} = {},
	): Promise<DebugTurnResult> {
		const conversation = await this.debug.conversations.getByRef({
			tenantId: this.tenantId,
			debugConversationId: conversationId,
		});
		if (conversation === undefined || conversation.status !== "active") {
			return { ok: false, error: "Debug conversation is unavailable" };
		}
		if (conversation.agentId === null) return { ok: false, error: "Debug conversation has no bound agent" };

		// 3/4/5. Resolve current agent revision + compile RuntimeSpec + hash.
		const compiled = await compileDebugAgentRevision(
			this.compileDeps(),
			{ tenantId: this.tenantId },
			conversation.agentId,
		);
		if (!compiled.ok) return { ok: false, error: compiled.error };
		const { spec, runtimeSpecHash, agentRevision } = compiled;

		// 9. Restore history from the Debug event stream (user+assistant text
		// only), read BEFORE this turn's events are written so history excludes
		// the in-flight user message.
		const events = await this.debug.events.list(
			{ tenantId: this.tenantId, debugConversationId: conversationId },
			{ limit: 10_000, afterSequence: 0 },
		);
		const history: RestoredContext = restoreContext(
			events as unknown as readonly ConversationEventRecord[],
			{ maxContextTokens: spec.contextPolicy.maxContextTokens },
			spec.contextPolicy.logLevel,
		);

		const turnId = inputTurnId ?? newTurnId();
		// Effective thinkingLevel for THIS Turn (same resolver as Production).
		const effectiveThinkingLevel = resolveEffectiveModelOptions({
			params: spec.agent.model.params,
			modelId: spec.agent.model.modelId,
			parameterCapabilities: spec.agent.model.parameterCapabilities,
			conversationEffort: null,
		}).thinkingLevel;
		// 12. Persist turn bookkeeping BEFORE execution so a mid-turn crash (or a
		// session-open failure) never loses turn/start or the user input.
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
				payload: { text: text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text },
			},
		]);
		if (persisted === false) return { ok: false, error: "failed to persist Debug turn start" };

		// 6/7/8/11. Acquire the Debug Runtime (rebuilding only when the spec
		// changed) and execute the Turn. Everything below runs under try so a
		// failure persists turn/failed and never a fake turn/end.
		try {
			const runtime = await this.ensureRuntime(
				conversationId,
				conversation.agentId,
				spec,
				runtimeSpecHash,
				agentRevision,
			);
			await runtime.prompt(text, {
				history,
				retrieval: undefined,
				...(options.attachmentIds && options.attachmentIds.length > 0
					? { attachmentIds: [...options.attachmentIds] }
					: {}),
				...(options.attachments && options.attachments.length > 0 ? { attachments: [...options.attachments] } : {}),
			});
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
				{
					eventType: "turn/end",
					turnId,
					payload: { ok: true, ...(output.usage ? { usage: output.usage } : {}) },
				},
			]);
			return {
				ok: true,
				conversation,
				turnId,
				outputText: output.outputText,
				...(output.thinkingText ? { thinkingText: output.thinkingText } : {}),
				...(output.usage ? { usage: output.usage } : {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.appendAll(conversationId, [{ eventType: "turn/failed", turnId, payload: { error: message } }]);
			return { ok: false, error: `Debug Turn failed: ${message}` };
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
			existing.resolvedRevision === resolvedRevision &&
			existing.conversationEffort === null
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
		const skills: readonly MaterializedSkill[] =
			this.skillMaterializer === undefined
				? []
				: await this.skillMaterializer.materialize(spec, { tenantId: this.tenantId });
		// Same effective-thinking resolver as Production (explicit params →
		// legacy thinkingLevel → capability defaultEffort → off): a given Agent
		// Revision + model + config yields identical reasoning behaviour in the
		// Debug conversation and the published conversation.
		const resolved = resolveEffectiveModelOptions({
			params: spec.agent.model.params,
			modelId: spec.agent.model.modelId,
			parameterCapabilities: spec.agent.model.parameterCapabilities,
			conversationEffort: null,
		});
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
		// MCP customTools (Phase 2A): built from the same factory Production uses
		// (`createMcpRuntimeToolFactory`). Credentials are still resolved at
		// execute-time inside each tool's `execute()` — they never enter the
		// RuntimeSpec, the runtimeSpecHash, this conversation row, or any
		// persisted tool event.
		const customTools = this.createMcpTools === undefined ? [] : await this.createMcpTools(spec, scope);
		const session = await this.createSession({
			id: conversationId,
			model: { provider: spec.agent.model.provider, id: spec.agent.model.modelId },
			...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
			streamOptions: resolved.streamOptions,
			...(customTools.length > 0 ? { customTools } : {}),
			systemPrompt: spec.agent.systemPrompt,
			...(skills.length > 0 ? { skills } : {}),
		});
		const runtime = new ConversationRuntime({ scope, spec, session });
		return { runtime, runtimeSpecHash, resolvedRevision, conversationEffort: null };
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

	private async appendAll(
		conversationId: DebugConversationId,
		events: readonly { readonly eventType: string; readonly turnId?: TurnId; readonly payload: unknown }[],
	): Promise<boolean> {
		for (const event of events) {
			const appended = await this.debug.events.append(
				{ tenantId: this.tenantId, debugConversationId: conversationId },
				conversationId,
				{ eventType: event.eventType, turnId: event.turnId ?? null, payload: event.payload },
			);
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

/** Mirror Production: extract error string from a tool error item's text content. */
function deriveToolError(item: ToolTranscriptItem): string {
	if (item.status !== "error") return "tool error";
	for (const part of item.content) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "tool error";
}

/**
 * Conversation 服务（spec 27.5 / 8.2，TASK-016 + WB-007）。
 *
 * 创建时由服务端从 App 的 currentVersion 读取版本并事务性固定——客户端
 * 绝不能提交 `publishedAppVersionId` 或 `ownerPrincipalId`（禁止继续条件）。
 * 所有操作都以 `EmbedAuthContext`（来自 Access Token）为 scope 走作用域
 * 安全 Repository：A/B 用户、跨 App、越权一律表现为统一不可用
 * （CONVERSATION_NOT_FOUND），不做 ID 枚举。
 *
 * App 停用（PD-04）：suspended 后禁止新建 Conversation，已建会话仍可按
 * 策略读取/归档（读取由外层策略决定，MVP 允许本人读取历史）。
 *
 * WB-007: executeTurn 写入 `user.message` / `assistant.message` / `turn.end` /
 * `turn.failed` / `turn.interrupted` 等结构化事件；流式 chunk / 工具调用 /
 * 附件 / 引用 按 RuntimeSpec.contextPolicy.logLevel 决定是否持久化。
 */
import type { Citation, ConversationRollover, SessionLogLevel, TurnMetrics } from "@earendil-works/pi-protocol";
import {
	assertEventPayloadSafe,
	DEFAULT_CONVERSATION_LIMITS,
	shouldPersistAssistantChunk,
	shouldRolloverConversation,
} from "@earendil-works/pi-protocol";
import { estimateContextSnapshot } from "../../agent-v2/context.ts";
import { agentV2MetricsEnabled } from "../../agent-v2/feature-flag.ts";
import { buildTurnMetrics, startTurnTiming, usageCountsFromProtocolUsage } from "../../agent-v2/turn-metrics.ts";
import {
	appNotFound,
	appSuspended,
	conversationNotFound,
	type EmbedError,
	runtimeUnavailable,
	turnAlreadyRunning,
	versionUnavailable,
} from "../../publishing/domain/errors.ts";
import {
	type ConversationId,
	newConversationId,
	newConversationSummaryId,
	newTurnId,
	type TurnId,
} from "../../publishing/domain/ids.ts";
import type {
	ConversationEventInput,
	ConversationEventRecord,
	ConversationListRow,
	ConversationRecord,
	ConversationScope,
	OwnerScope,
	PublishingRepositories,
} from "../../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../../publishing/runtime-spec/schema.ts";
import { type RestoredContext, restoreContext } from "../../runtime/context-restore.ts";
import type { ScopeContext } from "../../runtime/scope-context.ts";
import { buildSummary } from "../../runtime/summary-builder.ts";
import type { TurnExecutor } from "../../runtime/turn-executor.ts";
import type { RetrievalInput } from "../../types.ts";
import type { ConversationCitationService } from "../citations/service.ts";
import type { EmbedAuthContext } from "../middleware/authenticate.ts";

export type ConversationResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: EmbedError };

export interface ConversationServiceOptions {
	readonly repositories: PublishingRepositories;
	/** Turn 执行器（TASK-018 内部/测试路径；Realtime 通道建成后替换）。 */
	readonly turnExecutor: TurnExecutor;
	/**
	 * 会话级引用能力（TASK-032）。未提供 = Turn 不触发引用检索
	 * （RuntimeSpec 的 uploads 能力同时控制上传与引用）。
	 */
	readonly citations?: ConversationCitationService;
}

export interface CreateConversationInput {
	readonly principal: EmbedAuthContext;
	readonly title: string;
	/**
	 * WB-008: optional caller-supplied conversation id (from the
	 * rollover response of a previous create). When set, the new conversation
	 * is anchored to the previous one and inherits its app/version/owner.
	 * Server-side validation enforces that the previous conversation is
	 * owned by the same principal and currently `archived`.
	 */
	readonly previousConversationId?: ConversationId;
}

export interface CreateConversationResult {
	readonly conversation: ConversationRecord;
	readonly rollover: ConversationRollover;
}

export interface ListConversationsInput {
	readonly principal: EmbedAuthContext;
	/** 1..100；默认 20（spec 27.5）。 */
	readonly limit: number;
	/** 上一页返回的 opaque cursor。 */
	readonly cursor?: string;
}

export interface GetConversationInput {
	readonly principal: EmbedAuthContext;
	readonly conversationId: ConversationId;
}

export interface ListEventsInput extends GetConversationInput {
	/** 只返回 `sequence > afterSequence` 的增量事件。 */
	readonly afterSequence?: number;
	readonly limit: number;
}

export class ConversationService {
	private readonly repos: PublishingRepositories;
	private readonly turnExecutor: TurnExecutor;
	private readonly citations: ConversationCitationService | undefined;
	/** 进程内单写者守卫：同一 Conversation 同时最多一个 Turn（PD-13）。 */
	private readonly runningTurns = new Set<ConversationId>();

	constructor(options: ConversationServiceOptions) {
		this.repos = options.repositories;
		this.turnExecutor = options.turnExecutor;
		this.citations = options.citations;
	}

	/**
	 * 创建 Conversation 并固定到 Token claim 里的版本（spec 27.5 / WB-005 + WB-008）。
	 *
	 * 对于普通 principal, `principal.publishedAppVersionId` 等于
	 * `app.currentVersionId`（签 token 时填的）；对于
	 * `platform_admin_preview` principal, 它是 admin 想要预览的待上线版本。
	 * 这样 preview 会话**绝不会**跟 current 版本混用。
	 *
	 * WB-008: 当调用方传入 `previousConversationId` 时，服务端验证它是同一
	 * principal 当前已归档（rollover sealed）的会话，然后链上
	 * `previous_conversation_id`，并在返回里显式给出 `rollover` 信封，让
	 * 客户端不再靠错误文案判断是否发生续接。
	 */
	async createConversation(input: CreateConversationInput): Promise<ConversationResult<CreateConversationResult>> {
		const scope = ownerScope(input.principal);
		const app = await this.repos.publishedApps.get(
			{ tenantId: input.principal.tenantId, publishedAppId: input.principal.publishedAppId },
			input.principal.publishedAppId,
		);
		if (app === undefined) return { ok: false, error: appNotFound() };
		if (app.status !== "active") return { ok: false, error: appSuspended("App is not active") };
		const pinnedVersionId = input.principal.publishedAppVersionId;
		const version = await this.repos.publishedAppVersions.get(scope, pinnedVersionId);
		if (version === undefined || version.status !== "ready") return { ok: false, error: versionUnavailable() };

		// WB-008: validate the rollover anchor when supplied. The previous
		// conversation must belong to the same principal, be already sealed
		// (`archived`), and not have a successor yet. Cross-principal /
		// cross-app attempts are indistinguishable from "not found".
		let rolloverAnchor: {
			readonly previous: ConversationRecord;
			readonly summaryThroughSequence: number | null;
		} | null = null;
		if (input.previousConversationId !== undefined) {
			const previous = await this.repos.conversations.get(scope, input.previousConversationId);
			if (previous === undefined || previous.status !== "archived" || previous.nextConversationId !== null) {
				return { ok: false, error: conversationNotFound() };
			}
			rolloverAnchor = {
				previous,
				summaryThroughSequence: previous.latestSummarySequence > 0 ? previous.latestSummarySequence : null,
			};
		}

		const now = new Date();
		const record: ConversationRecord = {
			conversationId: newConversationId(),
			tenantId: input.principal.tenantId,
			publishedAppId: input.principal.publishedAppId,
			publishedAppVersionId: pinnedVersionId,
			ownerPrincipalId: input.principal.principalId,
			title: input.title,
			status: "active",
			lastEventSequence: 0,
			eventCount: 0,
			eventBytes: 0,
			turnCount: 0,
			latestSummarySequence: 0,
			previousConversationId: rolloverAnchor?.previous.conversationId ?? null,
			nextConversationId: null,
			rolledOverAt: null,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		};
		await this.repos.conversations.insert(record);

		if (rolloverAnchor !== null) {
			const sealed = await this.repos.conversations.sealForRollover(scope, rolloverAnchor.previous.conversationId, {
				nextConversationId: record.conversationId,
				atSequence: rolloverAnchor.previous.lastEventSequence,
			});
			if (!sealed) {
				// Concurrent rollover attempt by another request; surface the
				// same uniform "not found" error to the caller.
				return { ok: false, error: conversationNotFound() };
			}
			return {
				ok: true,
				data: {
					conversation: record,
					rollover: {
						conversationId: record.conversationId,
						rolledOver: true,
						previousConversationId: rolloverAnchor.previous.conversationId,
						rolledOverAtSequence: rolloverAnchor.previous.lastEventSequence,
						rolloverSummaryId: null,
					},
				},
			};
		}

		return {
			ok: true,
			data: {
				conversation: record,
				rollover: {
					conversationId: record.conversationId,
					rolledOver: false,
					previousConversationId: null,
					rolledOverAtSequence: null,
					rolloverSummaryId: null,
				},
			},
		};
	}

	/** 当前 Principal 的会话列表（opaque cursor 分页，仅 active）。 */
	async listConversations(input: ListConversationsInput): Promise<ConversationResult<ConversationListRow[]>> {
		const rows = await this.repos.conversations.list({
			scope: ownerScope(input.principal),
			limit: input.limit,
			cursor: input.cursor,
		});
		return { ok: true, data: rows };
	}

	/** 读取本人会话；越权/不存在统一 CONVERSATION_NOT_FOUND。 */
	async getConversation(input: GetConversationInput): Promise<ConversationResult<ConversationRecord>> {
		const record = await this.repos.conversations.get(ownerScope(input.principal), input.conversationId);
		if (record === undefined) return { ok: false, error: conversationNotFound() };
		return { ok: true, data: record };
	}

	/** 恢复会话事件（sequence 升序，增量回放）。 */
	async listEvents(input: ListEventsInput): Promise<ConversationResult<ConversationEventRecord[]>> {
		const record = await this.repos.conversations.get(ownerScope(input.principal), input.conversationId);
		if (record === undefined) return { ok: false, error: conversationNotFound() };
		const events = await this.repos.events.list(ownerScope(input.principal), input.conversationId, {
			limit: input.limit,
			afterSequence: input.afterSequence,
		});
		return { ok: true, data: events };
	}

	/** 归档本人会话（active -> archived）。 */
	async archiveConversation(input: GetConversationInput): Promise<ConversationResult<ConversationRecord>> {
		const record = await this.repos.conversations.get(ownerScope(input.principal), input.conversationId);
		if (record === undefined) return { ok: false, error: conversationNotFound() };
		if (record.status === "active") {
			await this.repos.conversations.updateStatus(ownerScope(input.principal), input.conversationId, "archived");
			// WB-007: 归档本身是事实变化，持久化 conversation/archived。
			await this.safeAppend(ownerScope(input.principal), input.conversationId, {
				eventType: "conversation/archived",
				payload: { reason: "user_archived" },
			});
		}
		const updated = await this.repos.conversations.get(ownerScope(input.principal), input.conversationId);
		return { ok: true, data: updated ?? record };
	}

	/**
	 * WB-007: write one event without taking down the calling request. The
	 * authoritative state lives in the conversation row, so a failed append
	 * here only loses a side-channel observation — we never throw to the
	 * caller for a background log failure. Returns `undefined` if the row
	 * could not be written.
	 */
	private async safeAppend(
		scope: OwnerScope,
		conversationId: ConversationId,
		input: Omit<ConversationEventInput, "conversationId">,
	): Promise<ConversationEventRecord | undefined> {
		try {
			return await this.repos.events.append(scope, { ...input, conversationId });
		} catch {
			return undefined;
		}
	}

	/** WB-007: enforce the per-payload byte ceiling + sensitive-field guard. */
	private safePayload(payload: unknown, byteLimit: number): unknown {
		try {
			assertEventPayloadSafe(payload, { byteLimit });
			return payload;
		} catch {
			// Truncate / redact to a safe placeholder so a single oversized
			// payload never aborts the surrounding Turn execution.
			return { truncated: true, originalBytes: Buffer.byteLength(JSON.stringify(payload), "utf8") };
		}
	}

	/** 读取持久事件并恢复上下文（TASK-022）；in-flight turn 收敛为 interrupted。 */
	private async restoreHistory(
		scope: OwnerScope,
		conversationId: ConversationId,
		spec: RuntimeSpec,
	): Promise<RestoredContext> {
		// WB-007 + WB-008: pass the configured log level so restoreContext
		// can report dropped chunks accurately. When a summary exists, we
		// only replay events after `throughSequence` so the rebuilt context
		// window is bounded (spec §12.1).
		const summary = await this.repos.summaries.getLatest(scope, conversationId);
		const afterSequence = summary?.throughSequence ?? 0;
		const events = await this.repos.events.list(scope, conversationId, {
			limit: 10_000,
			afterSequence,
		});
		const restored = restoreContext(
			events,
			{ maxContextTokens: spec.contextPolicy.maxContextTokens },
			spec.contextPolicy.logLevel,
		);
		// Prepend the summary body as a synthetic system-style message so the
		// next Turn sees the condensed history without burning tokens on the
		// raw events we've already collapsed.
		if (summary !== undefined) {
			const summaryMessage = {
				messages: [
					{
						role: "user" as const,
						text: `[prior conversation summary through sequence ${summary.throughSequence}]\n${(summary.body as { text?: string }).text ?? ""}`,
					},
					{
						role: "assistant" as const,
						text: `Understood. I will continue from summary ${summary.id}.`,
					},
				],
				interruptedTurnIds: [] as string[],
				skippedEvents: 0,
				droppedChunks: 0,
				errorEventCount: 0,
				observedLogLevel: spec.contextPolicy.logLevel,
			};
			return mergeRestored(summaryMessage, restored);
		}
		for (const turnId of restored.interruptedTurnIds) {
			await this.safeAppend(scope, conversationId, {
				eventType: "turn/interrupted",
				turnId: turnId as TurnId,
				payload: { reason: "interrupted_at_restart" },
			});
		}
		return restored;
	}

	/**
	 * TASK-032：会话级引用检索。RuntimeSpec（capabilities.uploads）控制是否
	 * 启用；检索只考虑本会话 ready 附件的 sources（引用结果只含当前会话
	 * 授权来源，跨会话/越权一律不可见）。无引用返回 undefined（Turn 不带
	 * retrieval，与未配置引用能力时行为一致）。
	 */
	private async prepareRetrieval(
		scope: OwnerScope,
		spec: RuntimeSpec,
		input: ExecuteTurnInput,
		turnId: TurnId,
	): Promise<RetrievalInput | undefined> {
		const citations = this.citations;
		if (citations === undefined || !citations.citationsEnabled(spec)) return undefined;
		const conversationScope: ConversationScope = { ...scope, conversationId: input.conversationId };
		const result = await citations.retrieveForTurn(conversationScope, input.text, turnId);
		if (result.citations.length === 0) return undefined;
		return { context: result.context, reference: result.reference, citations: result.citations };
	}

	/**
	 * 同步执行一个文本 Turn（TASK-018 internal/dev 路径，spec 18 + WB-007）。
	 *
	 * 持久化顺序：
	 *
	 *   1. `turn/start`              — 记录 Turn 起点与 RuntimeSpec hash
	 *   2. `user/message`            — 用户输入（payload 安全校验后写入）
	 *   3. `assistant/message`       — 成功路径：最终 assistant 输出
	 *   4. `turn/end`                — 成功路径
	 *   失败路径：`turn/failed` 单独写入；中断收敛由 `restoreHistory` 写 `turn/interrupted`。
	 *   流式 chunk / tool.* / attachment.* / citation.* 按 logLevel 决定是否落盘。
	 *
	 * 进程内单写者守卫使同一 Conversation 并发 Turn 返回 TURN_ALREADY_RUNNING
	 * （PD-13）。事件与 sequence 递增同事务（TASK-008），重启后可从持久事件
	 * 恢复历史。
	 */
	async executeTurn(input: ExecuteTurnInput): Promise<ConversationResult<ExecuteTurnData>> {
		const scope = ownerScope(input.principal);
		const record = await this.repos.conversations.get(scope, input.conversationId);
		if (record === undefined || record.status !== "active") return { ok: false, error: conversationNotFound() };
		// 单写者守卫：has 检查与 add 之间无 await（事件循环内原子），并发
		// 请求只有一个能进入执行段（PD-13）。
		if (this.runningTurns.has(input.conversationId)) return { ok: false, error: turnAlreadyRunning() };
		this.runningTurns.add(input.conversationId);
		// Agent V2 M1：PI_AGENT_V2_METRICS 关闭时不采集。开启时在 turn 开始时取一次
		// 单调+墙上基准，供 turn/end / turn/failed 写入 TurnMetrics。
		const metricsTiming = agentV2MetricsEnabled() ? startTurnTiming() : undefined;
		try {
			const version = await this.repos.publishedAppVersions.get(scope, record.publishedAppVersionId);
			if (version === undefined) return { ok: false, error: versionUnavailable() };
			const parsed = parseRuntimeSpec(version.runtimeSpec);
			if (!parsed.ok) return { ok: false, error: runtimeUnavailable("RuntimeSpec is invalid") };
			const spec = parsed.spec;
			// spec 26.4：读取时重算 RuntimeSpec hash，不一致拒绝启动 Runtime。
			if (version.runtimeSpecHash !== null && sha256Hex(canonicalJson(spec)) !== version.runtimeSpecHash) {
				return { ok: false, error: runtimeUnavailable("RuntimeSpec hash mismatch") };
			}

			// TASK-022：从持久事件恢复上下文（只恢复已完成对）；in-flight turn
			// 收敛为 turn.interrupted（幂等：已收敛的事件会终止对应 pending）。
			const history = await this.restoreHistory(scope, input.conversationId, spec);

			const turnId = newTurnId();
			const logLevel: SessionLogLevel = spec.contextPolicy.logLevel;
			const turnScope: ScopeContext = {
				tenantId: input.principal.tenantId,
				publishedAppId: input.principal.publishedAppId,
				publishedAppVersionId: record.publishedAppVersionId,
				principalId: input.principal.principalId,
				conversationId: input.conversationId,
				turnId,
				limits: {
					maxTurns: spec.contextPolicy.maxTurns,
					maxContextTokens: spec.contextPolicy.maxContextTokens,
					toolResultMaxBytes: spec.contextPolicy.toolResultMaxBytes,
					turnTimeoutMs: spec.runtimePolicy.turnTimeoutMs,
					maxConcurrentTurnsPerConversation: spec.runtimePolicy.maxConcurrentTurnsPerConversation,
				},
			};

			const turnStart = await this.safeAppend(scope, input.conversationId, {
				eventType: "turn/start",
				turnId,
				payload: { model: spec.agent.model.modelId, logLevel },
			});
			if (turnStart === undefined) return { ok: false, error: conversationNotFound() };

			// TASK-032：先计算会话级引用检索（RuntimeSpec 门控），使上下文快照能覆盖
			// retrieval context。这里只做检索，不落事件；citation/updated 仍在 user/message
			// 之后落（保持既有事件顺序）。
			const retrieval = await this.prepareRetrieval(scope, spec, input, turnId);

			// Agent V2 M1：写上下文快照（turn/start 之后、user/message 之前，符合契约顺序）。
			// 开关关（默认）不采集；开时用 chars→tokens 估算为 `ContextUsageSnapshot`。
			// 快照覆盖最终请求上下文：system prompt + 已恢复历史 + 当前用户消息 + retrieval。
			if (metricsTiming !== undefined) {
				const conversationMessagesText = [...history.messages.map((m) => m.text), input.text].join("\n");
				const snapshot = estimateContextSnapshot({
					contextWindow: spec.contextPolicy.maxContextTokens,
					systemPromptText: spec.agent.systemPrompt,
					conversationMessagesText,
					retrievalContextText: retrieval?.context,
					toolDefinitionsText: spec.capabilities.tools.map((t) => JSON.stringify(t)).join("\n"),
				});
				const snapshotAppended = await this.safeAppend(scope, input.conversationId, {
					eventType: "context/snapshot",
					turnId,
					payload: { snapshot },
				});
				if (snapshotAppended === undefined) return { ok: false, error: conversationNotFound() };
			}

			const userEvent = await this.repos.events.append(scope, {
				conversationId: input.conversationId,
				eventType: "user/message",
				turnId,
				payload: this.safePayload({ text: input.text }, 64 * 1024),
			});
			if (userEvent === undefined) return { ok: false, error: conversationNotFound() };

			if (retrieval !== undefined) {
				await this.safeAppend(scope, input.conversationId, {
					eventType: "citation/updated",
					turnId,
					payload: {
						count: retrieval.citations.length,
						// WB-007: only metadata, never raw context strings; the
						// full citation object is sent to the client once and
						// never persisted (HANDOFF note).
						reference: retrieval.reference,
					},
				});
			}

			// Agent V2 M1：捕获 provider 开始（同步执行器=模型请求开始）与终态时点。
			// 同步执行器不产生“首个可展示文本”的独立时点（无流式增量），故
			// firstOutput=null → ttft/generation/tps 均为 null，绝不把“整个同步
			// 请求完成时间”当作真实 TTFT 混入聚合；totalLatencyMs 仍有效值。
			const providerStartAtMs = metricsTiming === undefined ? undefined : performance.now();
			const result = await this.turnExecutor({ scope: turnScope, spec, text: input.text, history, retrieval });
			const completedAtMs = metricsTiming === undefined ? undefined : performance.now();
			let turnMetrics: TurnMetrics | undefined;
			if (metricsTiming !== undefined && providerStartAtMs !== undefined && completedAtMs !== undefined) {
				turnMetrics = buildTurnMetrics({
					outcome: result.ok ? "success" : "failed",
					base: metricsTiming,
					events: { providerStartAtMs, firstOutputAtMs: null, completedAtMs },
					usage: usageCountsFromProtocolUsage(result.ok ? result.usage : undefined),
				});
			}
			if (result.ok) {
				// WB-007: write the final assistant message at the standard
				// level regardless of log level; this is the authoritative
				// payload restored by `context-restore`. Streaming chunks
				// would have been written before this point in a streaming
				// path; the sync executor only emits the final message.
				const completed = await this.safeAppend(scope, input.conversationId, {
					eventType: "assistant/message",
					turnId,
					payload: { text: result.outputText },
				});
				// First-chunk / last-chunk pseudo events to honour the
				// `diagnostic` log level (only when the executor exposes any
				// streamed text). The actual streaming events would be
				// written by a Realtime path; here we only have a final
				// text, so a single milestone is enough to advertise the
				// observed log level to restoreContext.
				if (logLevel !== "standard") {
					const sample = { ordinal: 1, isFirst: true, isLast: true };
					if (shouldPersistAssistantChunk(logLevel, sample)) {
						await this.safeAppend(scope, input.conversationId, {
							eventType: "assistant/chunk",
							turnId,
							payload: { text: result.outputText.slice(0, 256), ordinal: 1, isFirst: true, isLast: true },
						});
					}
				}
				await this.safeAppend(scope, input.conversationId, {
					eventType: "turn/end",
					turnId,
					payload: {
						ok: true,
						...(result.usage ? { usage: result.usage } : {}),
						...(turnMetrics ? { metrics: turnMetrics } : {}),
					},
				});
				// WB-008: post-turn rollover check. Re-read the conversation
				// row so the freshly-advanced counters reflect the events we
				// just appended (turn_start..turn_end). The rollover itself
				// is not performed in-line — callers observe the next
				// `createConversation` call's `rolledOver: true` response.
				const updated = await this.repos.conversations.get(scope, input.conversationId);
				if (updated !== undefined) {
					const decision = await tryRolloverIfNeeded(this.repos, scope, updated);
					if (decision.shouldRollover) {
						await this.safeAppend(scope, input.conversationId, {
							eventType: "conversation/rollover",
							turnId: null,
							payload: {
								atSequence: decision.atSequence,
								summaryId: decision.summaryId,
								reason: "limits_reached",
							},
						});
					}
				}
				return {
					ok: true,
					data: {
						turnId,
						userMessageSequence: userEvent.sequence,
						assistantSequence: completed?.sequence ?? null,
						outputText: result.outputText,
						// TASK-033：本 turn 实际使用的引用（citation.updated 事件的
						// 数据来源；无检索时为 []）。仅传输，不持久化（HANDOFF 记录）。
						citations: retrieval?.citations ?? [],
					},
				};
			}
			await this.safeAppend(scope, input.conversationId, {
				eventType: "turn/failed",
				turnId,
				payload: { error: result.error, ...(turnMetrics ? { metrics: turnMetrics } : {}) },
			});
			return { ok: false, error: runtimeUnavailable(`Turn failed: ${result.error}`) };
		} finally {
			this.runningTurns.delete(input.conversationId);
		}
	}
}

export interface ExecuteTurnInput {
	readonly principal: EmbedAuthContext;
	readonly conversationId: ConversationId;
	readonly text: string;
}

export interface ExecuteTurnData {
	readonly turnId: TurnId;
	readonly userMessageSequence: number;
	readonly assistantSequence: number | null;
	readonly outputText: string;
	/** 本 turn 实际使用的引用（TASK-033；无检索为空数组）。 */
	readonly citations: readonly Citation[];
}

function ownerScope(principal: EmbedAuthContext) {
	return {
		tenantId: principal.tenantId,
		publishedAppId: principal.publishedAppId,
		principalId: principal.principalId,
	};
}

/** WB-008: merge the synthetic summary header with the post-summary events. */
function mergeRestored(summary: RestoredContext, recent: RestoredContext): RestoredContext {
	return {
		messages: [...summary.messages, ...recent.messages],
		interruptedTurnIds: [...summary.interruptedTurnIds, ...recent.interruptedTurnIds],
		skippedEvents: summary.skippedEvents + recent.skippedEvents,
		droppedChunks: summary.droppedChunks + recent.droppedChunks,
		errorEventCount: summary.errorEventCount + recent.errorEventCount,
		observedLogLevel: recent.observedLogLevel === "standard" ? summary.observedLogLevel : recent.observedLogLevel,
	};
}

/** WB-008: hard limit evaluator (operator-tunable defaults). */
function resolveLimits(): typeof DEFAULT_CONVERSATION_LIMITS {
	return DEFAULT_CONVERSATION_LIMITS;
}

/** WB-008: maybe rollover helper used after a successful turn end. */
async function tryRolloverIfNeeded(
	repos: PublishingRepositories,
	scope: OwnerScope,
	record: ConversationRecord,
): Promise<{
	readonly shouldRollover: boolean;
	readonly summaryId: string | null;
	readonly atSequence: number;
}> {
	if (
		!shouldRolloverConversation(
			{
				eventCount: record.eventCount,
				eventBytes: record.eventBytes,
				turnCount: record.turnCount,
			},
			resolveLimits(),
		)
	) {
		return { shouldRollover: false, summaryId: null, atSequence: record.lastEventSequence };
	}
	// Build + persist summary at the current tail; we use the same events
	// the next conversation will need to seed itself.
	const events = await repos.events.list(scope, record.conversationId, {
		limit: 10_000,
		afterSequence: 0,
	});
	const built = buildSummary(events);
	const summaryRecord = {
		id: newConversationSummaryId(),
		tenantId: record.tenantId,
		publishedAppId: record.publishedAppId,
		ownerPrincipalId: record.ownerPrincipalId,
		conversationId: record.conversationId,
		throughSequence: built.throughSequence,
		modelId: "(deterministic-summary)",
		sourceEventCount: built.sourceEventCount,
		sourceBytes: built.sourceBytes,
		body: built.body,
		createdAt: new Date(),
	};
	const inserted = await repos.summaries.insert(scope, summaryRecord);
	const summaryId = inserted.outcome === "inserted" ? summaryRecord.id : null;
	if (inserted.outcome === "inserted") {
		await repos.conversations.updateLatestSummarySequence(scope, record.conversationId, built.throughSequence);
	}
	return {
		shouldRollover: true,
		summaryId,
		atSequence: record.lastEventSequence,
	};
}

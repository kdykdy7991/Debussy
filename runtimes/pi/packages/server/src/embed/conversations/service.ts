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
import type {
	Citation,
	ConversationPublicId,
	ConversationReasoningState,
	ConversationRollover,
	ReasoningUpdateRequest,
	SessionLogLevel,
	ToolTranscriptItem,
	TranscriptProgress,
	TurnMetrics,
} from "@earendil-works/pi-protocol";
import {
	assertEventPayloadSafe,
	DEFAULT_CONVERSATION_LIMITS,
	shouldPersistAssistantChunk,
	shouldRolloverConversation,
} from "@earendil-works/pi-protocol";
import { estimateContextSnapshot } from "../../agent-v2/context.ts";
import { agentV2MetricsEnabled } from "../../agent-v2/feature-flag.ts";
import { applyConversationReasoning, reasoningCapabilitiesForVersion } from "../../agent-v2/reasoning.ts";
import { buildTurnMetrics, startTurnTiming, usageCountsFromProtocolUsage } from "../../agent-v2/turn-metrics.ts";
import {
	appNotFound,
	appSuspended,
	conversationNotFound,
	EmbedError,
	runtimeUnavailable,
	turnAlreadyRunning,
	versionUnavailable,
} from "../../publishing/domain/errors.ts";
import {
	type ConversationId,
	newConversationId,
	newConversationSummaryId,
	newTurnId,
	type RequestId,
	type TurnId,
	toPublicId,
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

/**
 * P2 public-chat resume decision (spec: 恢复旧 Conversation).
 *   - version == current && active          → `resumed: true`   (continue same)
 *   - active but version stale vs current   → roll forward to a NEW conversation
 *     on the CURRENT version; the old conversation is kept untouched as history
 *     (`previousConversationId` points at it, `resumed: false`).
 */
export type ResumeConversationResult =
	| {
			readonly resumed: true;
			readonly conversation: ConversationRecord;
			readonly previousConversationId: null;
	  }
	| {
			readonly resumed: false;
			readonly conversation: ConversationRecord;
			readonly previousConversationId: ConversationId;
	  };

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
		const isDraftPreview = app.status === "draft" && input.principal.principalType === "platform_admin_preview";
		if (app.status !== "active" && !isDraftPreview) {
			return { ok: false, error: appSuspended("App is not active") };
		}
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

	/**
	 * P2 public-chat resume-or-roll-forward. When the requested conversation's
	 * pinned version is still the app's CURRENT version and the conversation is
	 * `active`, it is resumed unchanged. When the version went stale (the Agent
	 * was republished), a brand-new conversation is created on the CURRENT
	 * version and the old one is preserved untouched (never deleted) — resumed
	 * renderers that follow the "latest live version" rule then never show a
	 * stale-version conversation in the active surface. A stale conversation
	 * that the caller owns is always the roll-forward source; a non-current,
	 * non-owner, or suspended app surfaces the same uniform errors as create.
	 */
	async resumeOrRollForward(input: GetConversationInput): Promise<ConversationResult<ResumeConversationResult>> {
		const scope = ownerScope(input.principal);
		const record = await this.repos.conversations.get(scope, input.conversationId);
		if (record === undefined) return { ok: false, error: conversationNotFound() };
		const app = await this.repos.publishedApps.get(
			{ tenantId: record.tenantId, publishedAppId: record.publishedAppId },
			record.publishedAppId,
		);
		if (app === undefined) return { ok: false, error: appNotFound() };
		if (record.status === "active" && app.currentVersionId === record.publishedAppVersionId) {
			return { ok: true, data: { resumed: true, conversation: record, previousConversationId: null } };
		}
		// Roll forward: current version must exist, be ready and the app active.
		if (app.status !== "active") return { ok: false, error: appSuspended("App is not active") };
		const currentVersionId = app.currentVersionId;
		if (currentVersionId === null) return { ok: false, error: versionUnavailable() };
		const version = await this.repos.publishedAppVersions.get(scope, currentVersionId);
		if (version === undefined || version.status !== "ready") return { ok: false, error: versionUnavailable() };
		const now = new Date();
		const fresh: ConversationRecord = {
			conversationId: newConversationId(),
			tenantId: record.tenantId,
			publishedAppId: record.publishedAppId,
			publishedAppVersionId: currentVersionId,
			ownerPrincipalId: record.ownerPrincipalId,
			title: record.title,
			status: "active",
			lastEventSequence: 0,
			eventCount: 0,
			eventBytes: 0,
			turnCount: 0,
			latestSummarySequence: 0,
			previousConversationId: null,
			nextConversationId: null,
			rolledOverAt: null,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		};
		await this.repos.conversations.insert(fresh);
		return {
			ok: true,
			data: { resumed: false, conversation: fresh, previousConversationId: record.conversationId },
		};
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
	 * PUT conversation reasoning effort (Agent V2 §4.3, embed owner surface).
	 * Reuses the shared reasoning apply (frozen capability + transactional
	 * fact-source + audit). The conversation is resolved via the embed
	 * principal's owner scope: a non-owner or cross-app reference yields a
	 * uniform CONVERSATION_NOT_FOUND (404).
	 */
	async setConversationReasoning(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
		readonly request: ReasoningUpdateRequest;
		readonly configurable?: boolean;
		readonly requestId?: RequestId;
	}): Promise<ConversationResult<ConversationReasoningState>> {
		const record = await this.repos.conversations.get(ownerScope(input.principal), input.conversationId);
		if (record === undefined) return { ok: false, error: conversationNotFound() };
		const result = await applyConversationReasoning({
			repos: this.repos,
			tenantId: input.principal.tenantId,
			publishedAppId: input.principal.publishedAppId,
			publishedAppVersionId: record.publishedAppVersionId,
			ownerPrincipalId: record.ownerPrincipalId,
			conversationId: input.conversationId,
			request: input.request,
			principal: { type: "embed-owner", id: input.principal.principalId },
			configurable: input.configurable !== false,
			requestId: input.requestId,
		});
		if (!result.ok) return { ok: false, error: new EmbedError(result.code, result.message) };
		return { ok: true, data: result.data };
	}

	/**
	 * GET conversation reasoning effort (Agent V2 §4.3, embed owner surface).
	 * Reads the dedicated fact source `conversation_reasoning_state` and the
	 * conversation's PINNED published version capability (frozen at publish
	 * time, not the live LLM catalog). This is the recover path for the
	 * "刷新/重连可恢复" requirement: a fresh reload restores the current
	 * override from here. Resolution is via the embed owner scope, so a
	 * non-owner or cross-app reference yields a uniform CONVERSATION_NOT_FOUND
	 * (404) like every other embed conversation operation.
	 */
	async getConversationReasoning(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
	}): Promise<ConversationResult<ConversationReasoningState>> {
		const scope = ownerScope(input.principal);
		const record = await this.repos.conversations.get(scope, input.conversationId);
		if (record === undefined) return { ok: false, error: conversationNotFound() };
		const state = await this.repos.conversationReasoning.get(scope, input.conversationId);
		const pinnedCapability = await reasoningCapabilitiesForVersion(
			this.repos,
			{ tenantId: record.tenantId, publishedAppId: record.publishedAppId },
			record.publishedAppVersionId,
		);
		return {
			ok: true,
			data: {
				conversationId: toPublicId("ConversationId", input.conversationId) as ConversationPublicId,
				effort: state?.effort ?? null,
				updatedAt: (state?.updatedAt ?? record.lastActiveAt).toISOString(),
				configurable: pinnedCapability !== null,
				pinnedCapability,
			},
		};
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

	/**
	 * TURN-TASK：把 Tool 进度持久化为 tool/call / tool/result / tool/error 事件
	 * （均带 turnId + toolCallId + toolName + toolType + 状态 + 时间戳）。这样凭
	 * conversationId + turnId 可完整还原该 Turn 的每次 tool/MCP/skill 调用。
	 * 写失败仅丢失旁路观察，不阻断 Turn（WB-007）。不新建 tool_runs 表，
	 * 沿用现有 Conversation Event Stream。
	 */
	private async persistToolProgress(
		scope: OwnerScope,
		conversationId: ConversationId,
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
			// 运行态启动：落 tool/call（仅当 item 仍为 running）。
			if (item.status !== "running") return;
			await this.safeAppend(scope, conversationId, {
				eventType: "tool/call",
				turnId,
				payload: { ...base, status: "running", startedAt: item.timestamp },
			});
			return;
		}
		if (progressType === "item_updated") return;
		// item_finished：complete -> tool/result；error -> tool/error。
		if (item.status === "complete") {
			await this.safeAppend(scope, conversationId, {
				eventType: "tool/result",
				turnId,
				payload: { ...base, status: "complete", finishedAt: item.timestamp },
			});
		} else if (item.status === "error") {
			await this.safeAppend(scope, conversationId, {
				eventType: "tool/error",
				turnId,
				payload: { ...base, status: "error", error: deriveToolError(item), finishedAt: item.timestamp },
			});
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
			// TURN-TASK：Turn 配置快照需要 agentId（App 归属的 AgentDefinition）。
			// 读失败仅省略该字段（用于历史追溯，非执行必需），不阻断 Turn。
			const agentId = (await this.repos.publishedApps.get(scope, record.publishedAppId))?.agentDefinitionId;
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

			// TURN-TASK：优先采用调用方（Realtime connection）预生成的 turnId，
			// 使 turn 内所有事件（含 realtime 转发）共享同一 turnId，不依赖
			// "当前连接只运行一个 Turn"；缺省时服务端自生成。
			const turnId = input.turnId ?? newTurnId();
			const logLevel: SessionLogLevel = spec.contextPolicy.logLevel;
			// Agent V2 §4.3：会话级 reasoning effort 覆盖（事实源；缺省=Revision 默认）。
			const conversationReasoning = await this.repos.conversationReasoning.get(scope, input.conversationId);
			const turnScope: ScopeContext = {
				tenantId: input.principal.tenantId,
				publishedAppId: input.principal.publishedAppId,
				publishedAppVersionId: record.publishedAppVersionId,
				principalId: input.principal.principalId,
				conversationId: input.conversationId,
				requestId: input.requestId,
				turnId,
				conversationEffort: conversationReasoning?.effort ?? null,
				limits: {
					maxTurns: spec.contextPolicy.maxTurns,
					maxContextTokens: spec.contextPolicy.maxContextTokens,
					toolResultMaxBytes: spec.contextPolicy.toolResultMaxBytes,
					turnTimeoutMs: spec.runtimePolicy.turnTimeoutMs,
					maxConcurrentTurnsPerConversation: spec.runtimePolicy.maxConcurrentTurnsPerConversation,
				},
			};

			// TURN-TASK：turn/start 固化该 Turn 实际使用的 Agent 配置——agentId
			// （App 归属）、agentRevisionId（版本来源 revision）、runtimeSpecHash
			// （防混淆）、model。均取自 version/app 记录，不从会话当前状态反推；
			// 凭 runtimeSpecHash 可恢复完整 RuntimeSpec，故不重复存整个 spec。
			const turnStart = await this.safeAppend(scope, input.conversationId, {
				eventType: "turn/start",
				turnId,
				payload: {
					model: spec.agent.model.modelId,
					logLevel,
					agentRevisionId: version.sourceAgentRevision,
					...(version.runtimeSpecHash !== null ? { runtimeSpecHash: version.runtimeSpecHash } : {}),
					...(agentId !== undefined ? { agentId } : {}),
				},
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

			// Agent V2 M1：捕获 provider 开始与终态时点。真实首增量指标后续由
			// metrics collector 接入 onProgress；这里仍不以整个请求完成时间伪造 TTFT。
			const providerStartAtMs = metricsTiming === undefined ? undefined : performance.now();
			// TURN-TASK：onProgress 同时转发给调用方并持久化 tool 进度——Tool/MCP/Skill
			// 归属到本 turn（带 turnId + toolCallId + toolName + toolType + 状态 +
			// 时间戳），复用既有事件流模型（tool/call|result|error），不新增表。
			const onProgress: ExecuteTurnInput["onProgress"] = (progress) => {
				input.onProgress?.(progress);
				if (progress.type === "assistant_delta") return;
				if (progress.item.role !== "tool") return;
				void this.persistToolProgress(scope, input.conversationId, turnId, spec, progress.type, progress.item);
			};
			const result = await this.turnExecutor({
				scope: turnScope,
				spec,
				text: input.text,
				history,
				retrieval,
				onProgress,
			});
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
				// payload restored by `context-restore`. Runtime 增量已通过
				// onProgress 实时传输，最终消息仍是恢复时的权威事实。
				const completed = await this.safeAppend(scope, input.conversationId, {
					eventType: "assistant/message",
					turnId,
					payload: {
						text: result.outputText,
						...(result.thinkingText ? { thinking: result.thinkingText } : {}),
					},
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
						...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
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

	/**
	 * 中止当前会话正在执行的 Turn。先按 owner scope 校验，避免通过取消接口
	 * 枚举会话；只有底层执行器实际接受中止时才报告 cancelled。
	 */
	async cancelTurn(input: GetConversationInput): Promise<ConversationResult<{ readonly cancelled: boolean }>> {
		const scope = ownerScope(input.principal);
		const record = await this.repos.conversations.get(scope, input.conversationId);
		if (record === undefined || record.status !== "active") return { ok: false, error: conversationNotFound() };
		if (!this.runningTurns.has(input.conversationId)) return { ok: true, data: { cancelled: false } };
		if (this.turnExecutor.cancel === undefined) {
			return { ok: false, error: runtimeUnavailable("Turn cancellation is unavailable") };
		}
		return { ok: true, data: { cancelled: await this.turnExecutor.cancel(input.conversationId) } };
	}
}

export interface ExecuteTurnInput {
	readonly principal: EmbedAuthContext;
	readonly conversationId: ConversationId;
	readonly requestId?: RequestId;
	readonly text: string;
	/** TURN-TASK：由调用方（Realtime connection）预生成的 turnId；缺省自生成。 */
	readonly turnId?: TurnId;
	readonly onProgress?: (progress: TranscriptProgress) => void;
}

export interface ExecuteTurnData {
	readonly turnId: TurnId;
	readonly userMessageSequence: number;
	readonly assistantSequence: number | null;
	readonly outputText: string;
	readonly thinkingText?: string;
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

/** TURN-TASK：按 Tool 名推断其归属类型（skill > mcp > builtin），用于 tool 事件归属。 */
import { deriveToolType } from "../../publishing/runtime/tool-type.ts";

/** TURN-TASK：从 error tool item 的文本 content 提取错误信息；缺省给占位串。 */
function deriveToolError(item: ToolTranscriptItem): string {
	if (item.status !== "error") return "tool error";
	for (const part of item.content) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "tool error";
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

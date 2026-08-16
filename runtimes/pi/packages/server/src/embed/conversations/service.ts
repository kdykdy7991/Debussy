/**
 * Conversation 服务（spec 27.5 / 8.2，TASK-016）。
 *
 * 创建时由服务端从 App 的 currentVersion 读取版本并事务性固定——客户端
 * 绝不能提交 `publishedAppVersionId` 或 `ownerPrincipalId`（禁止继续条件）。
 * 所有操作都以 `EmbedAuthContext`（来自 Access Token）为 scope 走作用域
 * 安全 Repository：A/B 用户、跨 App、越权一律表现为统一不可用
 * （CONVERSATION_NOT_FOUND），不做 ID 枚举。
 *
 * App 停用（PD-04）：suspended 后禁止新建 Conversation，已建会话仍可按
 * 策略读取/归档（读取由外层策略决定，MVP 允许本人读取历史）。
 */
import {
	appNotFound,
	appSuspended,
	conversationNotFound,
	type EmbedError,
	runtimeUnavailable,
	turnAlreadyRunning,
	versionUnavailable,
} from "../../publishing/domain/errors.ts";
import { type ConversationId, newConversationId, newTurnId, type TurnId } from "../../publishing/domain/ids.ts";
import type {
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

	/** 创建 Conversation 并固定当前版本（spec 27.5）。 */
	async createConversation(input: CreateConversationInput): Promise<ConversationResult<ConversationRecord>> {
		const scope = ownerScope(input.principal);
		const app = await this.repos.publishedApps.get(
			{ tenantId: input.principal.tenantId, publishedAppId: input.principal.publishedAppId },
			input.principal.publishedAppId,
		);
		if (app === undefined) return { ok: false, error: appNotFound() };
		if (app.status !== "active") return { ok: false, error: appSuspended("App is not active") };
		if (app.currentVersionId === null) return { ok: false, error: versionUnavailable() };
		const version = await this.repos.publishedAppVersions.get(scope, app.currentVersionId);
		if (version === undefined || version.status !== "ready") return { ok: false, error: versionUnavailable() };

		const now = new Date();
		const record: ConversationRecord = {
			conversationId: newConversationId(),
			tenantId: input.principal.tenantId,
			publishedAppId: input.principal.publishedAppId,
			publishedAppVersionId: app.currentVersionId,
			ownerPrincipalId: input.principal.principalId,
			title: input.title,
			status: "active",
			lastEventSequence: 0,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		};
		await this.repos.conversations.insert(record);
		return { ok: true, data: record };
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
		}
		const updated = await this.repos.conversations.get(ownerScope(input.principal), input.conversationId);
		return { ok: true, data: updated ?? record };
	}

	/** 读取持久事件并恢复上下文（TASK-022）；in-flight turn 收敛为 interrupted。 */
	private async restoreHistory(
		scope: OwnerScope,
		conversationId: ConversationId,
		spec: RuntimeSpec,
	): Promise<RestoredContext> {
		const events = await this.repos.events.list(scope, conversationId, { limit: 10_000, afterSequence: 0 });
		const restored = restoreContext(events, { maxContextTokens: spec.contextPolicy.maxContextTokens });
		for (const turnId of restored.interruptedTurnIds) {
			await this.repos.events.append(scope, {
				conversationId,
				eventType: "turn.interrupted",
				turnId: turnId as TurnId,
				payload: { reason: "interrupted" },
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
	 * 同步执行一个文本 Turn（TASK-018 internal/dev 路径，spec 18）。
	 *
	 * 持久化 user.message -> 执行 TurnExecutor -> 持久化 assistant.completed
	 * （失败持久化 turn.failed）；进程内单写者守卫使同一 Conversation 并发
	 * Turn 返回 TURN_ALREADY_RUNNING（PD-13）。事件与 sequence 递增同事务
	 * （TASK-008），重启后可从持久事件恢复历史。
	 */
	async executeTurn(input: ExecuteTurnInput): Promise<ConversationResult<ExecuteTurnData>> {
		const scope = ownerScope(input.principal);
		const record = await this.repos.conversations.get(scope, input.conversationId);
		if (record === undefined || record.status !== "active") return { ok: false, error: conversationNotFound() };
		// 单写者守卫：has 检查与 add 之间无 await（事件循环内原子），并发
		// 请求只有一个能进入执行段（PD-13）。
		if (this.runningTurns.has(input.conversationId)) return { ok: false, error: turnAlreadyRunning() };
		this.runningTurns.add(input.conversationId);
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

			const userEvent = await this.repos.events.append(scope, {
				conversationId: input.conversationId,
				eventType: "user.message",
				turnId,
				payload: { text: input.text },
			});
			if (userEvent === undefined) return { ok: false, error: conversationNotFound() };

			// TASK-032：会话级引用检索（RuntimeSpec 门控），注入 retrieval。
			const retrieval = await this.prepareRetrieval(scope, spec, input, turnId);

			const result = await this.turnExecutor({ scope: turnScope, spec, text: input.text, history, retrieval });
			if (result.ok) {
				const completed = await this.repos.events.append(scope, {
					conversationId: input.conversationId,
					eventType: "assistant.completed",
					turnId,
					payload: { text: result.outputText },
				});
				return {
					ok: true,
					data: {
						turnId,
						userMessageSequence: userEvent.sequence,
						assistantSequence: completed?.sequence ?? null,
						outputText: result.outputText,
					},
				};
			}
			await this.repos.events.append(scope, {
				conversationId: input.conversationId,
				eventType: "turn.failed",
				turnId,
				payload: { error: result.error },
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
}

function ownerScope(principal: EmbedAuthContext) {
	return {
		tenantId: principal.tenantId,
		publishedAppId: principal.publishedAppId,
		principalId: principal.principalId,
	};
}

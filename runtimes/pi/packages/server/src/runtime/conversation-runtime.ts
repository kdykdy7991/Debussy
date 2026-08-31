/**
 * ConversationRuntime（spec AD-06 / 10，TASK-017 + TASK-020）。
 *
 * 一个活跃 Conversation 的临时执行实例：包装一个 `PiSessionRuntime`
 * （MVP 为独立 AgentSession，AD-07）加上冻结的 `RuntimeSpec` 与显式
 * `ScopeContext`。Runtime 是可释放的临时对象——Conversation 持久化在
 * 数据库中，Runtime 释放后可由持久事件与 RuntimeSpec 重建（TASK-022）。
 *
 * 资源统一由 `EffectOwner` 管理（spec 10.3，TASK-020 完成条件）：底层会话
 * dispose 通过 owner 注册，LIFO 释放、幂等 close、聚合错误。本类不处理
 * 鉴权：调用方必须先完成逐资源授权，再以已授权的 Scope 打开 Runtime。
 */
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, ResolvedAttachmentInput, RetrievalInput } from "../types.ts";
import { historyToContextText, historyToReference, type RestoredContext } from "./context-restore.ts";
import { createEffectOwner, type EffectOwner } from "./effect-owner.ts";
import type { ScopeContext } from "./scope-context.ts";

export interface ConversationRuntimeOptions {
	readonly scope: ScopeContext;
	/** 冻结的运行时配置（不可变，AD-05）。 */
	readonly spec: RuntimeSpec;
	/** 底层会话；MVP 每个 Conversation 独立（AD-07）。 */
	readonly session: PiSessionRuntime;
}

export interface ConversationRuntimeEvent {
	readonly type: "snapshot" | "progress" | "error";
	readonly event: PiSessionRuntimeEvent;
}

export class ConversationRuntime {
	readonly scope: ScopeContext;
	readonly spec: RuntimeSpec;
	private readonly session: PiSessionRuntime;
	private readonly owner: EffectOwner;
	private readonly listeners = new Set<(event: ConversationRuntimeEvent) => void>();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	/**
	 * Postgres-native hydration is RUN-ONCE per runtime lifetime. The in-memory
	 * Pi session is the live state across the runtime's turns; Postgres is only
	 * the durable source for (re)building a fresh session. Every turn passes the
	 * full restored `history`, so a cached runtime must not re-inject it —
	 * otherwise each subsequent turn duplicates all prior turns into the model
	 * context. A fresh runtime (just-created / after eviction / after restart)
	 * hydrates exactly once with the full history it is given.
	 */
	private hydrated = false;

	constructor(options: ConversationRuntimeOptions) {
		this.scope = options.scope;
		this.spec = options.spec;
		this.session = options.session;
		// 所有资源经 owner 注册（TASK-020）：本阶段只有底层会话，后续
		// Timer/listener/AbortController 同样在此登记。
		this.owner = createEffectOwner();
		this.owner.register(() => this.session.dispose());
	}

	get sessionId(): string {
		return this.session.snapshot().id;
	}

	/** 当前会话快照（含 transcript；TASK-018 用其提取 assistant 输出）。 */
	snapshot(): ReturnType<PiSessionRuntime["snapshot"]> {
		return this.session.snapshot();
	}

	/** 订阅底层会话事件（snapshot/progress/error）。 */
	subscribe(listener: (event: ConversationRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		const unsubscribe = this.session.subscribe((event) => {
			for (const l of this.listeners) l({ type: event.type, event });
		});
		return () => {
			this.listeners.delete(listener);
			unsubscribe();
		};
	}

	/**
	 * 向底层会话提交一轮用户输入（单写者由上层保证）。可附带恢复的历史
	 * 上下文（TASK-022）与会话级引用检索结果（TASK-032）：二者合并注入
	 * `PromptInput.retrieval`（历史全文 + 引用 context；reference 摘要；
	 * citations 数组）。只提供历史时输出与旧行为完全一致。
	 */
	async prompt(
		text: string,
		options?: {
			readonly history?: RestoredContext;
			readonly retrieval?: RetrievalInput;
			/** Stable attachment ids; surfaced to the inner session as prompt-time input. */
			readonly attachmentIds?: readonly string[];
			/** Resolved attachment inputs already prepared by the caller. */
			readonly attachments?: readonly ResolvedAttachmentInput[];
		},
	): Promise<void> {
		if (this.closed) throw new Error("ConversationRuntime is closed");
		const history = options?.history;
		const retrieval = options?.retrieval;
		const attachmentIds = options?.attachmentIds;
		const attachments = options?.attachments;
		// Phase-1/2: on a FRESH runtime the restored history is hydrated once as
		// structured native turns (assistant toolCall / toolResult), NOT flattened
		// into retrieval text. On a cached runtime (this.hydrated already true)
		// the in-memory session already holds prior turns, so the per-turn full
		// `history` is deliberately ignored for injection to avoid duplication.
		const hydrate = !this.hydrated;
		this.hydrated = true;
		const structuredHistory =
			hydrate && history !== undefined && history.transcript && history.transcript.length > 0
				? history.transcript
				: undefined;
		const hasHistory = hydrate && history !== undefined && history.messages.length > 0;
		const hasAttachments =
			(attachmentIds !== undefined && attachmentIds.length > 0) ||
			(attachments !== undefined && attachments.length > 0);
		if (structuredHistory === undefined && retrieval === undefined && !hasAttachments) {
			await this.session.prompt({ text });
			return;
		}
		const contextParts: string[] = [];
		const referenceParts: string[] = [];
		// Only fall back to flat text when there is no structured transcript.
		if (structuredHistory === undefined && hasHistory) {
			contextParts.push(historyToContextText(history.messages));
			referenceParts.push(historyToReference(history.messages));
		}
		if (retrieval !== undefined) {
			if (retrieval.context !== "") contextParts.push(retrieval.context);
			if (retrieval.reference !== "") referenceParts.push(retrieval.reference);
		}
		await this.session.prompt({
			text,
			...(structuredHistory !== undefined ? { transcript: structuredHistory } : {}),
			...(hasAttachments
				? {
						...(attachmentIds !== undefined && attachmentIds.length > 0
							? { attachmentIds: [...attachmentIds] }
							: {}),
						...(attachments !== undefined && attachments.length > 0 ? { attachments: [...attachments] } : {}),
					}
				: {}),
			retrieval: {
				context: contextParts.join("\n\n"),
				reference: referenceParts.join("\n"),
				citations: retrieval?.citations ?? [],
			},
		});
	}

	/** 中止当前底层 Agent 操作；由已授权 Conversation 的 Stop 命令调用。 */
	async abort(): Promise<void> {
		if (this.closed) return;
		await this.session.abort();
	}

	/** 幂等关闭：flush + owner LIFO 释放全部资源；多次调用返回同一 Promise。 */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = this.owner.close().then(
			() => {
				this.listeners.clear();
			},
			(error: unknown) => {
				this.listeners.clear();
				throw error;
			},
		);
		return this.closePromise;
	}
}

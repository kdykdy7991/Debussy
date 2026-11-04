/**
 * Turn 执行器（TASK-018 内部/测试路径）。
 *
 * `TurnExecutor` 把「一次用户输入 -> 一段 assistant 输出」抽象出来，便于
 * ConversationService 持久化 user.message / assistant.completed / turn.failed
 * 事件而不耦合 Pi 具体执行细节。`runtimeTurnExecutor` 是基于
 * `PiRuntimeAdapter` 的默认实现：打开 Runtime -> prompt -> 从会话 transcript
 * 提取最后一条 complete assistant 文本 -> 幂等 close。
 *
 * 本路径标记为 internal/dev，不作为最终公开协议（TASK-025 的 Realtime
 * 通道建成后关闭或仅测试可用）。
 */
import type { AssistantTranscriptItem, SessionSnapshot, TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { RetrievalInput } from "../types.ts";
import type { RestoredContext } from "./context-restore.ts";
import type { ConversationRuntimeManager } from "./conversation-runtime-manager.ts";
import type { PiRuntimeAdapter } from "./pi-runtime-adapter.ts";
import type { ScopeContext } from "./scope-context.ts";

export interface TurnExecutionInput {
	readonly scope: ScopeContext;
	readonly spec: RuntimeSpec;
	readonly text: string;
	/** 恢复的历史上下文（TASK-022）；缺省为无。 */
	readonly history?: RestoredContext;
	/** 会话级引用检索结果（TASK-032）；缺省为无（不注入 retrieval）。 */
	readonly retrieval?: RetrievalInput;
	/** Runtime 的真实结构化增量；调用方必须在 prompt 前完成订阅。 */
	readonly onProgress?: (progress: TranscriptProgress) => void;
}

export interface TurnLlmCallUsage {
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

/** All provider-reported LLM calls of one Turn, collected at the model-call completion boundary. */
export interface TurnLlmUsage {
	readonly calls: readonly TurnLlmCallUsage[];
	readonly total: Omit<TurnLlmCallUsage, "model">;
	readonly callCount: number;
	/** True when at least one completed model call had no provider usage. */
	readonly partial: boolean;
}

export type TurnExecutionResult =
	| {
			readonly ok: true;
			readonly outputText: string;
			readonly thinkingText?: string;
			readonly usage?: Usage;
			readonly llmUsage?: TurnLlmUsage;
	  }
	| { readonly ok: false; readonly error: string };

export type TurnExecutor = ((input: TurnExecutionInput) => Promise<TurnExecutionResult>) & {
	/** 可选取消入口；无此能力的测试/同步执行器安全地保持不可取消。 */
	cancel?(conversationId: ScopeContext["conversationId"]): Promise<boolean>;
};

/**
 * Collect one usage record per completed model call from `item_finished`
 * progress events. This is the model-call completion boundary: restored
 * history is injected into the session without emitting progress, so it is
 * never counted; context compaction cannot remove records already collected;
 * repeated events for the same message id are de-duplicated.
 */
export function createLlmUsageCollector(): {
	observe(progress: TranscriptProgress): void;
	result(): TurnLlmUsage | undefined;
} {
	const calls = new Map<string, TurnLlmCallUsage>();
	let partial = false;
	return {
		observe(progress) {
			if (progress.type !== "item_finished") return;
			const item = progress.item;
			if (item.role !== "assistant" || item.status !== "complete") return;
			const completed: AssistantTranscriptItem = item;
			if (calls.has(completed.id)) return;
			const usage = completed.usage;
			if (usage === undefined) {
				partial = true;
				return;
			}
			calls.set(completed.id, {
				model: completed.responseModel ?? completed.model.id,
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens,
			});
		},
		result() {
			if (calls.size === 0 && !partial) return undefined;
			const values = [...calls.values()];
			const total = values.reduce(
				(acc, call) => ({
					input: acc.input + call.input,
					output: acc.output + call.output,
					cacheRead: acc.cacheRead + call.cacheRead,
					cacheWrite: acc.cacheWrite + call.cacheWrite,
					totalTokens: acc.totalTokens + call.totalTokens,
				}),
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			);
			return { calls: values, total, callCount: values.length, partial };
		},
	};
}

/** 基于 PiRuntimeAdapter 的默认执行器（open -> prompt -> 提取输出 -> close）。 */
export function runtimeTurnExecutor(adapter: PiRuntimeAdapter): TurnExecutor {
	return async ({ scope, spec, text, history, retrieval, onProgress }) => {
		const opened = await adapter.open(spec, scope);
		if (!opened.ok) return { ok: false, error: opened.reason };
		const runtime = opened.runtime;
		const llmUsage = createLlmUsageCollector();
		const unsubscribe = runtime.subscribe((event) => {
			if (event.event.type === "progress") {
				const progress = event.event.progress;
				onProgress?.(progress);
				llmUsage.observe(progress);
			}
		});
		try {
			await runtime.prompt(text, { history, retrieval });
			const result = lastAssistantResult(runtime.snapshot());
			const collected = llmUsage.result();
			return {
				ok: true,
				outputText: result.outputText,
				...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(collected ? { llmUsage: collected } : {}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			unsubscribe();
			await runtime.close().catch(() => {});
		}
	};
}

/**
 * 基于 ConversationRuntimeManager 的执行器（TASK-021）：acquire 复用活跃
 * Runtime（同 Conversation 连续 Turn 不重建底层会话），Turn 后 release 而非
 * close——空闲回收由 manager 的空闲 TTL 负责，Runtime 生命周期不再跟随单次
 * HTTP 请求。
 */
export function managedTurnExecutor(
	manager: ConversationRuntimeManager,
	beforePrompt?: (input: TurnExecutionInput) => Promise<void>,
): TurnExecutor {
	const execute: TurnExecutor = async ({ scope, spec, text, history, retrieval, onProgress }) => {
		const acquired = await manager.acquire(spec, scope);
		const runtime = acquired.runtime;
		const llmUsage = createLlmUsageCollector();
		const unsubscribe = runtime.subscribe((event) => {
			if (event.event.type === "progress") {
				const progress = event.event.progress;
				onProgress?.(progress);
				llmUsage.observe(progress);
			}
		});
		try {
			await beforePrompt?.({ scope, spec, text, history, retrieval, onProgress });
			await runtime.prompt(text, { history, retrieval });
			const result = lastAssistantResult(runtime.snapshot());
			const collected = llmUsage.result();
			return {
				ok: true,
				outputText: result.outputText,
				...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(collected ? { llmUsage: collected } : {}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			unsubscribe();
			manager.release(scope.conversationId);
		}
	};
	execute.cancel = async (conversationId) => {
		const runtime = manager.get(conversationId);
		if (runtime === undefined) return false;
		await runtime.abort();
		return true;
	};
	return execute;
}

/** 从会话快照提取最后一条 status=complete 的 assistant 文本（拼接 text content）。 */
export function lastAssistantText(snapshot: SessionSnapshot): string {
	return lastAssistantResult(snapshot).outputText;
}

/** Extract final assistant text and provider-reported usage from one snapshot. */
export function lastAssistantResult(snapshot: SessionSnapshot): {
	readonly outputText: string;
	readonly thinkingText?: string;
	readonly usage?: Usage;
} {
	for (let i = snapshot.transcript.length - 1; i >= 0; i -= 1) {
		const item = snapshot.transcript[i];
		if (item === undefined || item.role !== "assistant") continue;
		if (item.status !== "complete") continue;
		return assistantResultFromItem(item);
	}
	return { outputText: "" };
}

/**
 * Extract the LAST assistant item regardless of terminal status (complete,
 * aborted, error, streaming). Used for cancel semantics: an interrupted Turn
 * must keep whatever thinking/text was already streamed to the UI instead of
 * being cleared, while still being a `turn/interrupted` (never a fabricated
 * complete assistant/message).
 */
export function lastAssistantResultAnyStatus(snapshot: SessionSnapshot): {
	readonly outputText: string;
	readonly thinkingText?: string;
	readonly usage?: Usage;
} {
	for (let i = snapshot.transcript.length - 1; i >= 0; i -= 1) {
		const item = snapshot.transcript[i];
		if (item === undefined || item.role !== "assistant") continue;
		return assistantResultFromItem(item);
	}
	return { outputText: "" };
}

function assistantResultFromItem(item: {
	readonly content: readonly AssistantTranscriptItem["content"][number][];
	readonly usage?: Usage;
}): {
	readonly outputText: string;
	readonly thinkingText?: string;
	readonly usage?: Usage;
} {
	const outputText = item.content
		.filter((content) => content.type === "text")
		.map((content) => (content as { type: "text"; text: string }).text)
		.join("\n");
	const thinkingText = item.content
		.filter((content) => content.type === "thinking" && !content.redacted)
		.map((content) => (content as { type: "thinking"; thinking: string }).thinking)
		.join("\n");
	return {
		outputText,
		...(thinkingText ? { thinkingText } : {}),
		...(item.usage ? { usage: item.usage } : {}),
	};
}

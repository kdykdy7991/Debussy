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
import type { SessionSnapshot, TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
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

export type TurnExecutionResult =
	| { readonly ok: true; readonly outputText: string; readonly thinkingText?: string; readonly usage?: Usage }
	| { readonly ok: false; readonly error: string };

export type TurnExecutor = ((input: TurnExecutionInput) => Promise<TurnExecutionResult>) & {
	/** 可选取消入口；无此能力的测试/同步执行器安全地保持不可取消。 */
	cancel?(conversationId: ScopeContext["conversationId"]): Promise<boolean>;
};

/** 基于 PiRuntimeAdapter 的默认执行器（open -> prompt -> 提取输出 -> close）。 */
export function runtimeTurnExecutor(adapter: PiRuntimeAdapter): TurnExecutor {
	return async ({ scope, spec, text, history, retrieval, onProgress }) => {
		const opened = await adapter.open(spec, scope);
		if (!opened.ok) return { ok: false, error: opened.reason };
		const runtime = opened.runtime;
		const unsubscribe = runtime.subscribe((event) => {
			if (event.event.type === "progress") onProgress?.(event.event.progress);
		});
		try {
			await runtime.prompt(text, { history, retrieval });
			const result = lastAssistantResult(runtime.snapshot());
			return {
				ok: true,
				outputText: result.outputText,
				...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
				...(result.usage ? { usage: result.usage } : {}),
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
export function managedTurnExecutor(manager: ConversationRuntimeManager): TurnExecutor {
	const execute: TurnExecutor = async ({ scope, spec, text, history, retrieval, onProgress }) => {
		const acquired = await manager.acquire(spec, scope);
		const runtime = acquired.runtime;
		const unsubscribe = runtime.subscribe((event) => {
			if (event.event.type === "progress") onProgress?.(event.event.progress);
		});
		try {
			await runtime.prompt(text, { history, retrieval });
			const result = lastAssistantResult(runtime.snapshot());
			return {
				ok: true,
				outputText: result.outputText,
				...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
				...(result.usage ? { usage: result.usage } : {}),
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
	return { outputText: "" };
}

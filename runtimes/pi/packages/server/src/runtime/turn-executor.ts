/**
 * Turn 执行器（TASK-018 内部/测试路径）。
 *
 * `TurnExecutor` 把「一次用户输入 -> 一段 assistant 输出」抽象出来，便于
 * ConversationService 持久化 user.message / assistant.completed / turn.failed
 * 事件而不耦合 Pi 具体执行细节。
 *
 * 实际的「一次执行」语义（订阅进度、传播取消、执行截止、提取结果与用量）
 * 由共享入口 `runtime/pi-execution.ts` 实现（R010）。本文件保留旧执行入口的
 * 形状与行为：Chat/AaaS 仍然通过 RuntimeManager 复用活跃 Runtime，
 * `TurnExecutionResult` 的成功/中断/失败三态与既有调用方一致。
 *
 * 本路径标记为 internal/dev，不作为最终公开协议（TASK-025 的 Realtime
 * 通道建成后关闭或仅测试可用）。
 */
import type { TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { LlmCallTrace, RetrievalInput } from "../types.ts";
import type { RestoredContext } from "./context-restore.ts";
import type { ConversationRuntimeManager } from "./conversation-runtime-manager.ts";
import {
	createPiExecutionEntry,
	type PiExecutionOutcome,
	type TurnLlmUsage,
} from "./pi-execution.ts";
import type { PiRuntimeAdapter } from "./pi-runtime-adapter.ts";
import type { ScopeContext } from "./scope-context.ts";

export {
	createLlmUsageCollector,
	lastAssistantResult,
	lastAssistantResultAnyStatus,
	lastAssistantText,
} from "./pi-execution.ts";
export type { TurnLlmCallStatus, TurnLlmCallUsage, TurnLlmUsage } from "./pi-execution.ts";

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
	readonly onLlmTrace?: (trace: LlmCallTrace) => Promise<void>;
}

export type TurnExecutionResult =
	| {
			readonly ok: true;
			readonly outputText: string;
			readonly thinkingText?: string;
			readonly usage?: Usage;
			readonly llmUsage?: TurnLlmUsage;
	  }
	| {
			/** 用户主动取消：既不成功也不失败。调用方必须写 `turn/interrupted`，不能写 `turn/end ok:true`。 */
			readonly ok: false;
			readonly interrupted: true;
			readonly outputText: string;
			readonly thinkingText?: string;
			/** 取消前 provider 已上报的最后一次 usage；无法获得时不设置，不伪造 0。 */
			readonly usage?: Usage;
			/** 取消前已完成调用的逐次用量；已完成的事实保留，未完成的保持未知。 */
			readonly llmUsage?: TurnLlmUsage;
	  }
	| {
			readonly ok: false;
			readonly error: string;
			/** 失败前已确认的用量；已确认的事实保留，未完成的保持未知。 */
			readonly usage?: Usage;
			readonly llmUsage?: TurnLlmUsage;
	  };

export type TurnExecutor = ((input: TurnExecutionInput) => Promise<TurnExecutionResult>) & {
	/** 可选取消入口；无此能力的测试/同步执行器安全地保持不可取消。 */
	cancel?(conversationId: ScopeContext["conversationId"]): Promise<boolean>;
};

/** 共享入口的三态结果 → 旧执行入口的结果形状（行为保持不变）。 */
function toTurnExecutionResult(outcome: PiExecutionOutcome): TurnExecutionResult {
	if (outcome.status === "completed") {
		return {
			ok: true,
			outputText: outcome.outputText,
			...(outcome.thinkingText ? { thinkingText: outcome.thinkingText } : {}),
			...(outcome.usage ? { usage: outcome.usage } : {}),
			...(outcome.llmUsage ? { llmUsage: outcome.llmUsage } : {}),
		};
	}
	if (outcome.status === "cancelled") {
		return {
			ok: false,
			interrupted: true,
			outputText: outcome.outputText,
			...(outcome.thinkingText ? { thinkingText: outcome.thinkingText } : {}),
			...(outcome.usage ? { usage: outcome.usage } : {}),
			...(outcome.llmUsage ? { llmUsage: outcome.llmUsage } : {}),
		};
	}
	return {
		ok: false,
		error: outcome.error,
		...(outcome.usage ? { usage: outcome.usage } : {}),
		...(outcome.llmUsage ? { llmUsage: outcome.llmUsage } : {}),
	};
}

/** 基于 PiRuntimeAdapter 的默认执行器（open -> prompt -> 提取输出 -> close）。 */
export function runtimeTurnExecutor(adapter: PiRuntimeAdapter): TurnExecutor {
	const entry = createPiExecutionEntry();
	return async ({ scope, spec, text, history, retrieval, onProgress, onLlmTrace }) => {
		const opened = await adapter.open(spec, scope);
		if (!opened.ok) return { ok: false, error: opened.reason };
		const runtime = opened.runtime;
		try {
			const outcome = await entry.execute(runtime, {
				identity: { kind: "conversation", conversationId: scope.conversationId },
				input: text,
				context: {
					...(history !== undefined ? { history } : {}),
					...(retrieval !== undefined ? { retrieval } : {}),
				},
				onProgress,
				onLlmTrace,
			});
			return toTurnExecutionResult(outcome);
		} finally {
			await runtime.close().catch(() => {});
		}
	};
}

/**
 * 基于 ConversationRuntimeManager 的执行器（TASK-021）：acquire 复用活跃
 * Runtime（同 Conversation 连续 Turn 不重建底层会话），Turn 后 release 而非
 * close——空闲回收由 manager 的空闲 TTL 负责，Runtime 生命周期不再跟随单次
 * HTTP 请求。
 *
 * 一次执行的语义（进度、取消、结果提取）全部走共享入口
 * `runtime/pi-execution.ts`；本函数只保留 RuntimeManager 的生命周期与旧入口
 * 的取消入口形状。
 */
export function managedTurnExecutor(
	manager: ConversationRuntimeManager,
	beforePrompt?: (input: TurnExecutionInput) => Promise<void>,
): TurnExecutor {
	const entry = createPiExecutionEntry();
	const activeTurns = new Map<ScopeContext["conversationId"], AbortController>();
	const execute: TurnExecutor = async ({ scope, spec, text, history, retrieval, onProgress, onLlmTrace }) => {
		const conversationId = scope.conversationId;
		if (activeTurns.has(conversationId)) return { ok: false, error: "会话已有执行中的 Turn" };
		const controller = new AbortController();
		activeTurns.set(conversationId, controller);
		try {
			const { runtime } = await manager.acquire(spec, scope);
			if (!controller.signal.aborted)
				await beforePrompt?.({ scope, spec, text, history, retrieval, onProgress, onLlmTrace });
			const outcome = await entry.execute(runtime, {
				identity: { kind: "conversation", conversationId },
				input: text,
				context: {
					...(history !== undefined ? { history } : {}),
					...(retrieval !== undefined ? { retrieval } : {}),
				},
				onProgress,
				onLlmTrace,
				signal: controller.signal,
			});
			return toTurnExecutionResult(outcome);
		} catch (error) {
			if (controller.signal.aborted) return { ok: false, interrupted: true, outputText: "" };
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			activeTurns.delete(conversationId);
			manager.release(conversationId);
		}
	};
	// Keep the same signal from runtime acquisition through prompt execution.
	execute.cancel = async (conversationId) => {
		const controller = activeTurns.get(conversationId);
		if (controller === undefined || controller.signal.aborted) return false;
		controller.abort();
		return true;
	};
	return execute;
}

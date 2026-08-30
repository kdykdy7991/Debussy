/**
 * RealtimeServices 适配器（TASK-025）。
 *
 * 把 `ConversationService` 适配为 Realtime 连接所需的最小接口：授权后执行
 * Turn（持久化 + 单写者）+ 会话快照。Realtime 与 HTTP 共享同一套授权/持久
 * 化语义，不存在第二套用户隔离逻辑。
 */
import type { ConversationService } from "../conversations/service.ts";
import type { RealtimeServices } from "./connection.ts";

export function conversationRealtimeServices(service: ConversationService): RealtimeServices {
	return {
		async executeTurn({ principal, conversationId, requestId, text, turnId, onProgress }) {
			// TURN-TASK：透传连接层预生成的 turnId，使 realtime 事件与持久事件共享同一 turnId。
			const result = await service.executeTurn({
				principal,
				conversationId,
				requestId,
				text,
				...(turnId ? { turnId } : {}),
				onProgress,
			});
			if (!result.ok) {
				return {
					ok: false,
					code: result.error.code,
					message: result.error.message,
					retryable: result.error.retryable,
				};
			}
			return {
				ok: true,
				turnId: result.data.turnId,
				userMessageSequence: result.data.userMessageSequence,
				assistantSequence: result.data.assistantSequence,
				outputText: result.data.outputText,
				...(result.data.thinkingText ? { thinkingText: result.data.thinkingText } : {}),
				// TASK-033：本 turn 实际使用的引用（citation.updated 事件来源）。
				citations: result.data.citations,
			};
		},
		async cancelTurn({ principal, conversationId }) {
			const result = await service.cancelTurn({ principal, conversationId });
			return result.ok
				? { ok: true, cancelled: result.data.cancelled }
				: { ok: false, message: result.error.message };
		},
		async getConversation({ principal, conversationId }) {
			const result = await service.getConversation({ principal, conversationId });
			return result.ok ? result.data : undefined;
		},
		async listEvents({ principal, conversationId, afterSequence }) {
			const result = await service.listEvents({
				principal,
				conversationId,
				afterSequence,
				limit: 200,
			});
			return result.ok ? result.data : [];
		},
	};
}

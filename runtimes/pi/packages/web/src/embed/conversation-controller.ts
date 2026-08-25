import type { ChatMessage, ConversationEvent } from "./types.ts";

/** 把恢复接口的持久事件映射为共享 Chat 视图消息。 */
export function messagesFromEvents(events: readonly ConversationEvent[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const event of events) {
		if (event.eventType === "user.message") {
			const payload = event.payload as { text?: unknown };
			messages.push({
				role: "user",
				text: typeof payload.text === "string" ? payload.text : "",
				sequence: event.sequence,
			});
		} else if (event.eventType === "assistant.completed") {
			const payload = event.payload as { text?: unknown; thinking?: unknown };
			messages.push({
				role: "assistant",
				text: typeof payload.text === "string" ? payload.text : "",
				...(typeof payload.thinking === "string" ? { thinking: payload.thinking } : {}),
				sequence: event.sequence,
			});
		} else if (event.eventType === "turn.failed") {
			const payload = event.payload as { error?: unknown };
			messages.push({
				role: "system",
				text: `回复失败：${typeof payload.error === "string" ? payload.error : "未知错误"}`,
				sequence: event.sequence,
			});
		}
	}
	return messages;
}

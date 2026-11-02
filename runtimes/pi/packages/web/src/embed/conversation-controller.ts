import { toolImagesFromContent } from "@earendil-works/pi-protocol";
import type { ChatMessage, ChatToolCall, ConversationEvent } from "./types.ts";

/** 把恢复接口的持久事件映射为共享 Chat 视图消息。 */
export function messagesFromEvents(events: readonly ConversationEvent[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	let tools: ChatToolCall[] = [];
	for (const event of events) {
		if (event.eventType === "user/message") {
			tools = [];
			const payload = event.payload as { text?: unknown };
			messages.push({
				role: "user",
				text: typeof payload.text === "string" ? payload.text : "",
				sequence: event.sequence,
			});
		} else if (event.eventType === "tool/result" || event.eventType === "tool/error") {
			const payload = event.payload as {
				toolCallId?: string;
				toolName?: string;
				content?: unknown;
				isError?: boolean;
			};
			const failed = event.eventType === "tool/error" || payload.isError === true;
			const tool: ChatToolCall = {
				id: payload.toolCallId ?? `tool-${event.sequence}`,
				name: payload.toolName ?? "MCP",
				status: failed ? "failed" : "completed",
				images: failed ? [] : toolImagesFromContent(payload.content),
			};
			tools = [...tools.filter((entry) => entry.id !== tool.id), tool];
		} else if (event.eventType === "assistant/message") {
			const payload = event.payload as { text?: unknown; thinking?: unknown };
			messages.push({
				role: "assistant",
				text: typeof payload.text === "string" ? payload.text : "",
				...(typeof payload.thinking === "string" ? { thinking: payload.thinking } : {}),
				sequence: event.sequence,
				...(tools.length > 0 ? { tools } : {}),
			});
		} else if (event.eventType === "turn/failed") {
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

/**
 * Embed Conversation 控制器（TASK-019）。
 *
 * 列表/创建/打开/发送文本（TASK-018 dev turn 路径）+ 由持久事件推导消息
 * 列表。发送采用「先本地回显 user 消息，turn 完成后以 assistant.completed
 * 补齐」，失败保留 user 消息并标记错误（后续 Realtime 替换该路径）。
 */
import type { EmbedApi } from "./api.ts";
import type { ChatMessage, ConversationEvent, ConversationSummary, CreateConversationResponse } from "./types.ts";

export class EmbedConversationController {
	private readonly api: EmbedApi;

	constructor(api: EmbedApi) {
		this.api = api;
	}

	async list(token: string, limit = 20): Promise<readonly ConversationSummary[]> {
		const response = await this.api.listConversations(token, limit);
		return response.items;
	}

	async create(token: string, title = ""): Promise<CreateConversationResponse> {
		return this.api.createConversation(token, title);
	}

	/** 打开会话：拉取会话 + 事件，推导消息列表。 */
	async open(
		token: string,
		conversationId: string,
	): Promise<{ summary: ConversationSummary; messages: ChatMessage[] }> {
		const detail = await this.api.getConversation(token, conversationId);
		return { summary: detail.conversation, messages: messagesFromEvents(detail.events) };
	}

	/** 发送文本（dev turn）；返回该 turn 的完成事件信息。 */
	async send(token: string, conversationId: string, text: string): Promise<ChatMessage> {
		const result = await this.api.sendTurn(token, conversationId, text);
		return { role: "assistant", text: result.outputText, sequence: result.assistantSequence ?? 0 };
	}
}

/** 由持久事件推导展示消息（user.message / assistant.completed / turn.failed）。 */
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
			const payload = event.payload as { text?: unknown };
			messages.push({
				role: "assistant",
				text: typeof payload.text === "string" ? payload.text : "",
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

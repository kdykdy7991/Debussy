/**
 * 持久事件 -> Pi 上下文恢复（spec 10 / TASK-022）。
 *
 * 只使用已完成、schema 支持的事件恢复：`user.message` + `assistant.completed`
 * 完整对还原为消息列表；未完成的 turn（user.message 后无终态）在重启后收敛
 * 为 interrupted（调用方负责持久化 `turn.interrupted`）；未知 eventSchemaVersion
 * 与 MVP 不恢复的事件类型（工具等）跳过。文本按 maxContextTokens 预算从
 * 最近往旧保留完整消息对，避免下一轮模型上下文超限。
 *
 * 纯函数、无副作用，便于测试。
 */
import type { ConversationEventRecord } from "../publishing/repositories.ts";

/** 当前支持的事件 schema 版本（conversation_events.event_schema_version）。 */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1] as const;
export const MAX_SUPPORTED_EVENT_SCHEMA_VERSION = Math.max(...SUPPORTED_EVENT_SCHEMA_VERSIONS);

export interface RestoredMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface RestoredContext {
	readonly messages: readonly RestoredMessage[];
	/** 因中断而未完成的 turn（调用方应持久化 turn.interrupted）。 */
	readonly interruptedTurnIds: readonly string[];
	/** 因 schema/类型不受支持而跳过的事件数。 */
	readonly skippedEvents: number;
}

export interface RestoreParams {
	/** 恢复上下文的 token 预算（来自 RuntimeSpec.contextPolicy.maxContextTokens）。 */
	readonly maxContextTokens: number;
}

/** 粗略的 token -> 字符预算（中文场景约 1 token ≈ 1.5~2 字符，取 4 保守）。 */
const CHARS_PER_TOKEN = 4;

/** 事件类型中代表「该 turn 已终态」的类型。 */
const TERMINAL_TURN_EVENTS = new Set(["turn.failed", "turn.interrupted"]);

export function restoreContext(events: readonly ConversationEventRecord[], params: RestoreParams): RestoredContext {
	const messages: RestoredMessage[] = [];
	const interruptedTurnIds: string[] = [];
	let skippedEvents = 0;
	let pending: { turnId: string | null; text: string } | null = null;

	for (const event of events) {
		if (event.eventSchemaVersion > MAX_SUPPORTED_EVENT_SCHEMA_VERSION) {
			skippedEvents += 1;
			continue;
		}
		const payload = (event.payload ?? {}) as { text?: unknown };
		if (event.eventType === "user.message") {
			pending = { turnId: event.turnId, text: typeof payload.text === "string" ? payload.text : "" };
		} else if (event.eventType === "assistant.completed") {
			const text = typeof payload.text === "string" ? payload.text : "";
			if (pending !== null) {
				messages.push({ role: "user", text: pending.text });
				messages.push({ role: "assistant", text });
				pending = null;
			} else {
				// 孤立 assistant.completed：无对应 user 消息，不恢复。
				skippedEvents += 1;
			}
		} else if (TERMINAL_TURN_EVENTS.has(event.eventType)) {
			// 该 turn 已终态（失败/中断），不恢复其输入。
			pending = null;
		} else {
			// 工具等 MVP 不支持的事件类型：不恢复。
			skippedEvents += 1;
		}
	}
	if (pending !== null && pending.turnId !== null) {
		interruptedTurnIds.push(pending.turnId);
	}

	return {
		messages: trimToBudget(messages, params.maxContextTokens),
		interruptedTurnIds,
		skippedEvents,
	};
}

/** 从最近往旧保留完整消息对，直到字符预算耗尽（保留后缀）。 */
function trimToBudget(messages: readonly RestoredMessage[], maxContextTokens: number): readonly RestoredMessage[] {
	const maxChars = maxContextTokens * CHARS_PER_TOKEN;
	let chars = 0;
	const kept: RestoredMessage[] = [];
	for (let i = messages.length - 1; i >= 0; i -= 2) {
		const assistant = messages[i];
		const user = messages[i - 1];
		if (assistant === undefined) break;
		const pairChars = (user?.text.length ?? 0) + assistant.text.length;
		if (kept.length > 0 && chars + pairChars > maxChars) break; // 至少保留最近一对
		kept.unshift({ role: "assistant", text: assistant.text });
		kept.unshift({ role: "user", text: user?.text ?? "" });
		chars += pairChars;
	}
	return kept;
}

/** 把恢复上下文序列化为注入 runtime 的历史文本（经 retrieval/contextBlocks）。 */
export function historyToContextText(history: readonly RestoredMessage[]): string {
	return history.map((message) => `${message.role}: ${message.text}`).join("\n");
}

/** 恢复上下文的短摘要（reference，不进模型上下文正文）。 */
export function historyToReference(history: readonly RestoredMessage[]): string {
	const turns = Math.floor(history.length / 2);
	return `已恢复 ${turns} 轮历史对话（${history.length} 条消息）`;
}

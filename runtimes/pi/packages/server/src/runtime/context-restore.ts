/**
 * 持久事件 -> Pi 上下文恢复（spec 10 / TASK-022 + WB-007）。
 *
 * 恢复策略：以最终 `assistant.message` 为权威 Transcript 单元，未完成的
 * turn（user.message 后无终态）在重启后收敛为 interrupted（调用方负责
 * 持久化 `turn.interrupted`）；未知 eventSchemaVersion 跳过；MVP 不支持的
 * 事件类型（tool.* / attachment.* / citation.* 等）跳过计数，但
 * `assistant.chunk` 已流式到达的事实由 `assistant.message` 覆盖，最终
 * 消息、Turn 结果、工具副作用状态和错误必须可恢复。
 *
 * 日志等级（spec §11.4）：
 *
 * - `standard`: 只持久化 `assistant.message` 与终态 Turn 事件。MVP 恢复路径
 *   只读取这一档 + 终态，可完整恢复 Transcript。
 * - `diagnostic`: 额外保留首/末 chunk 与里程碑，可识别流式时延但仍不丢
 *   最终结果。
 * - `full`: 保留所有 chunk 与 tool.* 事件；本函数不展开 tool payload，
 *   仅用作恢复时引用。
 *
 * 文本按 maxContextTokens 预算从最近往旧保留完整消息对，避免下一轮模型
 * 上下文超限。纯函数、无副作用，便于测试。
 */
import type { SessionLogLevel } from "@earendil-works/pi-protocol";
import type { ConversationEventRecord } from "../publishing/repositories.ts";

/** 当前支持的事件 schema 版本（conversation_events.event_schema_version）。 */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1] as const;
export const MAX_SUPPORTED_EVENT_SCHEMA_VERSION = Math.max(...SUPPORTED_EVENT_SCHEMA_VERSIONS);

/** Event types that close out a turn: no further events for this turn will recover as messages. */
const TERMINAL_TURN_EVENTS = new Set([
	"turn.end",
	"turn.failed",
	"turn.interrupted",
	"turn/end",
	"turn/failed",
	"turn/interrupted",
]);

/** Event types whose payload contributes a final assistant message we should recover. */
const FINAL_ASSISTANT_MESSAGE_TYPES = new Set(["assistant.message", "assistant.completed", "assistant/message"]);

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
	/** 在本档日志下被压缩掉的流式 chunk 数（仅 diagnostic / full 时可能非 0）。 */
	readonly droppedChunks: number;
	/** 恢复时遇到的 tool/error / turn.failed 数量（dashboard / 排查）。 */
	readonly errorEventCount: number;
	/**
	 * The conversation's effective log level, derived from the events seen:
	 * - standard: only final-message events present (or no chunks at all)
	 * - diagnostic: at least one milestone chunk present
	 * - full: every chunk persisted
	 */
	readonly observedLogLevel: SessionLogLevel;
}

export interface RestoreParams {
	/** 恢复上下文的 token 预算（来自 RuntimeSpec.contextPolicy.maxContextTokens）。 */
	readonly maxContextTokens: number;
}

/** 粗略的 token -> 字符预算（中文场景约 1 token ≈ 1.5~2 字符，取 4 保守）。 */
const CHARS_PER_TOKEN = 4;

export function restoreContext(
	events: readonly ConversationEventRecord[],
	params: RestoreParams,
	logLevel: SessionLogLevel = "standard",
): RestoredContext {
	const messages: RestoredMessage[] = [];
	const interruptedTurnIds: string[] = [];
	let skippedEvents = 0;
	let droppedChunks = 0;
	let errorEventCount = 0;
	let observedLogLevel: SessionLogLevel = "standard";
	let pending: { turnId: string | null; text: string } | null = null;

	for (const event of events) {
		if (event.eventSchemaVersion > MAX_SUPPORTED_EVENT_SCHEMA_VERSION) {
			skippedEvents += 1;
			continue;
		}
		const payload = (event.payload ?? {}) as { text?: unknown; reason?: unknown; status?: unknown };
		if (event.eventType === "user.message" || event.eventType === "user/message") {
			pending = { turnId: event.turnId, text: typeof payload.text === "string" ? payload.text : "" };
		} else if (FINAL_ASSISTANT_MESSAGE_TYPES.has(event.eventType)) {
			const text = typeof payload.text === "string" ? payload.text : "";
			// Interrupted assistant output is a durable audit/UI fact, not a
			// completed model-history pair. Preserve the existing restore semantics.
			if (payload.status === "interrupted") continue;
			if (pending !== null) {
				messages.push({ role: "user", text: pending.text });
				messages.push({ role: "assistant", text });
				pending = null;
			} else {
				// 孤立 assistant 终态：无对应 user 消息，不恢复。
				skippedEvents += 1;
			}
		} else if (event.eventType === "assistant.chunk" || event.eventType === "assistant/chunk") {
			// Tracked for the observed log level; the actual chunk text is
			// already collapsed into the following assistant.message so we
			// don't expand it into a separate message here.
			if (logLevel !== "full") droppedChunks += 1;
			if (observedLogLevel === "standard") observedLogLevel = "diagnostic";
		} else if (TERMINAL_TURN_EVENTS.has(event.eventType)) {
			// 该 turn 已终态（失败/中断/正常结束），不恢复其输入。
			if (event.eventType === "turn.failed" || event.eventType === "turn.interrupted") {
				errorEventCount += 1;
			}
			pending = null;
		} else if (event.eventType === "tool.error") {
			errorEventCount += 1;
			skippedEvents += 1;
		} else if (
			event.eventType === "tool/call" ||
			event.eventType === "tool/result" ||
			event.eventType === "attachment/added" ||
			event.eventType === "citation/updated" ||
			event.eventType === "context/snapshot" ||
			event.eventType === "assistant/start" ||
			event.eventType === "assistant.message" ||
			event.eventType === "turn/start" ||
			event.eventType === "conversation/created" ||
			event.eventType === "conversation/summary" ||
			event.eventType === "conversation/rollover" ||
			event.eventType === "conversation/archived" ||
			event.eventType === "history/expired"
		) {
			// Acknowledged but contributes nothing to the restored message list.
			if (event.eventType === "tool/call" || event.eventType === "tool/result") {
				if (logLevel === "full") observedLogLevel = "full";
			}
			skippedEvents += 1;
		} else {
			// Unknown event type (forward-compatible): skip without error.
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
		droppedChunks,
		errorEventCount,
		observedLogLevel,
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

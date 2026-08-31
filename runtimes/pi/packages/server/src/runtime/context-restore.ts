/**
 * 持久事件 -> 结构化 Context 恢复（spec 10 / TASK-022 + WB-007, Phase-1）。
 *
 * 恢复策略：
 * - 以 event 流的原生顺序构建结构化 transcript，恢复「模型行为所需」的原生
 *   Conversation 结构：`user` -> `assistant(toolCall)` -> `toolResult` ->
 *   `assistant(text)`... 而不是把工具调用/结果压平成普通文本。
 * - `toolCallId` 在 assistant(toolCall) 与 toolResult 之间保持配对（由事件
 *   顺序天然保证：同一 turn 内 tool/call 先于 tool/result 落盘）。
 * - 未完成的 turn（user 后无终态）在重启后收敛为 `turn.interrupted`（调用方
 *   负责持久化）。
 * - 旧事件向后兼容：
 *    - `tool/call` 无 `input`（旧数据）=> toolCall.input 缺省（不伪造）。
 *    - `tool/result` 无 `content`（旧数据）=> toolResult.content 为空数组
 *      （退化恢复，不伪造不存在的参数/结果）。
 *    - 未知 `eventSchemaVersion` 跳过。
 *
 * `messages`（旧式扁平 "role: text" 对）继续保留，供 summary / reference 与
 * 既有消费方使用；新增 `turns` / `transcript`（结构化原生消息列表）供新的
 * Context 注入路径使用。
 */
import type { SessionLogLevel } from "@earendil-works/pi-protocol";
import type { ConversationEventRecord } from "../publishing/repositories.ts";

/** 当前支持的事件 schema 版本（conversation_events.event_schema_version）。 */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1] as const;
export const MAX_SUPPORTED_EVENT_SCHEMA_VERSION = Math.max(...SUPPORTED_EVENT_SCHEMA_VERSIONS);

const USER_EVENT_TYPES = new Set(["user.message", "user/message"]);
const ASSISTANT_FINAL_TYPES = new Set(["assistant.message", "assistant.completed", "assistant/message"]);
const TOOL_CALL_TYPES = new Set(["tool.call", "tool/call"]);
const TOOL_RESULT_TYPES = new Set(["tool.result", "tool/result"]);
const TOOL_ERROR_TYPES = new Set(["tool.error", "tool/error"]);

/** Native content blocks for the reconstructed transcript. */
export type RestoredContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "toolCall"; readonly toolCallId: string; readonly toolName: string; readonly input?: unknown };

/** One reconstructed native model message. */
export type RestoredTranscriptMessage =
	| { readonly role: "user"; readonly content: readonly RestoredContent[] }
	| {
			readonly role: "assistant";
			readonly content: readonly RestoredContent[];
	  }
	| {
			readonly role: "toolResult";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly isError: boolean;
			readonly content: readonly RestoredContent[];
	  };

/** A complete user turn with its native items, in native model order. */
export interface RestoredTurn {
	readonly turnId: string | null;
	readonly items: readonly RestoredTranscriptMessage[];
}

export interface RestoredMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface RestoredContext {
	/** Legacy flat `user/assistant` text pairs (summary / reference / compat). */
	readonly messages: readonly RestoredMessage[];
	/** Structured native-order transcript (user -> assistant toolCall -> toolResult -> assistant...). */
	readonly transcript: ReadonlyArray<RestoredTranscriptMessage>;
	/** Whole reconstructed user turns (each a native-ordered item list). */
	readonly turns: readonly RestoredTurn[];
	/** 因中断而未完成的 turn（调用方应持久化 turn.interrupted）。 */
	readonly interruptedTurnIds: readonly string[];
	/** 因 schema/类型不受支持而跳过的事件数。 */
	readonly skippedEvents: number;
	/** 在本档日志下被压缩掉的流式 chunk 数（仅 diagnostic / full 时可能非 0）。 */
	readonly droppedChunks: number;
	/** 恢复时遇到的 tool/error / turn.failed 数量（dashboard / 排查）。 */
	readonly errorEventCount: number;
	/**
	 * The conversation's effective log level, derived from the events seen.
	 */
	readonly observedLogLevel: SessionLogLevel;
}

export interface RestoreParams {
	/** 恢复上下文的 token 预算（来自 RuntimeSpec.contextPolicy.maxContextTokens）。 */
	readonly maxContextTokens: number;
}

/** 粗略的 token -> 字符预算（中文场景约 1 token ≈ 1.5~2 字符，取 4 保守）。 */
const CHARS_PER_TOKEN = 4;

interface WorkingTurn {
	readonly turnId: string | null;
	readonly hasUser: boolean;
	hasCompletion: boolean;
	items: RestoredTranscriptMessage[];
}

export function restoreContext(
	events: readonly ConversationEventRecord[],
	params: RestoreParams,
	logLevel: SessionLogLevel = "standard",
): RestoredContext {
	const turns: RestoredTurn[] = [];
	let current: WorkingTurn | null = null;
	const interruptedTurnIds: string[] = [];
	let skippedEvents = 0;
	let droppedChunks = 0;
	let errorEventCount = 0;
	let observedLogLevel: SessionLogLevel = "standard";

	/**
	 * Close the pending turn. `drop` is used for terminal turn events
	 * (turn.failed / turn.interrupted): the turn is intentionally discarded — not
	 * recovered, and NOT reported as interrupted (that marker is reserved for a
	 * pending turn with no terminal event at the end of the stream).
	 */
	const finalizeCurrent = (drop = false): void => {
		if (current === null) return;
		const turn = current;
		current = null;
		if (drop || !turn.hasUser) return;
		if (!turn.hasCompletion) {
			if (turn.turnId !== null) interruptedTurnIds.push(turn.turnId);
			return;
		}
		turns.push({ turnId: turn.turnId, items: turn.items });
	};

	for (const event of events) {
		if (event.eventSchemaVersion > MAX_SUPPORTED_EVENT_SCHEMA_VERSION) {
			skippedEvents += 1;
			continue;
		}
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const type = event.eventType;

		if (USER_EVENT_TYPES.has(type)) {
			finalizeCurrent();
			const text = typeof payload.text === "string" ? payload.text : "";
			current = {
				turnId: event.turnId,
				hasUser: true,
				hasCompletion: false,
				items: [{ role: "user", content: [{ type: "text", text }] }],
			};
		} else if (ASSISTANT_FINAL_TYPES.has(type)) {
			// Interrupted assistant output is a durable audit/UI fact, not a
			// completed model-history pair. Preserve existing restore semantics.
			if (payload.status === "interrupted") continue;
			if (current !== null && current.hasUser) {
				const text = typeof payload.text === "string" ? payload.text : "";
				current.items.push({ role: "assistant", content: [{ type: "text", text }] });
				current.hasCompletion = true;
			} else {
				// 孤立 assistant 终态：无对应 user 消息，不恢复。
				skippedEvents += 1;
			}
		} else if (TOOL_CALL_TYPES.has(type)) {
			if (current === null) {
				// Orphan tool call (no preceding user). Start a synthetic turn so a
				// paired tool result still reconstructs; it never yields messages.
				current = { turnId: event.turnId ?? null, hasUser: false, hasCompletion: false, items: [] };
				skippedEvents += 1;
			}
			const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
			const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
			const input = "input" in payload ? (payload.input as unknown) : undefined;
			current.items.push({
				role: "assistant",
				content: [{ type: "toolCall", toolCallId, toolName, ...(input !== undefined ? { input } : {}) }],
			});
			current.hasCompletion = true;
			if (logLevel === "full") observedLogLevel = "full";
		} else if (TOOL_RESULT_TYPES.has(type)) {
			if (current === null) continue;
			const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
			const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
			const isError = payload.isError === true;
			const truncated = payload.truncated === true;
			const content = contentBlocksFromPayload(payload);
			current.items.push({
				role: "toolResult",
				toolCallId,
				toolName,
				isError,
				content: [...content, ...(truncated ? [{ type: "text" as const, text: "[truncated]" }] : [])],
			});
			current.hasCompletion = true;
			if (logLevel === "full") observedLogLevel = "full";
		} else if (TOOL_ERROR_TYPES.has(type)) {
			errorEventCount += 1;
			if (current !== null && current.hasUser) {
				const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
				const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
				const error = typeof payload.error === "string" ? payload.error : "";
				current.items.push({
					role: "toolResult",
					toolCallId,
					toolName,
					isError: true,
					content: [{ type: "text", text: error }],
				});
				current.hasCompletion = true;
			} else {
				skippedEvents += 1;
			}
		} else if (type === "assistant.chunk" || type === "assistant/chunk") {
			// Collapsed into the following assistant.message; not expanded here.
			if (logLevel !== "full") droppedChunks += 1;
			if (observedLogLevel === "standard") observedLogLevel = "diagnostic";
		} else if (type === "turn.end" || type === "turn/end") {
			finalizeCurrent();
		} else if (
			type === "turn.failed" ||
			type === "turn/interrupted" ||
			type === "turn/failed" ||
			type === "turn.interrupted"
		) {
			finalizeCurrent(true);
			if (type === "turn.failed" || type === "turn/failed") errorEventCount += 1;
		} else {
			// Acknowledged-but-not-transcript event types + unknown (forward-compatible): skip.
			skippedEvents += 1;
		}
	}
	finalizeCurrent();

	const trimmedTurns = trimTurnsToBudget(turns, params.maxContextTokens);
	const transcript = trimmedTurns.flatMap((turn) => turn.items);
	// Legacy flat `role: text` pairs, derived ONLY from completed turns that carry
	// a final assistant text. This excludes in-flight/terminal-dropped turns so
	// the flat list always ends on an assistant and pairs stay in order.
	const messages = flatMessagesFromTurns(trimmedTurns);

	return {
		messages,
		transcript,
		turns: trimmedTurns,
		interruptedTurnIds,
		skippedEvents,
		droppedChunks,
		errorEventCount,
		observedLogLevel,
	};
}

/** Reconstruct result content blocks, tolerating absent/present `content` (backward-compatible). */
function contentBlocksFromPayload(payload: Record<string, unknown>): RestoredContent[] {
	const raw = payload["content"];
	if (!Array.isArray(raw)) return [];
	const blocks: RestoredContent[] = [];
	for (const block of raw) {
		if (block === null || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown; image?: unknown; data?: unknown; mimeType?: unknown };
		if (b.type === "text" && typeof b.text === "string") {
			blocks.push({ type: "text", text: b.text });
		} else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
			blocks.push({ type: "image", data: b.data, mimeType: b.mimeType });
		}
	}
	return blocks;
}

/** 从最近往旧保留完整 user turns（结构化），直到字符预算耗尽（保留后缀）。 */
function trimTurnsToBudget(turns: readonly RestoredTurn[], maxContextTokens: number): RestoredTurn[] {
	const maxChars = maxContextTokens * CHARS_PER_TOKEN;
	const kept: RestoredTurn[] = [];
	let chars = 0;
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		if (turn === undefined) break;
		const turnChars = turn.items.reduce((sum, item) => sum + contentChars(item), 0);
		if (kept.length > 0 && chars + turnChars > maxChars) break; // 至少保留最近一个 turn
		kept.unshift(turn);
		chars += turnChars;
	}
	return kept;
}

function contentChars(item: RestoredTranscriptMessage): number {
	if (item.role === "user" || item.role === "assistant") {
		return item.content.reduce((sum, block) => {
			if (block.type === "text") return sum + block.text.length;
			if (block.type === "toolCall") return sum + JSON.stringify(block.input ?? {}).length;
			return sum;
		}, 0);
	}
	return item.content.reduce((sum, block) => (block.type === "text" ? sum + block.text.length : sum), 0);
}

/** 从最近往旧保留完整 user turns（结构化），直到字符预算耗尽（保留后缀）。 */
function flatMessagesFromTurns(turns: readonly RestoredTurn[]): readonly RestoredMessage[] {
	const out: RestoredMessage[] = [];
	for (const turn of turns) {
		const userItem = turn.items.find((item) => item.role === "user");
		if (userItem === undefined || userItem.role !== "user") continue;
		const assistantText = lastAssistantText(turn.items);
		if (assistantText === undefined) continue;
		out.push({ role: "user", text: textContent(userItem.content) });
		out.push({ role: "assistant", text: assistantText });
	}
	return out;
}

/** 该 turn 最后一条带文本的 assistant item 的拼接文本（无则空——不构成恢复对）。 */
function lastAssistantText(items: readonly RestoredTranscriptMessage[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i -= 1) {
		const item = items[i];
		if (item === undefined || item.role !== "assistant") continue;
		const text = textContent(item.content);
		if (text.length > 0) return text;
	}
	return undefined;
}

function textContent(content: readonly RestoredContent[]): string {
	return content
		.filter((block): block is Extract<RestoredContent, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** 把恢复上下文序列化为注入 runtime 的历史文本（经 retrieval/contextBlocks）——向后兼容路径。 */
export function historyToContextText(history: readonly RestoredMessage[]): string {
	return history.map((message) => `${message.role}: ${message.text}`).join("\n");
}

/** 恢复上下文的短摘要（reference，不进模型上下文正文）。 */
export function historyToReference(history: readonly RestoredMessage[]): string {
	const turns = Math.floor(history.length / 2);
	return `已恢复 ${turns} 轮历史对话（${history.length} 条消息）`;
}
/**
 * Phase-3 (Debussy): build the synthetic summary header that precedes the
 * post-summary structured events in a restored Working Context. Both the
 * Production and Debug planes use this so a freshly-rebuilt context is
 * structurally identical.
 */
export function buildSummaryRestoredMessage(
	summaryText: string,
	throughSequence: number,
	logLevel: SessionLogLevel,
): RestoredContext {
	const prompt = `[prior conversation summary through sequence ${throughSequence}]\n${summaryText}`;
	const userBlock: RestoredContent = { type: "text", text: prompt };
	const assistantBlock: RestoredContent = { type: "text", text: "Understood. I will continue from summary." };
	return {
		messages: [
			{ role: "user", text: prompt },
			{ role: "assistant", text: "Understood. I will continue from summary." },
		],
		transcript: [
			{ role: "user", content: [userBlock] },
			{ role: "assistant", content: [assistantBlock] },
		],
		turns: [
			{
				turnId: null,
				items: [
					{ role: "user", content: [userBlock] },
					{ role: "assistant", content: [assistantBlock] },
				],
			},
		],
		interruptedTurnIds: [],
		skippedEvents: 0,
		droppedChunks: 0,
		errorEventCount: 0,
		observedLogLevel: logLevel,
	};
}

/** WB-008 + Phase-3: merge the synthetic summary header with the post-summary events. */
export function mergeRestored(summary: RestoredContext, recent: RestoredContext): RestoredContext {
	return {
		messages: [...summary.messages, ...recent.messages],
		transcript: [...summary.transcript, ...recent.transcript],
		turns: [...summary.turns, ...recent.turns],
		interruptedTurnIds: [...summary.interruptedTurnIds, ...recent.interruptedTurnIds],
		skippedEvents: summary.skippedEvents + recent.skippedEvents,
		droppedChunks: summary.droppedChunks + recent.droppedChunks,
		errorEventCount: summary.errorEventCount + recent.errorEventCount,
		observedLogLevel: recent.observedLogLevel === "standard" ? summary.observedLogLevel : recent.observedLogLevel,
	};
}

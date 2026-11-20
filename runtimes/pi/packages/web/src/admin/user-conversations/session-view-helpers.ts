/**
 * Session V1 — pure projections shared by Chat / Trajectory / Usage views.
 *
 * All grouping is driven by persisted facts (`turnId`, event type, terminal
 * event, summary `throughSequence`). Nothing here infers Step/Attempt or
 * relies on timestamp / array-position guessing.
 */
import type {
	ConversationAdminDetailResponse,
	ConversationAdminEvent,
	ConversationAdminSummaryEntry,
} from "@earendil-works/pi-protocol";
import { formatBeijing } from "../beijing-time.ts";

/** `legacy_prompt` AaaS runs send this fixed internal trigger as `user/message`. */
export const INTERNAL_TRIGGER_MESSAGE = "执行当前系统提示词指定的任务。";

export function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function readString(record: Record<string, unknown>, key: string): string {
	return typeof record[key] === "string" ? record[key] : "";
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "（不可展示）";
	}
}

export function formatDate(value: string): string {
	return formatBeijing(value);
}

export function formatMetric(value: number | null | undefined): string {
	return value === null || value === undefined ? "未知" : value.toLocaleString();
}

/** Text of a `user/message` or `assistant/message` payload. */
export function messageText(payload: unknown): string {
	return readString(asRecord(payload), "text");
}

/** Error message of a `turn/failed` / `tool/error` payload. */
export function errorMessage(payload: unknown): string {
	const record = asRecord(payload);
	return (
		readString(record, "error") ||
		readString(record, "message") ||
		readString(asRecord(record.error), "message") ||
		safeJson(payload)
	);
}

export type ChatFinalKind = "text" | "completed_no_text" | "failed" | "interrupted" | "in_progress";

export interface ChatTurn {
	readonly key: string;
	readonly turnId: string | null;
	readonly sequence: number;
	readonly inputLabel: "用户消息" | "外部任务";
	readonly inputText: string;
	/** AaaS `legacy_prompt`: the real user/message is an internal trigger, not a business task. */
	readonly triggerSuppressed: boolean;
	readonly llmCalls: number | null;
	readonly toolCalls: number;
	readonly toolErrors: number;
	readonly toolNames: readonly string[];
	readonly toolResults: readonly string[];
	readonly thinking: string | null;
	readonly intermediateMessages: readonly string[];
	readonly finalKind: ChatFinalKind;
	readonly finalText: string;
	readonly compacted: boolean;
}

const TERMINAL_EVENTS = new Set(["turn/end", "turn/failed", "turn/interrupted"]);

/**
 * Build one card per Turn from the append-only event log. The final answer is
 * derived only from a real terminal event — `assistant/message` is written
 * BEFORE `turn/end`, and failed/interrupted turns have no final assistant
 * message at all.
 */
export function buildChatTurns(
	events: readonly ConversationAdminEvent[],
	detail: ConversationAdminDetailResponse,
	summaries: readonly ConversationAdminSummaryEntry[],
): readonly ChatTurn[] {
	const groups = new Map<string, ConversationAdminEvent[]>();
	for (const event of events) {
		const key = event.turnId ?? "__conversation__";
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [event]);
		else group.push(event);
	}
	const turns: ChatTurn[] = [];
	for (const [key, items] of groups) {
		if (key === "__conversation__") continue;
		const terminal = [...items].reverse().find((event) => TERMINAL_EVENTS.has(event.eventType)) ?? null;
		const userEvents = items.filter((event) => event.eventType === "user/message");
		// The internal fixed trigger is only present on AaaS `legacy_prompt` turns.
		// Only those turns borrow the business task; every other turn keeps its
		// own real `user/message`.
		const hasTrigger = userEvents.some((event) => messageText(event.payload) === INTERNAL_TRIGGER_MESSAGE);
		const triggerSuppressed = hasTrigger && detail.taskInput !== null;
		const visibleUserEvents = hasTrigger
			? userEvents.filter((event) => messageText(event.payload) !== INTERNAL_TRIGGER_MESSAGE)
			: userEvents;
		const inputLabel: ChatTurn["inputLabel"] = detail.source === "chat" ? "用户消息" : "外部任务";
		const ownInput = visibleUserEvents.length > 0 ? messageText(visibleUserEvents[0]!.payload) : "";
		const inputText = triggerSuppressed ? (detail.taskInput?.text ?? ownInput) : ownInput;

		const assistantEvents = items.filter((event) => event.eventType === "assistant/message");
		const finalAssistant =
			terminal !== null && terminal.eventType === "turn/end"
				? ([...assistantEvents].reverse().find((event) => event.sequence < terminal.sequence) ?? null)
				: null;
		const finalKind: ChatFinalKind =
			terminal === null
				? "in_progress"
				: terminal.eventType === "turn/failed"
					? "failed"
					: terminal.eventType === "turn/interrupted"
						? "interrupted"
						: finalAssistant === null
							? "completed_no_text"
							: "text";
		const finalText =
			finalKind === "failed" || finalKind === "interrupted"
				? errorMessage(terminal?.payload)
				: finalKind === "text"
					? messageText(finalAssistant?.payload)
					: finalKind === "completed_no_text"
						? "执行完成，但没有产生文本回复。"
						: "该 Turn 尚未结束。";

		const toolCallEvents = items.filter((event) => event.eventType === "tool/call");
		const toolNames = toolCallEvents
			.map((event) => readString(asRecord(event.payload), "toolName"))
			.filter((name) => name !== "");
		const toolResults = items
			.filter((event) => event.eventType === "tool/result" || event.eventType === "tool/error")
			.map((event) => {
				const payload = asRecord(event.payload);
				const content = Array.isArray(payload.content) ? payload.content : [];
				const text = content
					.map((part) => readString(asRecord(part), "text"))
					.filter(Boolean)
					.join("\n")
					.slice(0, 240);
				return text === "" ? readString(payload, "error") || safeJson(payload).slice(0, 240) : text;
			});
		const thinking = assistantEvents
			.map((event) => readString(asRecord(event.payload), "thinking"))
			.filter(Boolean)
			.join("\n");
		const intermediateMessages = assistantEvents
			.filter((event) => event !== finalAssistant)
			.map((event) => messageText(event.payload))
			.filter(Boolean);
		const llmUsage = terminal !== null ? asRecord(asRecord(terminal.payload).llmUsage) : {};
		const llmCalls = typeof llmUsage.callCount === "number" ? llmUsage.callCount : null;
		const sequence = items[0]!.sequence;
		const lastSequence = items[items.length - 1]!.sequence;
		turns.push({
			key,
			turnId: key,
			sequence,
			inputLabel,
			inputText: inputText === "" ? "（无输入记录）" : inputText,
			triggerSuppressed: triggerSuppressed && userEvents.length !== visibleUserEvents.length,
			llmCalls,
			toolCalls: toolCallEvents.length,
			toolErrors: items.filter((event) => event.eventType === "tool/error").length,
			toolNames,
			toolResults,
			thinking: thinking === "" ? null : thinking,
			intermediateMessages,
			finalKind,
			finalText,
			// Compression is a separate fact from real summary records. It never
			// removes or hides the messages above. A Turn counts as compressed
			// only when a summary boundary fully covers it.
			compacted: summaries.some((entry) => entry.throughSequence >= lastSequence),
		});
	}
	return turns;
}

/** Tool events are associated by the stable `toolCallId`, never by ordering. */
export function toolEventsForIds(
	events: readonly ConversationAdminEvent[],
	ids: readonly string[],
): readonly ConversationAdminEvent[] {
	const wanted = new Set(ids);
	if (wanted.size === 0) return [];
	return events.filter(
		(event) =>
			(event.eventType === "tool/call" || event.eventType === "tool/result" || event.eventType === "tool/error") &&
			wanted.has(readString(asRecord(event.payload), "toolCallId")),
	);
}

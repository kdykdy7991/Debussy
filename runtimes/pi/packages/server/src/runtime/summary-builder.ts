/**
 * WB-008: deterministic summary builder (spec §12.2).
 *
 * The summary body is built from the conversation event log without invoking
 * an external model. This keeps the summary generator:
 *
 * - deterministic (same input → same body) so the same `throughSequence`
 *   is replayable for verification,
 * - cheap (no model call) so summarisation can run on every Turn when the
 *   caller wants pre-emptive summaries, and
 * - safe (no model tokens are persisted — we only carry verbatim user /
 *   assistant text fragments and the last user message).
 *
 * The "real" summarisation is delegated to the model's own reasoning when
 * the next Turn runs: the Runtime injects the produced summary body as a
 * System-style message and the model rewrites / validates it. Future work
 * may upgrade the builder to call a small local model, but spec §11.5
 * forbids persisting model API keys and spec §12.2 forbids mixing
 * unverified model inferences with user facts — both align with the
 * current zero-call design.
 */
import type { ConversationEventRecord } from "../publishing/repositories.ts";

export interface BuiltSummary {
	readonly throughSequence: number;
	readonly sourceEventCount: number;
	readonly sourceBytes: number;
	readonly body: {
		readonly text: string;
		readonly keyFacts: readonly string[];
		readonly openItems: readonly string[];
		readonly lastUserMessage: string;
	};
}

/** Default: keep the last 8 completed turns verbatim in the summary body. */
export const DEFAULT_SUMMARY_TURN_WINDOW = 8;

/**
 * Build a deterministic summary from a slice of conversation events.
 *
 * Rules (spec §12.2):
 *
 * - `throughSequence` MUST be the sequence of the last `assistant.message`
 *   in the slice (or 0 when the slice has no assistant messages).
 * - The body contains the last N complete turns (user → assistant).
 * - `keyFacts` is the list of distinct assistant claims; duplicates removed.
 * - `openItems` is the list of user messages without a following assistant
 *   message in the window.
 * - `lastUserMessage` is the verbatim last user message in the window.
 *
 * The function is pure / no I/O; it operates only on the supplied events.
 */
export function buildSummary(
	events: readonly ConversationEventRecord[],
	options: { readonly maxTurns?: number } = {},
): BuiltSummary {
	const maxTurns = options.maxTurns ?? DEFAULT_SUMMARY_TURN_WINDOW;
	const completedTurns: Array<{ turnId: string | null; user: string; assistant: string }> = [];
	const openUserMessages: string[] = [];
	let lastUserMessage = "";
	let pending: { turnId: string | null; text: string } | null = null;

	for (const event of events) {
		const payload = (event.payload ?? {}) as { text?: unknown };
		const text = typeof payload.text === "string" ? payload.text : "";
		if (event.eventType === "user/message" || event.eventType === "user.message") {
			pending = { turnId: event.turnId, text };
			lastUserMessage = text;
		} else if (event.eventType === "assistant/message" || event.eventType === "assistant.completed") {
			if (pending !== null) {
				completedTurns.push({ turnId: pending.turnId, user: pending.text, assistant: text });
				pending = null;
			}
		} else if (event.eventType === "turn/failed" || event.eventType === "turn.failed") {
			// Failed turns must not be carried into the summary body verbatim;
			// drop the pending user message and treat it as abandoned.
			pending = null;
		} else if (event.eventType === "turn/end") {
			// Successful turn end without an assistant.message means we have
			// streamed-only data; we still close the pending user message so
			// the openItems list stays accurate.
			if (pending !== null) {
				openUserMessages.push(pending.text);
				pending = null;
			}
		}
	}
	if (pending !== null) {
		openUserMessages.push(pending.text);
	}

	const windowed = completedTurns.slice(-maxTurns);
	const openItems = dedupe(openUserMessages).slice(-maxTurns);
	const keyFacts = dedupe(windowed.map((turn) => turn.assistant).filter((text) => text.length > 0));

	const text = renderText(windowed, openItems);
	const sourceEventCount = events.length;
	const sourceBytes = events.reduce((sum, event) => sum + event.payloadBytes, 0);

	const lastAssistant = windowed[windowed.length - 1];
	const throughSequence = lastAssistant === undefined ? 0 : sequenceFor(events, lastAssistant.turnId);

	return {
		throughSequence,
		sourceEventCount,
		sourceBytes,
		body: { text, keyFacts, openItems, lastUserMessage },
	};
}

function dedupe(items: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (item.length === 0) continue;
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function renderText(
	turns: readonly { turnId: string | null; user: string; assistant: string }[],
	openItems: readonly string[],
): string {
	const lines: string[] = [];
	lines.push("# Conversation summary");
	lines.push("");
	for (const turn of turns) {
		lines.push("user:");
		lines.push(turn.user);
		lines.push("assistant:");
		lines.push(turn.assistant);
		lines.push("");
	}
	if (openItems.length > 0) {
		lines.push("# Open items");
		for (const item of openItems) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

function sequenceFor(events: readonly ConversationEventRecord[], turnId: string | null): number {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event === undefined) continue;
		if (event.eventType !== "assistant/message" && event.eventType !== "assistant.completed") continue;
		if (turnId !== null && event.turnId !== turnId) continue;
		return event.sequence;
	}
	return 0;
}

/**
 * Debussy-owned compaction / Working Context (Phase-3, spec §12.2v2).
 *
 * These are the pure, deterministic decision + boundary functions behind
 * compaction. They share NOTHING with Pi's SessionManager record tree: the
 * durable boundary is always a Debussy Event sequence (the last COMPLETE,
 * committed Turn's `assistant/message`), never a Pi `firstKeptEntryId`.
 *
 * Responsibilities:
 *
 *  - `workingContextBudget`  — unify the runtime model window and the platform
 *    context budget into one token ceiling for the Working Context:
 *        budget = max(0, min(model.contextWindow, policy.maxContextTokens)
 *                        - safetyReserve - model.maxTokens)
 *    (model window = hard ceiling; policy = optional cap; reserve = output +
 *    safety margin).
 *  - `estimateWorkingContextTokens` — reuse Pi's token estimator
 *    (`estimateTokens`) over the reconstructed structured transcript, so the
 *    trigger tracks the thing that will actually be injected next prompt
 *    rather than a hard-coded chars/4 budget.
 *  - `shouldCompactWorkingContext` — the guard used by the Turn driver.
 *  - `chooseCompactionBoundary` — pick the oldest Turn kept verbatim (recent
 *    window) and the boundary sequence it summarizes up to. The boundary is
 *    always a complete-Turn end, so a toolCall/toolResult is never split and a
 *    pending/in-flight Turn is never collapsed.
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { SessionLogLevel } from "@earendil-works/pi-protocol";
import { toAgentMessages } from "../coding-agent/history-mapper.ts";
import type { ConversationEventRecord } from "../publishing/repositories.ts";
import { restoreContext } from "./context-restore.ts";
import { actualInputTokens, DEFAULT_SAFETY_MARGIN, type UsageTokens } from "./token-accounting.ts";

/**
 * Phase-3.6 budget semantics.
 *
 * The model request cost is split into Working Context (compression-able) and
 * Runtime overhead (not compression-able). The budget reserves the REAL pieces:
 *
 *   budget = max(0, effectiveWindow
 *                    - model.maxTokens          (output budget)
 *                    - runtimeOverhead          (real system/skills/tools cost)
 *                    - nextInputReserve         (space for the unknown next user msg)
 *                    - safetyMargin)            (small error buffer)
 *
 * - `effectiveWindow = min(model.contextWindow, policy.maxContextTokens)`.
 * - `runtimeOverhead` is MEASURED from the last turn's provider usage
 *   (see `deriveMeasuredRuntimeOverhead`); when unavailable it falls back to a
 *   documented conservative fraction of the window — never a fixed 2048.
 * - `nextInputReserve` only applies at turn/end (the next message is unknown);
 *   at pre-prompt the current user message is already inside the estimate, so it
 *   is 0 and the real "next input" is accounted for exactly.
 */

/**
 * Conservative output reservation when a model's `maxTokens` cannot be
 * resolved. Documented as a conservative BOUND, never a correctness claim about
 * the model. Compacts earlier (smaller budget) than the true model would, which
 * is the safe direction.
 */
export const FALLBACK_OUTPUT_RESERVE = 8_192;
/** Verbatim tokens kept after the summary so the next prompt sees concrete recent turns. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * Unify the resolved model window and the Debussy policy budget into one Working
 * Context ceiling. Every term is an explicit, distinct reservation — no single
 * magic number stands in for the real system/skills/tools overhead.
 */
export function workingContextBudget(
	model: { readonly contextWindow?: number; readonly maxTokens?: number },
	policyMaxContextTokens: number,
	options: {
		readonly runtimeOverheadTokens?: number;
		readonly nextInputReserveTokens?: number;
		readonly safetyMarginTokens?: number;
	} = {},
): number {
	const effectiveWindow =
		model.contextWindow !== undefined
			? Math.min(model.contextWindow, policyMaxContextTokens)
			: policyMaxContextTokens;
	if (effectiveWindow <= 0) return 0;
	const outputReserve = model.maxTokens ?? FALLBACK_OUTPUT_RESERVE;
	const runtimeOverhead = options.runtimeOverheadTokens ?? 0;
	const nextReserve = options.nextInputReserveTokens ?? 0;
	const safety = options.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN;
	return Math.max(0, effectiveWindow - outputReserve - runtimeOverhead - nextReserve - safety);
}

/**
 * Derive the MEASURED runtime overhead (system prompt + Skills + tool schemas +
 * fixed request content) from the persisted event stream — no new state, no new
 * table, re-derived every time (works across runtime resets):
 *
 *   measuredOverhead
 *     = actualInputTokens(last turn/end usage)          (real provider input)
 *       - estimateWorkingContextTokens(events of that request)
 *   = max(0, ...)
 *
 * The matching Working Context is the committed events up to the last turn/end
 * that carried real `usage`. An in-flight (pre-prompt) user message sits after
 * that sequence and is excluded, so the measurement stays stable whether called
 * at turn/end or pre-prompt. Returns undefined when no measured usage exists yet
 * (caller applies `conservativeRuntimeOverhead`).
 */
export function deriveMeasuredRuntimeOverhead(
	events: readonly ConversationEventRecord[],
	summaryText: string,
	options: { readonly maxContextTokens?: number; readonly logLevel?: SessionLogLevel } = {},
): number | undefined {
	let lastUsageInput = 0;
	let haveUsage = false;
	let lastUsageSequence = 0;
	for (const event of events) {
		if (event.eventType !== "turn/end" && event.eventType !== "turn.end") continue;
		const payload = (event.payload ?? {}) as { usage?: UsageTokens };
		if (payload.usage === undefined) continue;
		lastUsageInput = actualInputTokens(payload.usage);
		lastUsageSequence = event.sequence;
		haveUsage = true;
	}
	if (!haveUsage) return undefined;

	const requestEvents = events.filter((event) => event.sequence <= lastUsageSequence);
	const workingContext = estimateWorkingContextTokens(requestEvents, summaryText, options);
	return Math.max(0, lastUsageInput - workingContext);
}

/** Estimated tokens of the Working Context that will be handed to the next prompt. */
export function estimateWorkingContextTokens(
	recentEvents: readonly ConversationEventRecord[],
	summaryText: string,
	options: { readonly maxContextTokens?: number; readonly logLevel?: SessionLogLevel } = {},
): number {
	const summaryTokens = estimateTokens({
		role: "user",
		content: [{ type: "text", text: summaryText }],
		timestamp: 0,
	} as never);
	const transcript = restoreContext(
		recentEvents,
		{ maxContextTokens: options.maxContextTokens ?? Number.MAX_SAFE_INTEGER },
		options.logLevel ?? "standard",
	).transcript;
	const recentTokens = toAgentMessages(transcript, { now: 0 }).reduce(
		(sum, msg) => sum + estimateTokens(msg as never),
		0,
	);
	return summaryTokens + recentTokens;
}

/**
 * Estimate the tokens of ONE in-flight user message (the current prompt). A
 * trailing user/message with no assistant is excluded from the restored
 * transcript, so the pre-prompt guard must add it explicitly to the Working
 * Context it compares against the budget.
 */
export function estimateMessageTokens(text: string): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	} as never);
}

/** True when the Working Context has grown past the budget and should be compacted. */
export function shouldCompactWorkingContext(estimatedTokens: number, budget: number): boolean {
	return estimatedTokens > budget;
}

export interface CompactionPlan {
	/** The Debussy event sequence the summary will cover (last complete Turn's end). */
	readonly throughSequence: number;
	/** The events to collapse into the summary (sequence <= throughSequence). */
	readonly summarizeEvents: readonly ConversationEventRecord[];
	/** Events that remain verbatim after the summary (sequence > throughSequence). */
	readonly keepEvents: readonly ConversationEventRecord[];
	/** Compaction is needed (estimate exceeded budget AND at least one full Turn to collapse). */
	readonly shouldCompact: boolean;
}

/**
 * Choose the compaction boundary. Walks complete Turns from newest back,
 * keeping the most recent `keepRecentTokens` verbatim, and summarizes the rest.
 * The boundary is the last summarized Turn's `assistant/message` sequence, so a
 * toolCall/toolResult pairing is never cut and a pending Turn is never dropped.
 */
export function planCompaction(
	recentEvents: readonly ConversationEventRecord[],
	options: {
		readonly keepRecentTokens?: number;
		readonly estimateTokensOverride?: number;
		readonly extraEstimateTokens?: number;
		readonly budget?: number;
		readonly summaryText?: string;
	},
): CompactionPlan {
	const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	const turns = completedTurns(recentEvents);
	if (turns.length === 0) {
		return { throughSequence: 0, summarizeEvents: [], keepEvents: recentEvents, shouldCompact: false };
	}

	// Walk from newest, accruing the verbatim "recent" window.
	let firstKeptTurn: number | null = null;
	let accruedTokens = 0;
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		accruedTokens += (turn.userLen + turn.assistantLen) / 4;
		if (accruedTokens >= keepRecentTokens) {
			firstKeptTurn = i;
			break;
		}
	}

	// Nothing old enough to collapse => no compaction (all turns stay verbatim).
	if (firstKeptTurn === null || firstKeptTurn <= 0) {
		return { throughSequence: 0, summarizeEvents: [], keepEvents: recentEvents, shouldCompact: false };
	}

	const boundaryTurn = turns[firstKeptTurn - 1];
	const cutEventIndex = boundaryTurn.endEventIndex;
	const summarizeEvents = recentEvents.slice(0, cutEventIndex + 1);
	const keepEvents = recentEvents.slice(cutEventIndex + 1);
	const throughSequence = boundaryTurn.assistantSequence;

	// Decide whether to actually compact by the token budget (pure override for
	// tests lets callers short-circuit this without a full transcript build).
	const extraEstimate = options.extraEstimateTokens ?? 0;
	let requiresCompact: boolean;
	if (options.budget !== undefined && options.summaryText !== undefined) {
		const estimated = estimateWorkingContextTokens(recentEvents, options.summaryText) + extraEstimate;
		requiresCompact = shouldCompactWorkingContext(estimated, options.budget);
	} else if (options.estimateTokensOverride !== undefined && options.budget !== undefined) {
		requiresCompact = shouldCompactWorkingContext(options.estimateTokensOverride, options.budget);
	} else {
		requiresCompact = true;
	}

	return {
		throughSequence,
		summarizeEvents,
		keepEvents,
		shouldCompact: requiresCompact,
	};
}

interface TurnSpan {
	readonly turnId: string | null;
	readonly userLen: number;
	readonly assistantLen: number;
	readonly endEventIndex: number;
	readonly assistantSequence: number;
}

/** Extract complete Turns (user -> assistant) from an event slice, oldest first. */
function completedTurns(events: readonly ConversationEventRecord[]): TurnSpan[] {
	const out: TurnSpan[] = [];
	let pending: { turnId: string | null; userLen: number } | null = null;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (event === undefined) continue;
		const payload = (event.payload ?? {}) as { text?: unknown };
		const text = typeof payload.text === "string" ? payload.text : "";
		if (event.eventType === "user/message" || event.eventType === "user.message") {
			pending = { turnId: event.turnId, userLen: text.length };
		} else if (event.eventType === "assistant/message" || event.eventType === "assistant.completed") {
			if (pending !== null) {
				out.push({
					turnId: pending.turnId,
					userLen: pending.userLen,
					assistantLen: text.length,
					endEventIndex: index,
					assistantSequence: event.sequence,
				});
				pending = null;
			}
		} else if (event.eventType === "turn/failed" || event.eventType === "turn.failed") {
			pending = null;
		} else if (event.eventType === "turn/end") {
			if (pending !== null) pending = null;
		}
	}
	return out;
}

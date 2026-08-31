/**
 * Debussy-owned compaction driver (Phase-3).
 *
 * Shared by the Production (embed) and Debug planes so compaction is owned in
 * exactly one place and both planes rebuild an equivalent Working Context.
 * After a completed Turn the driver:
 *
 *   1. loads the head summary and the structured events after its
 *      `throughSequence` (cursor-paginated; never a full-history re-scan),
 *   2. estimates the Working Context that the next prompt would see,
 *   3. if it exceeds the unified budget, picks a boundary = the last COMPLETE
 *      Turn's `assistant/message` sequence and collapses everything before it
 *      (keeping the recent window verbatim),
 *   4. builds a CHAINED summary (previous summary body + recent complete Turns)
 *      and persists it (`previous_summary_id` + cumulative `tokens_before`),
 *   5. advances the plane's `latest_summary_sequence`.
 *
 * The driver is plane-agnostic: it talks to a `DebussyCompactionStore` adapter
 * (events + summaries) so Production `conversation_events`/`conversation_summaries`
 * and Debug `debug_conversation_events`/`debug_conversation_summaries` use the
 * SAME decision + boundary logic and differ only in backing table.
 *
 * The caller then EVICTS the runtime so the next Turn re-seeds a fresh
 * in-memory Pi session from Postgres — guaranteeing the in-memory session is
 * never a divergent second copy of context state.
 *
 * The `throughSequence` boundary is a Debussy Event sequence, never a Pi record id.
 */
import { newConversationSummaryId } from "../publishing/domain/ids.ts";
import type { ConversationEventRecord } from "../publishing/repositories.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { estimateWorkingContextTokens, planCompaction, workingContextBudget } from "./compaction-drive.ts";
import { buildSummary } from "./summary-builder.ts";

/** The summary row shape the driver reads / writes (plane-agnostic). */
export interface DebussySummaryRecord {
	readonly id: string;
	readonly throughSequence: number;
	readonly modelId: string;
	readonly sourceEventCount: number;
	readonly sourceBytes: number;
	readonly body: unknown;
	readonly createdAt: Date;
	readonly previousSummaryId?: string;
	readonly tokensBefore?: number;
}

/** Head-summary accessor; the driver only needs the chaining + budget fields. */
export interface DebussyHeadSummary {
	readonly id: string;
	readonly throughSequence: number;
	readonly tokensBefore?: number;
	readonly body: unknown;
}

/**
 * Plane-agnostic persistence adapter. A concrete adapter per plane decides how
 * events are listed and how summaries are stored/advanced within its own scope.
 */
export interface DebussyCompactionStore {
	/** The latest persisted summary (or null). */
	getLatest(): Promise<DebussyHeadSummary | null>;
	/** List events with sequence `> afterSequence`, capped at `limit` (ascending). */
	listEventsAfter(afterSequence: number, limit: number): Promise<readonly ConversationEventRecord[]>;
	/** Persist a new summary; returns false when the persist failed. */
	insert(record: DebussySummaryRecord): Promise<boolean>;
	/** Advance the plane's latest-summary pointer to `throughSequence`. */
	advanceLatest(throughSequence: number): Promise<void>;
}

export interface DebussyCompactionResult {
	readonly compacted: boolean;
	readonly throughSequence: number | null;
}

export interface DebussyCompactionOptions {
	/** Real model window/max-output when the caller can resolve them (§9). */
	readonly model?: { readonly contextWindow?: number; readonly maxTokens?: number };
	/** When set, forces a compaction decision (tests / headless override). */
	readonly budgetOverride?: number;
}

/**
 * Run one Debussy compaction pass after a completed Turn. Returns whether a new
 * summary was persisted. Safe to call on every Turn — it no-ops until the
 * Working-Context token estimate exceeds the unified budget and there is at
 * least one complete Turn to collapse.
 */
export async function runDebussyCompaction(
	store: DebussyCompactionStore,
	spec: RuntimeSpec,
	options: DebussyCompactionOptions = {},
): Promise<DebussyCompactionResult> {
	const latest = await store.getLatest();
	const afterSequence = latest?.throughSequence ?? 0;
	const recentEvents = await replayAll(store, afterSequence);
	if (recentEvents.length === 0) return { compacted: false, throughSequence: null };

	const summaryText = textOf(latest?.body);
	const budget =
		options.budgetOverride ?? workingContextBudget(options.model ?? {}, spec.contextPolicy.maxContextTokens);
	const plan = planCompaction(recentEvents, { budget, summaryText });
	if (!plan.shouldCompact || plan.throughSequence <= 0) return { compacted: false, throughSequence: null };

	const built = buildSummary(plan.summarizeEvents, {
		...(latest?.body !== undefined ? { previousBody: bodyOf(latest.body) } : {}),
	});
	// The boundary must be the durable event sequence — derived by both builders
	// from the last assistant/message of the summarized slice.
	const throughSequence = plan.throughSequence;
	const collapsedNow = Math.round(estimateWorkingContextTokens(plan.summarizeEvents, ""));
	const tokensBefore = (latest?.tokensBefore ?? 0) + collapsedNow;

	const record: DebussySummaryRecord = {
		id: newConversationSummaryId(),
		throughSequence,
		modelId: spec.agent.model.modelId === "" ? "(debussy-compaction)" : spec.agent.model.modelId,
		sourceEventCount: built.sourceEventCount,
		sourceBytes: built.sourceBytes,
		body: built.body,
		createdAt: new Date(),
		previousSummaryId: latest?.id,
		tokensBefore,
	};
	const inserted = await store.insert(record);
	if (!inserted) return { compacted: false, throughSequence: null };
	await store.advanceLatest(throughSequence);
	return { compacted: true, throughSequence };
}

async function replayAll(
	store: DebussyCompactionStore,
	afterSequence: number,
): Promise<readonly ConversationEventRecord[]> {
	const pageSize = 500;
	const maxPages = 1000;
	const out: ConversationEventRecord[] = [];
	for (let page = 0; page < maxPages; page += 1) {
		const events = await store.listEventsAfter(afterSequence, pageSize);
		out.push(...events);
		if (events.length < pageSize) break;
		if (events.length === 0) break;
		afterSequence = events[events.length - 1].sequence;
	}
	return out;
}

function textOf(body: unknown): string {
	return body === undefined || body === null ? "" : ((body as { text?: string }).text ?? "");
}

function bodyOf(body: unknown): { text: string; keyFacts: string[]; openItems: string[]; lastUserMessage: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	return {
		text: typeof b.text === "string" ? b.text : "",
		keyFacts: Array.isArray(b.keyFacts) ? (b.keyFacts as string[]) : [],
		openItems: Array.isArray(b.openItems) ? (b.openItems as string[]) : [],
		lastUserMessage: typeof b.lastUserMessage === "string" ? b.lastUserMessage : "",
	};
}

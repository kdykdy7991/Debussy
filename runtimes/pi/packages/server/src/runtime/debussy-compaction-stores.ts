/**
 * Concrete `DebussyCompactionStore` adapters (Phase-3).
 *
 * The compaction driver (`runDebussyCompaction`) is plane-agnostic; each plane
 * supplies an adapter so both share the same Working-Context decision/boundary
 * logic while persisting to its own backing tables:
 *
 *  - Production: `conversation_events` + `conversation_summaries` (scoped by
 *    OwnerScope + conversation).
 *  - Debug:      `debug_conversation_events` + Debug summary storage (scoped by
 *    a Debug conversation).
 */

import type { DebugConversationRef, DebugRepositories } from "../publishing/debug/types.ts";
import type { ConversationId } from "../publishing/domain/ids.ts";
import type {
	ConversationEventRecord,
	ConversationSummaryRecord,
	OwnerScope,
	PublishingRepositories,
} from "../publishing/repositories.ts";
import type { DebussyCompactionStore, DebussySummaryRecord } from "./debussy-compaction.ts";

/** Production adapter over `conversation_events`/`conversation_summaries`. */
export function createConversationEventCompactionStore(
	repos: Pick<PublishingRepositories, "events" | "summaries" | "conversations">,
	scope: OwnerScope,
	conversationId: ConversationId,
): DebussyCompactionStore {
	return {
		async getLatest() {
			const s = await repos.summaries.getLatest(scope, conversationId);
			return s === undefined
				? null
				: { id: s.id, throughSequence: s.throughSequence, tokensBefore: s.tokensBefore, body: s.body };
		},
		listEventsAfter(afterSequence, limit) {
			return repos.events.list(scope, conversationId, { limit, afterSequence });
		},
		async insert(record) {
			const res = await repos.summaries.insert(scope, toConversationSummary(scope, conversationId, record));
			return res.outcome === "inserted";
		},
		async advanceLatest(throughSequence) {
			await repos.conversations.updateLatestSummarySequence(scope, conversationId, throughSequence);
		},
	};
}

/** Map the plane-agnostic record onto the Production summary repository shape. */
export function toConversationSummary(
	scope: OwnerScope,
	conversationId: ConversationId,
	record: DebussySummaryRecord,
): ConversationSummaryRecord {
	return {
		id: record.id,
		tenantId: scope.tenantId,
		publishedAppId: scope.publishedAppId,
		ownerPrincipalId: scope.principalId,
		conversationId,
		throughSequence: record.throughSequence,
		modelId: record.modelId,
		sourceEventCount: record.sourceEventCount,
		sourceBytes: record.sourceBytes,
		body: record.body,
		createdAt: record.createdAt,
		previousSummaryId: record.previousSummaryId,
		tokensBefore: record.tokensBefore,
	};
}

export type { ConversationEventRecord, DebussyCompactionStore };

/**
 * Debug adapter over `debug_conversation_events` / `debug_conversation_summaries`.
 * `advanceLatest` is a no-op because the Debug summary repo reads the head
 * summary as the max `through_sequence` row (no separate pointer column).
 */
export function createDebugConversationEventCompactionStore(
	debug: DebugRepositories,
	ref: DebugConversationRef,
): DebussyCompactionStore {
	return {
		async getLatest() {
			const s = await debug.summaries.getLatest(ref);
			return s === undefined
				? null
				: { id: s.id, throughSequence: s.throughSequence, tokensBefore: s.tokensBefore, body: s.body };
		},
		async listEventsAfter(afterSequence, limit) {
			// Debug events are structurally aligned with `ConversationEventRecord`
			// (sequence/eventType/turnId/payload/createdAt); cast for the shared
			// driver which only reads those fields.
			return (await debug.events.list(ref, {
				limit,
				afterSequence,
			})) as unknown as readonly ConversationEventRecord[];
		},
		async insert(record) {
			return debug.summaries.insert(ref, {
				id: record.id,
				tenantId: ref.tenantId,
				ownerPrincipalId: ref.ownerPrincipalId,
				debugConversationId: ref.debugConversationId,
				throughSequence: record.throughSequence,
				modelId: record.modelId,
				sourceEventCount: record.sourceEventCount,
				sourceBytes: record.sourceBytes,
				body: record.body,
				createdAt: record.createdAt,
				previousSummaryId: record.previousSummaryId,
				tokensBefore: record.tokensBefore,
			});
		},
		async advanceLatest() {},
	};
}

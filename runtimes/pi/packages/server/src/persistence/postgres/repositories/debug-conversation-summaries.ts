/**
 * PostgreSQL implementation of the Debug Conversation summary repository
 * (Phase-3 Debussy). Writes only to `debug_conversation_summaries` — never the
 * Production `conversation_summaries` stream — scoped by a Debug conversation.
 * `getLatest` returns the highest `through_sequence` row for the conversation.
 */
import type {
	DebugConversationSummaryRecord,
	DebugConversationSummaryRepository,
} from "../../../publishing/debug/types.ts";
import type { DebugConversationId, PrincipalId, TenantId } from "../../../publishing/domain/ids.ts";
import type { PostgresClient, SqlParameter } from "../client.ts";

function rowToRecord(row: Record<string, unknown>): DebugConversationSummaryRecord {
	return {
		id: String(row.id),
		tenantId: row.tenant_id as TenantId,
		ownerPrincipalId: row.owner_principal_id as PrincipalId,
		debugConversationId: row.debug_conversation_id as DebugConversationId,
		throughSequence: Number(row.through_sequence),
		modelId: String(row.model_id),
		sourceEventCount: Number(row.source_event_count),
		sourceBytes: Number(row.source_bytes),
		body: row.body,
		createdAt: row.created_at as Date,
		previousSummaryId: (row.previous_summary_id ?? undefined) as string | undefined,
		tokensBefore:
			row.tokens_before === null || row.tokens_before === undefined ? undefined : Number(row.tokens_before),
	};
}

export function createDebugConversationSummaryRepository(client: PostgresClient): DebugConversationSummaryRepository {
	return {
		async getLatest(ref) {
			const rows = await client.run(
				`select s.* from debug_conversation_summaries s
				 join debug_conversations c on c.id = s.debug_conversation_id
				  where s.debug_conversation_id = $1 and c.tenant_id = $2 and c.owner_principal_id = $3
				 order by s.through_sequence desc
				 limit 1`,
				ref.debugConversationId,
				ref.tenantId,
				ref.ownerPrincipalId,
			);
			return rows.length === 0 ? undefined : rowToRecord(rows[0] as Record<string, unknown>);
		},
		async insert(ref, record) {
			try {
				await client.run(
					`insert into debug_conversation_summaries
					 (id, tenant_id, owner_principal_id, debug_conversation_id,
					  through_sequence, model_id, source_event_count, source_bytes, body,
					  created_at, previous_summary_id, tokens_before)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
					record.id,
					ref.tenantId,
					ref.ownerPrincipalId,
					ref.debugConversationId,
					record.throughSequence,
					record.modelId,
					record.sourceEventCount,
					record.sourceBytes,
					record.body as SqlParameter,
					record.createdAt,
					record.previousSummaryId ?? null,
					record.tokensBefore ?? null,
				);
				return true;
			} catch {
				return false;
			}
		},
	};
}

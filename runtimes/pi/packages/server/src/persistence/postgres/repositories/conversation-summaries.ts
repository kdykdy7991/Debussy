/**
 * WB-008: Conversation summary repository.
 *
 * A summary is a frozen snapshot at a complete-Turn boundary. We never edit
 * a summary: the `(conversation_id, through_sequence)` uniqueness turns any
 * duplicate write into a `duplicate` outcome instead of a constraint error.
 *
 * The summary body is JSONB and is opaque to the repository. The protocol
 * layer's `assertEventPayloadSafe` is the boundary that enforces sensitive
 * field rejection; this repository trusts the shape it receives and only
 * checks JSON-serialisability on the way in.
 */
import type {
	ConversationId,
	ConversationSummaryId,
	PrincipalId,
	PublishedAppId,
	TenantId,
} from "../../../publishing/domain/ids.ts";
import type {
	ConversationSummaryRecord,
	ConversationSummaryRepository,
	OwnerScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient, SqlParameter } from "../client.ts";

function rowToRecord(row: Record<string, unknown>): ConversationSummaryRecord {
	return {
		id: row.id as ConversationSummaryId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId,
		ownerPrincipalId: row.owner_principal_id as PrincipalId,
		conversationId: row.conversation_id as ConversationId,
		throughSequence: Number(row.through_sequence),
		modelId: String(row.model_id),
		sourceEventCount: Number(row.source_event_count),
		sourceBytes: Number(row.source_bytes),
		body: row.body,
		createdAt: row.created_at as Date,
		previousSummaryId: (row.previous_summary_id ?? undefined) as ConversationSummaryId | undefined,
		tokensBefore: row.tokens_before === null || row.tokens_before === undefined ? undefined : Number(row.tokens_before),
	};
}

export function createConversationSummaryRepository(client: PostgresClient): ConversationSummaryRepository {
	return {
		async insert(scope: OwnerScope, record: ConversationSummaryRecord) {
			try {
				await client.run(
					`insert into conversation_summaries
					 (id, tenant_id, published_app_id, owner_principal_id, conversation_id,
					  through_sequence, model_id, source_event_count, source_bytes, body, created_at,
					  previous_summary_id, tokens_before)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
					record.id,
					scope.tenantId,
					scope.publishedAppId,
					scope.principalId,
					record.conversationId,
					record.throughSequence,
					record.modelId,
					record.sourceEventCount,
					record.sourceBytes,
					record.body as SqlParameter,
					record.createdAt,
					record.previousSummaryId ?? null,
					record.tokensBefore ?? null,
				);
				return { outcome: "inserted" as const };
			} catch (error) {
				// `23505` is the postgres unique-violation SQLSTATE.
				if (
					error !== null &&
					typeof error === "object" &&
					"code" in error &&
					(error as { code?: string }).code === "23505"
				) {
					return { outcome: "duplicate" as const };
				}
				throw error;
			}
		},
		async getLatest(scope: OwnerScope, conversationId: ConversationId) {
			const rows = await client.run(
				`select * from conversation_summaries
				 where conversation_id = $1 and tenant_id = $2 and published_app_id = $3
				   and owner_principal_id = $4
				 order by through_sequence desc
				 limit 1`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async list(scope: OwnerScope, conversationId: ConversationId) {
			const rows = await client.run(
				`select * from conversation_summaries
				 where conversation_id = $1 and tenant_id = $2 and published_app_id = $3
				   and owner_principal_id = $4
				 order by through_sequence desc`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
			);
			return rows.map((row) => rowToRecord(row));
		},
	};
}

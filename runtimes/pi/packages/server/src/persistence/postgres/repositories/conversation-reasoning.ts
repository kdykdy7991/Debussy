import type { ReasoningEffort } from "@earendil-works/pi-protocol";
import type { ConversationId } from "../../../publishing/domain/ids.ts";
import type {
	ConversationReasoningRepository,
	ConversationReasoningStateRecord,
	OwnerScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function rowToRecord(row: Record<string, unknown>): ConversationReasoningStateRecord {
	return {
		conversationId: row.conversation_id as ConversationId,
		tenantId: row.tenant_id as ConversationReasoningStateRecord["tenantId"],
		publishedAppId: row.published_app_id as ConversationReasoningStateRecord["publishedAppId"],
		ownerPrincipalId: row.owner_principal_id as ConversationReasoningStateRecord["ownerPrincipalId"],
		effort: (row.effort as ReasoningEffort | null) ?? null,
		updatedBy: String(row.updated_by),
		requestId: row.request_id as ConversationReasoningStateRecord["requestId"],
		updatedAt: row.updated_at as Date,
	};
}

export function createConversationReasoningRepository(client: PostgresClient): ConversationReasoningRepository {
	return {
		async get(scope: OwnerScope, conversationId) {
			const rows = await client.run(
				`select * from conversation_reasoning_state
				 where conversation_id = $1 and tenant_id = $2
				   and published_app_id = $3 and owner_principal_id = $4`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async upsert(record: ConversationReasoningStateRecord) {
			await client.run(
				`insert into conversation_reasoning_state
					(conversation_id, tenant_id, published_app_id, owner_principal_id,
					 effort, updated_by, request_id, updated_at)
				 values ($1, $2, $3, $4, $5::text, $6, $7::uuid, now())
				 on conflict (conversation_id) do update set
					effort = excluded.effort,
					updated_by = excluded.updated_by,
					request_id = excluded.request_id,
					updated_at = now()`,
				record.conversationId,
				record.tenantId,
				record.publishedAppId,
				record.ownerPrincipalId,
				record.effort,
				record.updatedBy,
				record.requestId,
			);
		},
	};
}

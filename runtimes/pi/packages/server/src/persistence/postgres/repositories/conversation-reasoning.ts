import type { ReasoningEffort } from "@earendil-works/pi-protocol";
import type { ConversationId } from "../../../publishing/domain/ids.ts";
import type {
	AuditEventRecord,
	ConversationReasoningRepository,
	ConversationReasoningStateRecord,
	OwnerScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

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

const STATE_SELECT = `select * from conversation_reasoning_state
	 where conversation_id = $1 and tenant_id = $2
	   and published_app_id = $3 and owner_principal_id = $4`;

const STATE_UPSERT = `insert into conversation_reasoning_state
	(conversation_id, tenant_id, published_app_id, owner_principal_id,
	 effort, updated_by, request_id, updated_at)
	 values ($1, $2, $3, $4, $5::text, $6, $7::uuid, now())
	 on conflict (conversation_id) do update set
		effort = excluded.effort,
		updated_by = excluded.updated_by,
		request_id = excluded.request_id,
		updated_at = now()`;

const AUDIT_INSERT = `insert into audit_events
	(id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
	 request_id, metadata, created_at)
	 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

export function createConversationReasoningRepository(client: PostgresClient): ConversationReasoningRepository {
	return {
		async get(scope: OwnerScope, conversationId) {
			const rows = await client.run(
				STATE_SELECT,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async upsert(record: ConversationReasoningStateRecord) {
			await client.run(
				STATE_UPSERT,
				record.conversationId,
				record.tenantId,
				record.publishedAppId,
				record.ownerPrincipalId,
				record.effort,
				record.updatedBy,
				record.requestId,
			);
		},
		async setEffortWithAudit({ state, audit }) {
			return client.transaction(async (tx) => {
				const scope = {
					tenantId: state.tenantId,
					publishedAppId: state.publishedAppId,
					principalId: state.ownerPrincipalId,
				};
				const beforeRows = await txRows(
					tx,
					STATE_SELECT,
					state.conversationId,
					scope.tenantId,
					scope.publishedAppId,
					scope.principalId,
				);
				const before = beforeRows.length === 1 ? rowToRecord(beforeRows[0]) : undefined;
				await txRows(
					tx,
					STATE_UPSERT,
					state.conversationId,
					state.tenantId,
					state.publishedAppId,
					state.ownerPrincipalId,
					state.effort,
					state.updatedBy,
					state.requestId,
				);
				const auditRecord = audit(before);
				await txRows(
					tx,
					AUDIT_INSERT,
					auditRecord.auditEventId,
					auditRecord.tenantId,
					auditRecord.actorType,
					auditRecord.actorId,
					auditRecord.action,
					auditRecord.resourceType,
					auditRecord.resourceId,
					auditRecord.requestId,
					auditRecord.metadata as object,
					auditRecord.createdAt,
				);
				return before;
			});
		},
	};
}

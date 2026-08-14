import type {
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	TenantId,
} from "../../../publishing/domain/ids.ts";
import type {
	ConversationListRow,
	ConversationRecord,
	ConversationRepository,
	OwnerScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function rowToRecord(row: Record<string, unknown>): ConversationRecord {
	return {
		conversationId: row.id as ConversationId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId,
		publishedAppVersionId: row.published_app_version_id as PublishedAppVersionId,
		ownerPrincipalId: row.owner_principal_id as PrincipalId,
		title: String(row.title),
		status: row.status as ConversationRecord["status"],
		lastEventSequence: Number(row.last_event_sequence),
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
		lastActiveAt: row.last_active_at as Date,
	};
}

function toListRow(record: ConversationRecord): ConversationListRow {
	return {
		...record,
		cursor: `${record.lastActiveAt.toISOString()}|${record.conversationId}`,
	};
}

/**
 * Conversation repository. Every read embeds the full ownership scope
 * (tenant + app + owner principal) in SQL; a bare id lookup is impossible.
 * `nextEventSequence` uses the atomic `UPDATE ... RETURNING` pattern from
 * spec 26.3 so sequence allocation can never double-issue under concurrency.
 */
export function createConversationRepository(client: PostgresClient): ConversationRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into conversations
				 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id,
				  title, status, last_event_sequence, created_at, updated_at, last_active_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
				record.conversationId,
				record.tenantId,
				record.publishedAppId,
				record.publishedAppVersionId,
				record.ownerPrincipalId,
				record.title,
				record.status,
				record.lastEventSequence,
				record.createdAt,
				record.updatedAt,
				record.lastActiveAt,
			);
		},
		async get(scope: OwnerScope, conversationId) {
			const rows = await client.run(
				`select * from conversations
				 where id = $1 and tenant_id = $2 and published_app_id = $3 and owner_principal_id = $4
				   and deleted_at is null`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async list(params) {
			const limit = Math.min(Math.max(params.limit, 1), 100);
			let cursorWhere = "";
			const cursorParams: (string | number)[] = [];
			if (params.cursor !== undefined && params.cursor !== "") {
				const [lastActiveAt, id] = params.cursor.split("|");
				if (lastActiveAt !== undefined && id !== undefined) {
					cursorWhere = "and (last_active_at, id) < ($4::timestamptz, $5::uuid)";
					cursorParams.push(lastActiveAt, id);
				}
			}
			// Cursor mode adds two parameters, so the limit placeholder shifts.
			const limitIndex = cursorParams.length > 0 ? 6 : 4;
			const rows = await client.run(
				`select * from conversations
				 where tenant_id = $1 and published_app_id = $2 and owner_principal_id = $3
				   and deleted_at is null and status = 'active'
				   ${cursorWhere}
				 order by last_active_at desc, id desc
				 limit $${limitIndex}`,
				params.scope.tenantId,
				params.scope.publishedAppId,
				params.scope.principalId,
				...cursorParams,
				limit + 1,
			);
			return rows.slice(0, limit).map((row) => toListRow(rowToRecord(row)));
		},
		async updateStatus(scope: OwnerScope, conversationId, status) {
			await client.run(
				`update conversations set status = $4, updated_at = now()
				 where id = $1 and tenant_id = $2 and published_app_id = $3 and owner_principal_id = $5
				   and deleted_at is null`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				status,
				scope.principalId,
			);
		},
		async nextEventSequence(scope: OwnerScope, conversationId) {
			const rows = await client.run(
				`update conversations
				 set last_event_sequence = last_event_sequence + 1, updated_at = now(), last_active_at = now()
				 where id = $1 and tenant_id = $2 and published_app_id = $3 and owner_principal_id = $4
				   and deleted_at is null
				 returning last_event_sequence`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
			);
			return rows.length === 1 ? Number(rows[0].last_event_sequence) : undefined;
		},
	};
}

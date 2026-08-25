/**
 * Audit event repository (append-only, spec section 26.2 / 13.4).
 *
 * Every control-plane state change (publish, rollback, suspend, key
 * operations) appends one row. Rows are never updated or deleted; `metadata`
 * holds a small JSON object, never conversation bodies.
 */
import type { AuditEventId, RequestId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AuditEventListParams,
	AuditEventListRow,
	AuditEventRecord,
	AuditEventRepository,
	TenantScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function toListRow(record: AuditEventRecord): AuditEventListRow {
	return {
		...record,
		cursor: `${record.createdAt.toISOString()}|${record.auditEventId}`,
	};
}

function rowToRecord(row: Record<string, unknown>): AuditEventRecord {
	return {
		auditEventId: row.id as AuditEventId,
		tenantId: row.tenant_id as TenantId,
		actorType: String(row.actor_type),
		actorId: String(row.actor_id),
		action: String(row.action),
		resourceType: String(row.resource_type),
		resourceId: String(row.resource_id),
		requestId: row.request_id as RequestId,
		metadata: row.metadata,
		createdAt: row.created_at as Date,
	};
}

export function createAuditEventRepository(client: PostgresClient): AuditEventRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into audit_events
				 (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
				  request_id, metadata, created_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				record.auditEventId,
				record.tenantId,
				record.actorType,
				record.actorId,
				record.action,
				record.resourceType,
				record.resourceId,
				record.requestId,
				record.metadata as object,
				record.createdAt,
			);
		},
		async listByTenant(scope: TenantScope, limit) {
			const rows = await client.run(
				"select * from audit_events where tenant_id = $1 order by created_at desc, id desc limit $2",
				scope.tenantId,
				Math.min(Math.max(limit, 1), 100),
			);
			return rows.map((row) => rowToRecord(row));
		},
		async list(params: AuditEventListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 100);
			const values: (string | null)[] = [params.scope.tenantId];
			// Optional app filter resolves the app's own events plus its
			// launch-key events (which are keyed by the host-facing keyId).
			let appWhere = "";
			if (params.appId !== undefined) {
				const idx = values.length + 1;
				appWhere =
					"and ((resource_type = 'published_app' and resource_id = $" +
					idx +
					"::text) or (resource_type = 'embed_launch_key' and resource_id in " +
					"(select key_id from embed_launch_keys where tenant_id = $1 and published_app_id = $" +
					idx +
					"::uuid)))";
				values.push(params.appId);
			}
			let cursorWhere = "";
			if (params.cursor !== undefined && params.cursor !== "") {
				const [createdAt, id] = params.cursor.split("|");
				if (createdAt !== undefined && id !== undefined) {
					const first = values.length + 1;
					cursorWhere = `and (created_at, id) < ($${first}::timestamptz, $${first + 1}::uuid)`;
					values.push(createdAt, id);
				}
			}
			const limitIndex = values.length + 1;
			const rows = await client.run(
				`select * from audit_events
				 where tenant_id = $1 ${appWhere} ${cursorWhere}
				 order by created_at desc, id desc
				 limit $${limitIndex}`,
				...values,
				limit + 1,
			);
			return rows.map((row) => toListRow(rowToRecord(row)));
		},
	};
}

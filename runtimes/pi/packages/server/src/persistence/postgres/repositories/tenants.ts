import type { TenantId } from "../../../publishing/domain/ids.ts";
import type { TenantRecord, TenantRepository } from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function rowToRecord(row: Record<string, unknown>): TenantRecord {
	return {
		tenantId: row.id as TenantId,
		name: String(row.name),
		status: row.status as TenantRecord["status"],
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

/** Scoped tenant repository (bootstrap upsert is idempotent). */
export function createTenantRepository(client: PostgresClient): TenantRepository {
	return {
		async upsert(record) {
			const rows = await client.run(
				`insert into tenants (id, name, status, created_at, updated_at)
				 values ($1, $2, $3, $4, $5)
				 on conflict (id) do update set
				   name = excluded.name,
				   status = excluded.status,
				   updated_at = now()
				 returning *`,
				record.tenantId,
				record.name,
				record.status,
				record.createdAt,
				record.updatedAt,
			);
			return rowToRecord(rows[0]);
		},
		async get(tenantId) {
			const rows = await client.run("select * from tenants where id = $1", tenantId);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
	};
}

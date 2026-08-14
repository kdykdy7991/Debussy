import { createHash } from "node:crypto";
import type { PrincipalId, PublishedAppId, TenantId } from "../../../publishing/domain/ids.ts";
import type { AppScope, PrincipalRecord, PrincipalRepository, TenantScope } from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

/** Stable subject hash for the tenant's platform service principal (33.1). */
export function platformPrincipalSubjectHash(tenantId: TenantId): string {
	return createHash("sha256").update(`control:${tenantId}`, "utf8").digest("hex");
}

function rowToRecord(row: Record<string, unknown>): PrincipalRecord {
	return {
		principalId: row.id as PrincipalId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: (row.published_app_id as PublishedAppId | null) ?? null,
		principalType: row.principal_type as PrincipalRecord["principalType"],
		subjectHash: String(row.subject_hash),
		status: row.status as PrincipalRecord["status"],
		createdAt: row.created_at as Date,
		lastSeenAt: row.last_seen_at as Date,
	};
}

/**
 * Principal repository. Upserts are scoped by the full
 * `(tenant, app, type, subjectHash)` triple; lookups require the tenant + app
 * scope so the same raw subject never resolves across apps (AD-09 / spec 5.2).
 */
export function createPrincipalRepository(client: PostgresClient): PrincipalRepository {
	return {
		async upsert(record) {
			const rows = await client.run(
				`insert into principals
				 (id, tenant_id, published_app_id, principal_type, subject_hash, status, created_at, last_seen_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8)
				 on conflict (tenant_id, published_app_id, principal_type, subject_hash)
				 do update set last_seen_at = now()
				 returning *`,
				record.principalId,
				record.tenantId,
				record.publishedAppId,
				record.principalType,
				record.subjectHash,
				record.status,
				record.createdAt,
				record.lastSeenAt,
			);
			return rowToRecord(rows[0]);
		},
		async upsertPlatform(scope: TenantScope) {
			const rows = await client.run(
				`insert into principals
				 (id, tenant_id, published_app_id, principal_type, subject_hash, status, created_at, last_seen_at)
				 values ($1, $2, null, 'service', $3, 'active', now(), now())
				 on conflict (tenant_id, id)
				 do update set last_seen_at = now()
				 returning *`,
				scope.tenantId,
				scope.tenantId,
				platformPrincipalSubjectHash(scope.tenantId),
			);
			return rowToRecord(rows[0]);
		},
		async get(scope: AppScope, principalId) {
			const rows = await client.run(
				"select * from principals where id = $1 and tenant_id = $2 and published_app_id = $3",
				principalId,
				scope.tenantId,
				scope.publishedAppId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getBySubject(scope: AppScope, principalType, subjectHash) {
			const rows = await client.run(
				"select * from principals where tenant_id = $1 and published_app_id = $2 and principal_type = $3 and subject_hash = $4",
				scope.tenantId,
				scope.publishedAppId,
				principalType,
				subjectHash,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async touch(scope: AppScope, principalId) {
			await client.run(
				"update principals set last_seen_at = now() where id = $1 and tenant_id = $2 and published_app_id = $3",
				principalId,
				scope.tenantId,
				scope.publishedAppId,
			);
		},
	};
}

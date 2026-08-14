import type { PublishedAppId, PublishedAppVersionId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AppScope,
	PublishedAppVersionRecord,
	PublishedAppVersionRepository,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

function rowToRecord(row: Record<string, unknown>): PublishedAppVersionRecord {
	return {
		publishedAppVersionId: row.id as PublishedAppVersionId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId,
		versionNumber: Number(row.version_number),
		sourceAgentRevision: Number(row.source_agent_revision),
		snapshot: row.snapshot,
		runtimeSpec: row.runtime_spec,
		runtimeSpecHash: row.runtime_spec_hash === null ? null : String(row.runtime_spec_hash),
		status: row.status as PublishedAppVersionRecord["status"],
		validationErrors: (row.validation_errors as unknown as readonly unknown[]) ?? [],
		createdAt: row.created_at as Date,
	};
}

/**
 * PublishedAppVersion repository. Versions are immutable: the repository only
 * inserts and transitions status (validating -> ready/rejected -> retired);
 * there is no update path for snapshot/runtime_spec (spec AD-03 / section 26.4).
 */
export function createPublishedAppVersionRepository(client: PostgresClient): PublishedAppVersionRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into published_app_versions
				 (id, tenant_id, published_app_id, version_number, source_agent_revision,
				  snapshot, runtime_spec, runtime_spec_hash, status, validation_errors, created_by, created_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $2, $11)`,
				record.publishedAppVersionId,
				record.tenantId,
				record.publishedAppId,
				record.versionNumber,
				record.sourceAgentRevision,
				record.snapshot as object,
				record.runtimeSpec as object,
				record.runtimeSpecHash,
				record.status,
				record.validationErrors ?? [],
				record.createdAt,
			);
		},
		async get(scope: AppScope, publishedAppVersionId) {
			const rows = await client.run(
				"select * from published_app_versions where id = $1 and tenant_id = $2 and published_app_id = $3",
				publishedAppVersionId,
				scope.tenantId,
				scope.publishedAppId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async nextVersionNumber(scope: AppScope, publishedAppId) {
			const rows = await client.run(
				"select coalesce(max(version_number), 0) + 1 as next from published_app_versions where published_app_id = $1 and tenant_id = $2",
				publishedAppId,
				scope.tenantId,
			);
			return Number(rows[0]?.next ?? 1);
		},
		async createVersion(scope, input) {
			return client.transaction(async (tx) => {
				// Lock the app row so concurrent creates serialize on one
				// version-number stream (the same app row is the lock target
				// every time, so there is no deadlock between creates).
				const locked = await txRows(
					tx,
					"select id from published_apps where id = $1 and tenant_id = $2 for update",
					input.publishedAppId,
					scope.tenantId,
				);
				if (locked.length !== 1) throw new Error("published app not found in scope");
				const nextRows = await txRows(
					tx,
					"select coalesce(max(version_number), 0) + 1 as next from published_app_versions where published_app_id = $1 and tenant_id = $2",
					input.publishedAppId,
					scope.tenantId,
				);
				const versionNumber = Number(nextRows[0]?.next ?? 1);
				await txRows(
					tx,
					`insert into published_app_versions
					 (id, tenant_id, published_app_id, version_number, source_agent_revision,
					  snapshot, runtime_spec, runtime_spec_hash, status, validation_errors, created_by, created_at)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $2, $11)`,
					input.publishedAppVersionId,
					input.tenantId,
					input.publishedAppId,
					versionNumber,
					input.sourceAgentRevision,
					input.snapshot as object,
					input.runtimeSpec as object,
					input.runtimeSpecHash,
					input.status,
					input.validationErrors ?? [],
					input.createdAt,
				);
				return {
					...input,
					versionNumber,
					validationErrors: input.validationErrors ?? [],
				} as PublishedAppVersionRecord;
			});
		},
		async updateStatus(scope: AppScope, publishedAppVersionId, status, validationErrors) {
			await client.run(
				"update published_app_versions set status = $3, validation_errors = $4 where id = $1 and tenant_id = $2",
				publishedAppVersionId,
				scope.tenantId,
				status,
				validationErrors ?? [],
			);
		},
	};
}

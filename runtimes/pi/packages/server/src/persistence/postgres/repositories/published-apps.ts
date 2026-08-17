import type { PublishedAppId, PublishedAppVersionId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AppScope,
	PublishedAppListParams,
	PublishedAppListRow,
	PublishedAppRecord,
	PublishedAppRepository,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

function toListRow(record: PublishedAppRecord): PublishedAppListRow {
	return {
		...record,
		cursor: `${record.createdAt.toISOString()}|${record.publishedAppId}`,
	};
}

function rowToRecord(row: Record<string, unknown>): PublishedAppRecord {
	return {
		publishedAppId: row.id as PublishedAppId,
		tenantId: row.tenant_id as TenantId,
		agentDefinitionId: row.agent_definition_id as PublishedAppRecord["agentDefinitionId"],
		publicAppId: String(row.public_app_id),
		name: String(row.name),
		status: row.status as PublishedAppRecord["status"],
		accessMode: row.access_mode as PublishedAppRecord["accessMode"],
		currentVersionId: (row.current_version_id as PublishedAppRecord["currentVersionId"] | null) ?? null,
		allowedOrigins: (row.allowed_origins as unknown as readonly string[]) ?? [],
		mutablePolicy: row.mutable_policy,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

/**
 * PublishedApp repository. All reads are scoped by tenant except
 * `getByPublicAppId`, which resolves the globally-unique public locator for
 * the public Exchange endpoint (the discovered tenant then scopes everything
 * downstream).
 */
export function createPublishedAppRepository(client: PostgresClient): PublishedAppRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into published_apps
				 (id, tenant_id, agent_definition_id, public_app_id, name, status, access_mode,
				  current_version_id, allowed_origins, mutable_policy, created_by, created_at, updated_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $2, $11, $12)`,
				record.publishedAppId,
				record.tenantId,
				record.agentDefinitionId,
				record.publicAppId,
				record.name,
				record.status,
				record.accessMode,
				record.currentVersionId,
				record.allowedOrigins ?? [],
				(record.mutablePolicy ?? {}) as object,
				record.createdAt,
				record.updatedAt,
			);
		},
		async get(scope: AppScope, publishedAppId) {
			// The scoped app id must equal the queried id; otherwise the lookup
			// is out of scope and indistinguishable from a missing resource.
			if (scope.publishedAppId !== publishedAppId) return undefined;
			const rows = await client.run(
				"select * from published_apps where id = $1 and tenant_id = $2",
				publishedAppId,
				scope.tenantId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getByPublicAppId(publicAppId) {
			const rows = await client.run("select * from published_apps where public_app_id = $1", publicAppId);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async list(params: PublishedAppListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 100);
			// Parameter order: tenantId($1) [status($2)] [cursor($n, $n+1)],
			// then the limit placeholder at the next index.
			const values: (string | null)[] = [params.scope.tenantId];
			let statusWhere = "";
			if (params.status !== undefined) {
				statusWhere = "and status = $2";
				values.push(params.status);
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
				`select * from published_apps
				 where tenant_id = $1 ${statusWhere} ${cursorWhere}
				 order by created_at desc, id desc
				 limit $${limitIndex}`,
				...values,
				limit + 1,
			);
			return rows.map((row) => toListRow(rowToRecord(row)));
		},
		async updateMutable(scope: AppScope, publishedAppId, fields) {
			await client.run(
				`update published_apps set
				   name = coalesce($3, name),
				   status = coalesce($4, status),
				   access_mode = coalesce($5, access_mode),
				   allowed_origins = coalesce($6::jsonb, allowed_origins),
				   mutable_policy = coalesce($7::jsonb, mutable_policy),
				   updated_at = now()
				 where id = $1 and tenant_id = $2`,
				publishedAppId,
				scope.tenantId,
				fields.name ?? null,
				fields.status ?? null,
				fields.accessMode ?? null,
				fields.allowedOrigins !== undefined ? fields.allowedOrigins : null,
				fields.mutablePolicy !== undefined ? (fields.mutablePolicy as object) : null,
			);
		},
		async setCurrentVersion(scope: AppScope, publishedAppId, versionId) {
			await client.run(
				"update published_apps set current_version_id = $3, updated_at = now() where id = $1 and tenant_id = $2",
				publishedAppId,
				scope.tenantId,
				versionId,
			);
		},
		async transitionVersion(scope, publishedAppId, versionId, input) {
			return client.transaction(async (tx) => {
				// Lock the app row so concurrent activate/rollback serialize:
				// the second transition observes the first one's result and
				// never clobbers it (no lost update).
				const locked = await txRows(
					tx,
					"select current_version_id from published_apps where id = $1 and tenant_id = $2 for update",
					publishedAppId,
					scope.tenantId,
				);
				if (locked.length !== 1) {
					return { ok: false, previousVersionId: null };
				}
				const previousVersionId = (locked[0].current_version_id as PublishedAppVersionId | null) ?? null;
				// Target must belong to this app and be ready (27.3); a
				// rejected/other-app version is indistinguishable from missing.
				const target = await txRows(
					tx,
					"select id from published_app_versions where id = $1 and tenant_id = $2 and published_app_id = $3 and status = 'ready'",
					versionId,
					scope.tenantId,
					scope.publishedAppId,
				);
				if (target.length !== 1) return { ok: false, previousVersionId };
				if (input.activate) {
					await txRows(
						tx,
						`update published_apps
						 set current_version_id = $3, status = 'active', updated_at = now()
						 where id = $1 and tenant_id = $2`,
						publishedAppId,
						scope.tenantId,
						versionId,
					);
				} else {
					// Rollback only flips the pointer; the app stays active and
					// historical RuntimeSpec rows are never copied or modified.
					await txRows(
						tx,
						"update published_apps set current_version_id = $3, updated_at = now() where id = $1 and tenant_id = $2",
						publishedAppId,
						scope.tenantId,
						versionId,
					);
				}
				return { ok: true, previousVersionId };
			});
		},
	};
}

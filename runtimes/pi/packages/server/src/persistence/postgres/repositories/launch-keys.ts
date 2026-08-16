/**
 * PostgreSQL implementation of the embed launch key repository (TASK-027).
 *
 * Only public key material is persisted (`embed_launch_keys.public_key_pem`);
 * the platform never receives a host private key. Every query is scoped by
 * tenant + app, so a key of one app is indistinguishable from a missing key
 * in another app's scope (no ID/keyId enumeration).
 */
import type { LaunchKeyId, PublishedAppId, TenantId } from "../../../publishing/domain/ids.ts";
import type { EmbedLaunchKeyStatus } from "../../../publishing/domain/states.ts";
import type { AppScope, LaunchKeyRecord, LaunchKeyRepository } from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

function rowToRecord(row: Record<string, unknown>): LaunchKeyRecord {
	return {
		launchKeyId: row.id as LaunchKeyId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId,
		keyId: String(row.key_id),
		algorithm: String(row.algorithm),
		publicKeyPem: String(row.public_key_pem),
		status: row.status as LaunchKeyRecord["status"],
		notBefore: row.not_before as Date,
		expiresAt: (row.expires_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
	};
}

export function createLaunchKeyRepository(client: PostgresClient): LaunchKeyRepository {
	return {
		async insertWithRotation(scope: AppScope, record: LaunchKeyRecord) {
			return client.transaction(async (tx) => {
				const existing = await txRows(
					tx,
					"select id from embed_launch_keys where published_app_id = $1 and tenant_id = $2 and key_id = $3",
					scope.publishedAppId,
					scope.tenantId,
					record.keyId,
				);
				if (existing.length > 0) return { outcome: "key_id_conflict" } as const;
				// The UNIQUE(published_app_id, key_id) constraint is the
				// backstop for a concurrent duplicate insert.
				try {
					await txRows(
						tx,
						`insert into embed_launch_keys
						 (id, tenant_id, published_app_id, key_id, algorithm, public_key_pem,
						  status, not_before, expires_at, created_at)
						 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
						record.launchKeyId,
						record.tenantId,
						record.publishedAppId,
						record.keyId,
						record.algorithm,
						record.publicKeyPem,
						record.status,
						record.notBefore,
						record.expiresAt,
						record.createdAt,
					);
				} catch (error) {
					if ((error as { code?: string }).code === "23505") {
						return { outcome: "key_id_conflict" } as const;
					}
					throw error;
				}
				// Rotation window: every other active key of this app moves to
				// `retiring`, so the old and new keys are both accepted until
				// the old one is revoked or expires.
				const retiredRows = await txRows(
					tx,
					`update embed_launch_keys
					 set status = 'retiring'
					 where published_app_id = $1 and tenant_id = $2 and status = 'active' and id <> $3
					 returning *`,
					scope.publishedAppId,
					scope.tenantId,
					record.launchKeyId,
				);
				const created = { ...record } satisfies LaunchKeyRecord;
				return {
					outcome: "created" as const,
					created,
					retired: retiredRows.map((row) => rowToRecord(row)),
				};
			});
		},
		async get(scope: AppScope, launchKeyId: LaunchKeyId) {
			const rows = await client.run(
				"select * from embed_launch_keys where id = $1 and tenant_id = $2 and published_app_id = $3",
				launchKeyId,
				scope.tenantId,
				scope.publishedAppId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getByKeyId(scope: AppScope, keyId: string) {
			const rows = await client.run(
				"select * from embed_launch_keys where key_id = $1 and tenant_id = $2 and published_app_id = $3",
				keyId,
				scope.tenantId,
				scope.publishedAppId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async list(scope: AppScope) {
			const rows = await client.run(
				"select * from embed_launch_keys where tenant_id = $1 and published_app_id = $2 order by created_at desc, id desc",
				scope.tenantId,
				scope.publishedAppId,
			);
			return rows.map((row) => rowToRecord(row));
		},
		async updateStatus(scope: AppScope, launchKeyId: LaunchKeyId, status: EmbedLaunchKeyStatus) {
			await client.run(
				"update embed_launch_keys set status = $3 where id = $1 and tenant_id = $2 and published_app_id = $4",
				launchKeyId,
				scope.tenantId,
				status,
				scope.publishedAppId,
			);
		},
	};
}

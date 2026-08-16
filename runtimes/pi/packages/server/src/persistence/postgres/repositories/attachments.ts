/**
 * Attachment repository (TASK-030, spec 26.2 `attachments`).
 *
 * Every query embeds the full ownership scope (tenant + app + conversation +
 * owner principal) in SQL; there is no bare-id lookup. `listSweepCandidates`
 * is the only unscoped query and is deliberately restricted to the sweep's
 * status/expiry predicate so a background job can age out abandoned staged
 * uploads and expired ready rows (spec 6.3 deletion semantics).
 */
import type {
	AttachmentId,
	ConversationId,
	PrincipalId,
	PublishedAppId,
	TenantId,
} from "../../../publishing/domain/ids.ts";
import type { AttachmentStatus } from "../../../publishing/domain/states.ts";
import type {
	AttachmentRecord,
	AttachmentRepository,
	AttachmentSweepParams,
	ConversationScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

function rowToRecord(row: Record<string, unknown>): AttachmentRecord {
	return {
		attachmentId: row.id as AttachmentId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId,
		conversationId: row.conversation_id as ConversationId,
		ownerPrincipalId: row.owner_principal_id as PrincipalId,
		objectKey: String(row.object_key),
		filename: String(row.filename),
		contentType: String(row.content_type),
		sizeBytes: Number(row.size_bytes),
		checksumSha256: String(row.checksum_sha256),
		status: row.status as AttachmentStatus,
		expiresAt: (row.expires_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
	};
}

export function createAttachmentRepository(client: PostgresClient): AttachmentRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into attachments
				 (id, tenant_id, published_app_id, conversation_id, owner_principal_id,
				  object_key, filename, content_type, size_bytes, checksum_sha256,
				  status, expires_at, created_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
				record.attachmentId,
				record.tenantId,
				record.publishedAppId,
				record.conversationId,
				record.ownerPrincipalId,
				record.objectKey,
				record.filename,
				record.contentType,
				record.sizeBytes,
				record.checksumSha256,
				record.status,
				record.expiresAt,
				record.createdAt,
			);
		},
		async get(scope: ConversationScope, attachmentId) {
			const rows = await client.run(
				`select * from attachments
				 where id = $1 and tenant_id = $2 and published_app_id = $3
				   and conversation_id = $4 and owner_principal_id = $5
				   and deleted_at is null`,
				attachmentId,
				scope.tenantId,
				scope.publishedAppId,
				scope.conversationId,
				scope.principalId,
			);
			return rows.length === 0 ? undefined : rowToRecord(rows[0]!);
		},
		async reserveStaged(scope, record, limits) {
			return client.transaction(async (tx) => {
				// 锁会话行：并发上传同一会话串行化（TASK-031 并发超配额）。
				const locked = await txRows(
					tx,
					`select id from conversations
					 where id = $1 and tenant_id = $2 and published_app_id = $3
					   and owner_principal_id = $4 and deleted_at is null
					 for update`,
					scope.conversationId,
					scope.tenantId,
					scope.publishedAppId,
					scope.principalId,
				);
				if (locked.length === 0) return { outcome: "conversation_missing" } as const;
				const usage = await txRows(
					tx,
					`select
					   coalesce(sum(size_bytes) filter (where conversation_id = $1), 0) as conversation_bytes,
					   coalesce(sum(size_bytes) filter (where owner_principal_id = $2), 0) as principal_bytes,
					   coalesce(sum(size_bytes) filter (where published_app_id = $3), 0) as app_bytes
					 from attachments
					 where tenant_id = $4
					   and status in ('staged', 'ready')
					   and deleted_at is null`,
					scope.conversationId,
					scope.principalId,
					scope.publishedAppId,
					scope.tenantId,
				);
				const row = usage[0] ?? {};
				const conversationBytes = Number(row.conversation_bytes ?? 0) + record.sizeBytes;
				const principalBytes = Number(row.principal_bytes ?? 0) + record.sizeBytes;
				const appBytes = Number(row.app_bytes ?? 0) + record.sizeBytes;
				if (
					conversationBytes > limits.conversationBytes ||
					principalBytes > limits.principalBytes ||
					appBytes > limits.appBytes
				) {
					return { outcome: "quota_exceeded" } as const;
				}
				await txRows(
					tx,
					`insert into attachments
					 (id, tenant_id, published_app_id, conversation_id, owner_principal_id,
					  object_key, filename, content_type, size_bytes, checksum_sha256,
					  status, expires_at, created_at)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
					record.attachmentId,
					record.tenantId,
					record.publishedAppId,
					record.conversationId,
					record.ownerPrincipalId,
					record.objectKey,
					record.filename,
					record.contentType,
					record.sizeBytes,
					record.checksumSha256,
					record.status,
					record.expiresAt,
					record.createdAt,
				);
				return { outcome: "ok" } as const;
			});
		},
		async sumActiveBytes(scope) {
			const rows = await client.run(
				`select coalesce(sum(size_bytes), 0) as total from attachments
				 where tenant_id = $1 and published_app_id = $2 and conversation_id = $3
				   and owner_principal_id = $4 and status in ('staged', 'ready')
				   and deleted_at is null`,
				scope.tenantId,
				scope.publishedAppId,
				scope.conversationId,
				scope.principalId,
			);
			return Number(rows[0]?.total ?? 0);
		},
		async listReadyByConversation(scope) {
			const rows = await client.run(
				`select * from attachments
				 where tenant_id = $1 and published_app_id = $2 and conversation_id = $3
				   and owner_principal_id = $4 and status = 'ready'
				   and deleted_at is null
				 order by created_at`,
				scope.tenantId,
				scope.publishedAppId,
				scope.conversationId,
				scope.principalId,
			);
			return rows.map(rowToRecord);
		},
		async updateStatus(scope: ConversationScope, attachmentId, status) {
			const rows = await client.run(
				`update attachments
				 set status = $6,
				     deleted_at = case when $6 = 'deleted' then now() else deleted_at end
				 where id = $1 and tenant_id = $2 and published_app_id = $3
				   and conversation_id = $4 and owner_principal_id = $5
				   and deleted_at is null
				 returning id`,
				attachmentId,
				scope.tenantId,
				scope.publishedAppId,
				scope.conversationId,
				scope.principalId,
				status,
			);
			return rows.length > 0;
		},
		async listSweepCandidates(params: AttachmentSweepParams) {
			const rows = await client.run(
				`select * from attachments
				 where deleted_at is null
				   and (
					 (status = 'staged' and created_at < $1)
					 or (status = 'ready' and expires_at is not null and expires_at < $2)
				   )
				 order by created_at
				 limit $3`,
				params.stagedBefore,
				params.readyExpiredBefore,
				params.limit,
			);
			return rows.map(rowToRecord);
		},
	};
}

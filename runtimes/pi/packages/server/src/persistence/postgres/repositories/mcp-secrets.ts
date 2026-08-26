import type { McpSecretId, McpServerId, TenantId } from "../../../publishing/domain/ids.ts";
import type { McpEncryptedSecretRecord, McpSecretRepository } from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function secretFromRow(row: Record<string, unknown>): McpEncryptedSecretRecord {
	return {
		secretId: row.id as McpSecretId,
		tenantId: row.tenant_id as TenantId,
		mcpServerId: row.mcp_server_id as McpServerId,
		ciphertext: row.ciphertext as Uint8Array,
		nonce: row.nonce as Uint8Array,
		authTag: row.auth_tag as Uint8Array,
		keyVersion: Number(row.key_version),
	};
}

export function createMcpSecretRepository(client: PostgresClient): McpSecretRepository {
	return {
		async put(record) {
			await client.run(
				`insert into mcp_secrets
				 (id, tenant_id, mcp_server_id, ciphertext, nonce, auth_tag, key_version)
				 values ($1, $2, $3, $4, $5, $6, $7)
				 on conflict (tenant_id, mcp_server_id) do update set
				 ciphertext = excluded.ciphertext, nonce = excluded.nonce, auth_tag = excluded.auth_tag,
				 key_version = excluded.key_version, updated_at = now()`,
				record.secretId,
				record.tenantId,
				record.mcpServerId,
				record.ciphertext,
				record.nonce,
				record.authTag,
				record.keyVersion,
			);
		},
		async get(scope, mcpServerId) {
			const rows = await client.run(
				`select sec.* from mcp_secrets sec join mcp_servers s
				 on s.tenant_id = sec.tenant_id and s.id = sec.mcp_server_id
				 where sec.tenant_id = $1 and sec.mcp_server_id = $2 and s.deleted_at is null`,
				scope.tenantId,
				mcpServerId,
			);
			return rows.length === 1 ? secretFromRow(rows[0]) : undefined;
		},
		async has(scope, mcpServerId) {
			const rows = await client.run(
				"select 1 from mcp_secrets where tenant_id = $1 and mcp_server_id = $2 limit 1",
				scope.tenantId,
				mcpServerId,
			);
			return rows.length === 1;
		},
		async delete(scope, mcpServerId) {
			const rows = await client.run(
				"delete from mcp_secrets where tenant_id = $1 and mcp_server_id = $2 returning id",
				scope.tenantId,
				mcpServerId,
			);
			return rows.length === 1;
		},
	};
}

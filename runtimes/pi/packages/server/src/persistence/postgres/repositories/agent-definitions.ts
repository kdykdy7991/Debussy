import type { AgentDefinitionId, TenantId } from "../../../publishing/domain/ids.ts";
import type { AgentDefinitionRecord, AgentDefinitionRepository } from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function rowToRecord(row: Record<string, unknown>): AgentDefinitionRecord {
	return {
		agentDefinitionId: row.id as AgentDefinitionId,
		tenantId: row.tenant_id as TenantId,
		name: String(row.name),
		revision: Number(row.revision),
		draftConfig: row.draft_config,
		sourceHash: String(row.source_hash ?? ""),
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

/**
 * Agent definition repository. Every read is scoped by tenant; `(id, revision)`
 * is unique so revisions are immutable and never overwritten.
 */
export function createAgentDefinitionRepository(client: PostgresClient): AgentDefinitionRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into agent_definitions (id, tenant_id, name, revision, draft_config, source_hash, created_by, created_at, updated_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				record.agentDefinitionId,
				record.tenantId,
				record.name,
				record.revision,
				record.draftConfig as object,
				record.sourceHash,
				record.tenantId,
				record.createdAt,
				record.updatedAt,
			);
		},
		async getRevision(scope, agentDefinitionId, revision) {
			const rows = await client.run(
				"select * from agent_definitions where id = $1 and tenant_id = $2 and revision = $3",
				agentDefinitionId,
				scope.tenantId,
				revision,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getLatest(scope, agentDefinitionId) {
			const rows = await client.run(
				"select * from agent_definitions where id = $1 and tenant_id = $2 order by revision desc limit 1",
				agentDefinitionId,
				scope.tenantId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getLatestByName(scope, name) {
			const rows = await client.run(
				"select * from agent_definitions where tenant_id = $1 and name = $2 order by revision desc limit 1",
				scope.tenantId,
				name,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
	};
}

import type { AgentDefinitionId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AgentDefinitionListParams,
	AgentDefinitionListRow,
	AgentDefinitionRecord,
	AgentDefinitionRepository,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";

function toListRow(row: Record<string, unknown>): AgentDefinitionListRow {
	return {
		agentDefinitionId: row.id as AgentDefinitionId,
		name: String(row.name),
		revision: Number(row.revision),
		sourceHash: String(row.source_hash ?? ""),
		createdAt: row.created_at as Date,
		cursor: `${(row.created_at as Date).toISOString()}|${String(row.id)}`,
	};
}

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
				"select * from agent_definitions where id = $1 and tenant_id = $2 and revision = $3 and deleted_at is null",
				agentDefinitionId,
				scope.tenantId,
				revision,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getLatest(scope, agentDefinitionId) {
			const rows = await client.run(
				"select * from agent_definitions where id = $1 and tenant_id = $2 and deleted_at is null order by revision desc limit 1",
				agentDefinitionId,
				scope.tenantId,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async getLatestByName(scope, name) {
			const rows = await client.run(
				"select * from agent_definitions where tenant_id = $1 and name = $2 and deleted_at is null order by revision desc limit 1",
				scope.tenantId,
				name,
			);
			return rows.length === 1 ? rowToRecord(rows[0]) : undefined;
		},
		async list(params: AgentDefinitionListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 100);
			// Bind every WHERE placeholder as $1..$N sequentially. The cursor
			// clause, when present, contributes two extra placeholders so the
			// limit placeholder index shifts; we compute it here rather than
			// hard-coding non-contiguous $3/$5 which would crash with the
			// postgres.js parameter binder (MVP-02 regression).
			const values: (string | number)[] = [params.scope.tenantId];
			let cursorWhere = "";
			if (params.cursor !== undefined && params.cursor !== "") {
				const [createdAt, id] = params.cursor.split("|");
				if (createdAt !== undefined && id !== undefined) {
					values.push(createdAt, id);
					cursorWhere = `and (created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
				}
			}
			values.push(limit + 1);
			const limitIndex = values.length;
			const base = params.includeRevisions
				? "select * from agent_definitions where tenant_id = $1 and deleted_at is null"
				: "select * from (select distinct on (id) * from agent_definitions where tenant_id = $1 and deleted_at is null order by id, revision desc) latest";
			const rows = await client.run(
				`${base}
				 ${cursorWhere}
				 order by created_at desc, id desc
				 limit $${limitIndex}`,
				...values,
			);
			return rows.map((row) => toListRow(row));
		},
		async softDelete(scope, agentDefinitionId) {
			await client.run(
				"update agent_definitions set deleted_at = now(), updated_at = now() where id = $1 and tenant_id = $2 and deleted_at is null",
				agentDefinitionId,
				scope.tenantId,
			);
		},
	};
}

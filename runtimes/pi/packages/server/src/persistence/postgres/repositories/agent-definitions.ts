import type { AgentDefinitionId, McpServerId, SkillId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AgentDefinitionListParams,
	AgentDefinitionListRow,
	AgentDefinitionRecord,
	AgentDefinitionRepository,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

type TransactionHandle = Parameters<typeof txRows>[0];

async function insertAgentRow(tx: TransactionHandle, record: AgentDefinitionRecord): Promise<void> {
	await txRows(
		tx,
		`insert into agent_definitions
		 (id, tenant_id, name, revision, draft_config, source_hash, created_by, created_at, updated_at)
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
}

async function lockAvailableSkills(
	tx: TransactionHandle,
	tenantId: TenantId,
	bindings: readonly { readonly skillId: SkillId; readonly skillRevision: number }[],
): Promise<boolean> {
	for (const binding of bindings) {
		const rows = await txRows(
			tx,
			`select 1 from skill_revisions sr
			 join skills s on s.id = sr.skill_id and s.tenant_id = sr.tenant_id
			 where sr.tenant_id = $1 and sr.skill_id = $2 and sr.revision = $3
			   and s.deleted_at is null and s.status = 'enabled'
			   and not (sr.diagnostics @> '[{"severity":"error"}]'::jsonb)
			 for share of s, sr`,
			tenantId,
			binding.skillId,
			binding.skillRevision,
		);
		if (rows.length !== 1) return false;
	}
	return true;
}

async function insertSkillBindings(
	tx: TransactionHandle,
	record: AgentDefinitionRecord,
	bindings: readonly { readonly skillId: SkillId; readonly skillRevision: number }[],
): Promise<void> {
	for (const [position, binding] of bindings.entries()) {
		await txRows(
			tx,
			`insert into agent_revision_skills
			 (tenant_id, agent_definition_id, agent_revision, position, skill_id, skill_revision)
			 values ($1, $2, $3, $4, $5, $6)`,
			record.tenantId,
			record.agentDefinitionId,
			record.revision,
			position,
			binding.skillId,
			binding.skillRevision,
		);
	}
}

type McpBindingInput = {
	readonly mcpServerId: McpServerId;
	readonly mcpRevision: number;
	readonly toolAllowlist: readonly string[];
};

async function lockAvailableMcpServers(
	tx: TransactionHandle,
	tenantId: TenantId,
	bindings: readonly McpBindingInput[],
): Promise<boolean> {
	for (const binding of bindings) {
		const serverRows = await txRows(
			tx,
			`select 1 from mcp_server_revisions r
			 join mcp_servers s on s.id = r.mcp_server_id and s.tenant_id = r.tenant_id
			 where r.tenant_id = $1 and r.mcp_server_id = $2 and r.revision = $3
			  and s.deleted_at is null and s.status = 'enabled'
			 for share of s, r`,
			tenantId,
			binding.mcpServerId,
			binding.mcpRevision,
		);
		if (serverRows.length !== 1) return false;
		const toolRows = await txRows(
			tx,
			`select count(*)::int as tool_count from mcp_tools
			 where tenant_id = $1 and mcp_server_id = $2 and mcp_revision = $3 and name = any($4::text[])`,
			tenantId,
			binding.mcpServerId,
			binding.mcpRevision,
			binding.toolAllowlist,
		);
		if (toolRows.length !== 1 || Number(toolRows[0].tool_count) !== binding.toolAllowlist.length) return false;
	}
	return true;
}

async function insertMcpBindings(
	tx: TransactionHandle,
	record: AgentDefinitionRecord,
	bindings: readonly McpBindingInput[],
): Promise<void> {
	for (const [position, binding] of bindings.entries()) {
		await txRows(
			tx,
			`insert into agent_revision_mcp_bindings
			 (tenant_id, agent_definition_id, agent_revision, position, mcp_server_id, mcp_revision, tool_allowlist)
			 values ($1, $2, $3, $4, $5, $6, $7)`,
			record.tenantId,
			record.agentDefinitionId,
			record.revision,
			position,
			binding.mcpServerId,
			binding.mcpRevision,
			binding.toolAllowlist,
		);
	}
}

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
		async createInitial(record) {
			return client.transaction(async (tx) => {
				// A transaction-scoped name lock makes the read-then-insert unique
				// even though immutable revisions prevent a simple UNIQUE(name).
				await txRows(
					tx,
					"select pg_advisory_xact_lock(hashtextextended($1, 0))",
					`${record.tenantId}:${record.name}`,
				);
				const existing = await txRows(
					tx,
					"select 1 from agent_definitions where tenant_id = $1 and name = $2 and deleted_at is null limit 1",
					record.tenantId,
					record.name,
				);
				if (existing.length > 0) return false;
				await txRows(
					tx,
					`insert into agent_definitions
					 (id, tenant_id, name, revision, draft_config, source_hash, created_by, created_at, updated_at)
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
				return true;
			});
		},
		async createInitialWithSkillBindings(record, bindings, mcpBindings = []) {
			return client.transaction(async (tx) => {
				await txRows(
					tx,
					"select pg_advisory_xact_lock(hashtextextended($1, 0))",
					`${record.tenantId}:${record.name}`,
				);
				const existing = await txRows(
					tx,
					"select 1 from agent_definitions where tenant_id = $1 and name = $2 and deleted_at is null limit 1",
					record.tenantId,
					record.name,
				);
				if (existing.length > 0) return "name_conflict";
				if (!(await lockAvailableSkills(tx, record.tenantId, bindings))) return "skill_unavailable";
				if (!(await lockAvailableMcpServers(tx, record.tenantId, mcpBindings))) return "mcp_unavailable";
				await insertAgentRow(tx, record);
				await insertSkillBindings(tx, record, bindings);
				await insertMcpBindings(tx, record, mcpBindings);
				return "created";
			});
		},
		async insertWithSkillBindings(record, bindings, mcpBindings = []) {
			return client.transaction(async (tx) => {
				if (!(await lockAvailableSkills(tx, record.tenantId, bindings))) return "skill_unavailable";
				if (!(await lockAvailableMcpServers(tx, record.tenantId, mcpBindings))) return "mcp_unavailable";
				await insertAgentRow(tx, record);
				await insertSkillBindings(tx, record, bindings);
				await insertMcpBindings(tx, record, mcpBindings);
				return "inserted";
			});
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
		async softDeleteIfUnreferenced(scope, agentDefinitionId) {
			return client.transaction(async (tx) => {
				const locked = await txRows(
					tx,
					`select revision from agent_definitions
					 where id = $1 and tenant_id = $2 and deleted_at is null
					 order by revision for update`,
					agentDefinitionId,
					scope.tenantId,
				);
				if (locked.length === 0) return "not_found";
				const apps = await txRows(
					tx,
					`select 1 from published_apps
					 where tenant_id = $1 and agent_definition_id = $2 and deleted_at is null
					 limit 1`,
					scope.tenantId,
					agentDefinitionId,
				);
				if (apps.length > 0) return "has_associated_apps";
				await txRows(
					tx,
					`update agent_definitions set deleted_at = now(), updated_at = now()
					 where id = $1 and tenant_id = $2 and deleted_at is null`,
					agentDefinitionId,
					scope.tenantId,
				);
				return "deleted";
			});
		},
	};
}

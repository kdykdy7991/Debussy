import type { AgentDefinitionId, McpServerId, McpToolId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AgentRevisionMcpBindingRecord,
	McpServerRecord,
	McpServerRepository,
	McpServerRevisionRecord,
	McpToolRecord,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

function serverFromRow(row: Record<string, unknown>): McpServerRecord {
	return {
		mcpServerId: row.id as McpServerId,
		tenantId: row.tenant_id as TenantId,
		name: String(row.name),
		status: row.status as McpServerRecord["status"],
		currentRevision: Number(row.current_revision),
		lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === true,
		lastTestLatencyMs: row.last_test_latency_ms === null ? null : Number(row.last_test_latency_ms),
		lastTestAt: row.last_test_at as Date | null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function revisionFromRow(row: Record<string, unknown>): McpServerRevisionRecord {
	return {
		mcpServerId: row.mcp_server_id as McpServerId,
		tenantId: row.tenant_id as TenantId,
		revision: Number(row.revision),
		transport: "streamable_http",
		endpoint: String(row.endpoint),
		authentication: row.authentication as McpServerRevisionRecord["authentication"],
		createdAt: row.created_at as Date,
	};
}

function toolFromRow(row: Record<string, unknown>): McpToolRecord {
	return {
		mcpToolId: row.id as McpToolId,
		tenantId: row.tenant_id as TenantId,
		mcpServerId: row.mcp_server_id as McpServerId,
		mcpRevision: Number(row.mcp_revision),
		name: String(row.name),
		description: row.description === null ? null : String(row.description),
		inputSchema: row.input_schema as Readonly<Record<string, unknown>>,
		inputSchemaHash: String(row.input_schema_hash),
		createdAt: row.created_at as Date,
	};
}

async function insertRevision(
	tx: Parameters<typeof txRows>[0],
	revision: McpServerRevisionRecord,
	tools: readonly McpToolRecord[],
): Promise<void> {
	await txRows(
		tx,
		`insert into mcp_server_revisions
		 (mcp_server_id, revision, tenant_id, transport, endpoint, authentication, created_by, created_at)
		 values ($1, $2, $3, $4, $5, $6, $3, $7)`,
		revision.mcpServerId,
		revision.revision,
		revision.tenantId,
		revision.transport,
		revision.endpoint,
		revision.authentication,
		revision.createdAt,
	);
	for (const tool of tools) {
		await txRows(
			tx,
			`insert into mcp_tools
			 (id, tenant_id, mcp_server_id, mcp_revision, name, description, input_schema, input_schema_hash, created_at)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			tool.mcpToolId,
			tool.tenantId,
			tool.mcpServerId,
			tool.mcpRevision,
			tool.name,
			tool.description,
			tool.inputSchema as object,
			tool.inputSchemaHash,
			tool.createdAt,
		);
	}
}

function bindingFromRow(row: Record<string, unknown>): AgentRevisionMcpBindingRecord {
	return {
		tenantId: row.tenant_id as TenantId,
		agentDefinitionId: row.agent_definition_id as AgentDefinitionId,
		agentRevision: Number(row.agent_revision),
		position: Number(row.position),
		mcpServerId: row.mcp_server_id as McpServerId,
		mcpRevision: Number(row.mcp_revision),
		toolAllowlist: row.tool_allowlist as readonly string[],
	};
}

export function createMcpServerRepository(client: PostgresClient): McpServerRepository {
	return {
		async create(input) {
			return client.transaction(async (tx) => {
				await txRows(
					tx,
					"select pg_advisory_xact_lock(hashtextextended($1, 0))",
					`${input.server.tenantId}:${input.server.name}`,
				);
				const existing = await txRows(
					tx,
					"select 1 from mcp_servers where tenant_id = $1 and name = $2 and deleted_at is null limit 1",
					input.server.tenantId,
					input.server.name,
				);
				if (existing.length > 0) return "name_conflict";
				await txRows(
					tx,
					`insert into mcp_servers
					 (id, tenant_id, name, status, current_revision, created_by, created_at, updated_at)
					 values ($1, $2, $3, $4, $5, $2, $6, $7)`,
					input.server.mcpServerId,
					input.server.tenantId,
					input.server.name,
					input.server.status,
					input.server.currentRevision,
					input.server.createdAt,
					input.server.updatedAt,
				);
				await insertRevision(tx, input.revision, input.tools ?? []);
				return "created";
			});
		},
		async addRevision(input) {
			return client.transaction(async (tx) => {
				const rows = await txRows(
					tx,
					"select current_revision from mcp_servers where tenant_id = $1 and id = $2 and deleted_at is null for update",
					input.scope.tenantId,
					input.mcpServerId,
				);
				if (rows.length !== 1) return undefined;
				const revision: McpServerRevisionRecord = {
					...input.revision,
					revision: Number(rows[0].current_revision) + 1,
				};
				const tools = input.tools.map((tool) => ({ ...tool, mcpRevision: revision.revision }));
				await insertRevision(tx, revision, tools);
				await txRows(
					tx,
					"update mcp_servers set current_revision = $3, updated_at = $4 where tenant_id = $1 and id = $2",
					input.scope.tenantId,
					input.mcpServerId,
					revision.revision,
					revision.createdAt,
				);
				return revision;
			});
		},
		async list(scope, limit, cursor) {
			const bounded = Math.min(Math.max(limit, 1), 100);
			const values: (string | number)[] = [scope.tenantId];
			let cursorSql = "";
			if (cursor !== undefined) {
				const [updatedAt, id] = cursor.split("|");
				if (updatedAt !== undefined && id !== undefined) {
					values.push(updatedAt, id);
					cursorSql = "and (updated_at, id) < ($2::timestamptz, $3::uuid)";
				}
			}
			values.push(bounded + 1);
			const rows = await client.run(
				`select * from mcp_servers where tenant_id = $1 and deleted_at is null ${cursorSql}
				 order by updated_at desc, id desc limit $${values.length}`,
				...values,
			);
			return rows.map(serverFromRow);
		},
		async get(scope, mcpServerId) {
			const rows = await client.run(
				"select * from mcp_servers where tenant_id = $1 and id = $2 and deleted_at is null",
				scope.tenantId,
				mcpServerId,
			);
			return rows.length === 1 ? serverFromRow(rows[0]) : undefined;
		},
		async getRevision(scope, mcpServerId, revision) {
			const rows = await client.run(
				`select r.* from mcp_server_revisions r join mcp_servers s
				 on s.tenant_id = r.tenant_id and s.id = r.mcp_server_id
				 where r.tenant_id = $1 and r.mcp_server_id = $2 and r.revision = $3 and s.deleted_at is null`,
				scope.tenantId,
				mcpServerId,
				revision,
			);
			return rows.length === 1 ? revisionFromRow(rows[0]) : undefined;
		},
		async listRevisions(scope, mcpServerId) {
			const rows = await client.run(
				`select r.* from mcp_server_revisions r join mcp_servers s
				 on s.tenant_id = r.tenant_id and s.id = r.mcp_server_id
				 where r.tenant_id = $1 and r.mcp_server_id = $2 and s.deleted_at is null order by r.revision desc`,
				scope.tenantId,
				mcpServerId,
			);
			return rows.map(revisionFromRow);
		},
		async listTools(scope, mcpServerId, revision) {
			const rows = await client.run(
				`select t.* from mcp_tools t join mcp_servers s
				 on s.tenant_id = t.tenant_id and s.id = t.mcp_server_id
				 where t.tenant_id = $1 and t.mcp_server_id = $2 and t.mcp_revision = $3
				 and s.deleted_at is null order by t.name`,
				scope.tenantId,
				mcpServerId,
				revision,
			);
			return rows.map(toolFromRow);
		},
		async setLastTest(scope, mcpServerId, result) {
			const rows = await client.run(
				`update mcp_servers set last_test_ok = $3, last_test_latency_ms = $4, last_test_at = now(), updated_at = now()
				 where tenant_id = $1 and id = $2 and deleted_at is null returning id`,
				scope.tenantId,
				mcpServerId,
				result.ok,
				result.latencyMs,
			);
			return rows.length === 1;
		},
		async setStatus(scope, mcpServerId, status) {
			const rows = await client.run(
				"update mcp_servers set status = $3, updated_at = now() where tenant_id = $1 and id = $2 and deleted_at is null returning id",
				scope.tenantId,
				mcpServerId,
				status,
			);
			return rows.length === 1;
		},
		async softDelete(scope, mcpServerId) {
			const rows = await client.run(
				`update mcp_servers set status = 'disabled', deleted_at = now(), updated_at = now()
				 where tenant_id = $1 and id = $2 and deleted_at is null returning id`,
				scope.tenantId,
				mcpServerId,
			);
			return rows.length === 1;
		},
		async listBindings(scope, agentDefinitionId, agentRevision) {
			const rows = await client.run(
				`select * from agent_revision_mcp_bindings where tenant_id = $1
				 and agent_definition_id = $2 and agent_revision = $3 order by position`,
				scope.tenantId,
				agentDefinitionId,
				agentRevision,
			);
			return rows.map(bindingFromRow);
		},
		async listBindingsForServer(scope, mcpServerId) {
			const rows = await client.run(
				`select * from agent_revision_mcp_bindings where tenant_id = $1
				 and mcp_server_id = $2 order by agent_definition_id, agent_revision, position`,
				scope.tenantId,
				mcpServerId,
			);
			return rows.map(bindingFromRow);
		},
		async recordCallAudit(record) {
			await client.run(
				`insert into mcp_call_audits
				 (id, tenant_id, conversation_id, published_app_version_id, mcp_server_id, mcp_revision,
				  tool_name, outcome, latency_ms, result_bytes, result_truncated, error_code, request_id, created_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
				record.mcpCallAuditId,
				record.tenantId,
				record.conversationId,
				record.publishedAppVersionId,
				record.mcpServerId,
				record.mcpRevision,
				record.toolName,
				record.outcome,
				record.latencyMs,
				record.resultBytes,
				record.resultTruncated,
				record.errorCode,
				record.requestId,
				record.createdAt,
			);
		},
	};
}

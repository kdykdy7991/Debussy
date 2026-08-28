import type { AgentDefinitionId, SkillArtifactId, SkillId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	AgentRevisionSkillBindingRecord,
	SkillArtifactRecord,
	SkillDiagnosticRecord,
	SkillRecord,
	SkillRepository,
	SkillRevisionRecord,
} from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { txRows } from "./tx.ts";

function skillFromRow(row: Record<string, unknown>): SkillRecord {
	return {
		skillId: row.id as SkillId,
		tenantId: row.tenant_id as TenantId,
		name: String(row.name),
		status: row.status as SkillRecord["status"],
		currentRevision: Number(row.current_revision),
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function revisionFromRow(row: Record<string, unknown>): SkillRevisionRecord {
	return {
		skillId: row.skill_id as SkillId,
		tenantId: row.tenant_id as TenantId,
		revision: Number(row.revision),
		artifactId: row.artifact_id as SkillArtifactId,
		sourceHash: String(row.source_hash),
		parsedName: String(row.parsed_name),
		description: String(row.description),
		instructionText: String(row.instruction_text),
		disableModelInvocation: row.disable_model_invocation === true,
		diagnostics: (row.diagnostics as readonly SkillDiagnosticRecord[]) ?? [],
		createdAt: row.created_at as Date,
	};
}

function artifactFromRow(row: Record<string, unknown>): SkillArtifactRecord {
	return {
		artifactId: row.id as SkillArtifactId,
		tenantId: row.tenant_id as TenantId,
		filename: String(row.filename),
		mediaType: String(row.media_type),
		sourceHash: String(row.source_hash),
		sizeBytes: Number(row.size_bytes),
		content: row.content as Uint8Array,
		createdAt: row.created_at as Date,
	};
}

async function insertArtifact(tx: Parameters<typeof txRows>[0], artifact: SkillArtifactRecord): Promise<void> {
	await txRows(
		tx,
		`insert into skill_artifacts
		 (id, tenant_id, filename, media_type, source_hash, size_bytes, content, created_at)
		 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		artifact.artifactId,
		artifact.tenantId,
		artifact.filename,
		artifact.mediaType,
		artifact.sourceHash,
		artifact.sizeBytes,
		artifact.content,
		artifact.createdAt,
	);
}

async function insertRevision(tx: Parameters<typeof txRows>[0], revision: SkillRevisionRecord): Promise<void> {
	await txRows(
		tx,
		`insert into skill_revisions
		 (skill_id, revision, tenant_id, artifact_id, source_hash, parsed_name, description,
		  instruction_text, disable_model_invocation, diagnostics, created_by, created_at)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $3, $11)`,
		revision.skillId,
		revision.revision,
		revision.tenantId,
		revision.artifactId,
		revision.sourceHash,
		revision.parsedName,
		revision.description,
		revision.instructionText,
		revision.disableModelInvocation,
		revision.diagnostics as object,
		revision.createdAt,
	);
}

export function createSkillRepository(client: PostgresClient): SkillRepository {
	return {
		async create(input) {
			return client.transaction(async (tx) => {
				await txRows(
					tx,
					"select pg_advisory_xact_lock(hashtextextended($1, 0))",
					`${input.skill.tenantId}:${input.skill.name}`,
				);
				const existing = await txRows(
					tx,
					"select 1 from skills where tenant_id = $1 and name = $2 and deleted_at is null limit 1",
					input.skill.tenantId,
					input.skill.name,
				);
				if (existing.length > 0) return "name_conflict";
				await txRows(
					tx,
					`insert into skills
					 (id, tenant_id, name, status, current_revision, created_by, created_at, updated_at)
					 values ($1, $2, $3, $4, $5, $2, $6, $7)`,
					input.skill.skillId,
					input.skill.tenantId,
					input.skill.name,
					input.skill.status,
					input.skill.currentRevision,
					input.skill.createdAt,
					input.skill.updatedAt,
				);
				await insertArtifact(tx, input.artifact);
				await insertRevision(tx, input.revision);
				return "created";
			});
		},
		async addRevision(input) {
			return client.transaction(async (tx) => {
				const rows = await txRows(
					tx,
					`select current_revision from skills
					 where id = $1 and tenant_id = $2 and deleted_at is null for update`,
					input.skillId,
					input.scope.tenantId,
				);
				if (rows.length !== 1) return undefined;
				const revision: SkillRevisionRecord = {
					...input.revision,
					revision: Number(rows[0].current_revision) + 1,
				};
				await insertArtifact(tx, input.artifact);
				await insertRevision(tx, revision);
				await txRows(
					tx,
					"update skills set current_revision = $3, name = $4, updated_at = $5 where id = $1 and tenant_id = $2",
					input.skillId,
					input.scope.tenantId,
					revision.revision,
					revision.parsedName,
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
				`select * from skills where tenant_id = $1 and deleted_at is null ${cursorSql}
				 order by updated_at desc, id desc limit $${values.length}`,
				...values,
			);
			return rows.map(skillFromRow);
		},
		async get(scope, skillId) {
			const rows = await client.run(
				"select * from skills where id = $1 and tenant_id = $2 and deleted_at is null",
				skillId,
				scope.tenantId,
			);
			return rows.length === 1 ? skillFromRow(rows[0]) : undefined;
		},
		async getRevision(scope, skillId, revision) {
			const rows = await client.run(
				`select sr.* from skill_revisions sr
				 join skills s on s.id = sr.skill_id and s.tenant_id = sr.tenant_id
				 where sr.skill_id = $1 and sr.tenant_id = $2 and sr.revision = $3 and s.deleted_at is null`,
				skillId,
				scope.tenantId,
				revision,
			);
			return rows.length === 1 ? revisionFromRow(rows[0]) : undefined;
		},
		async getArtifact(scope, artifactId) {
			const rows = await client.run(
				"select * from skill_artifacts where id = $1 and tenant_id = $2",
				artifactId,
				scope.tenantId,
			);
			return rows.length === 1 ? artifactFromRow(rows[0]) : undefined;
		},
		async listRevisions(scope, skillId) {
			const rows = await client.run(
				`select sr.* from skill_revisions sr
				 join skills s on s.id = sr.skill_id and s.tenant_id = sr.tenant_id
				 where sr.skill_id = $1 and sr.tenant_id = $2 and s.deleted_at is null
				 order by sr.revision desc`,
				skillId,
				scope.tenantId,
			);
			return rows.map(revisionFromRow);
		},
		async setStatus(scope, skillId, status) {
			const rows = await client.run(
				`update skills set status = $3, updated_at = now()
				 where id = $1 and tenant_id = $2 and deleted_at is null returning id`,
				skillId,
				scope.tenantId,
				status,
			);
			return rows.length === 1;
		},
		async softDelete(scope, skillId) {
			const rows = await client.run(
				`update skills set status = 'disabled', deleted_at = now(), updated_at = now()
				 where id = $1 and tenant_id = $2 and deleted_at is null returning id`,
				skillId,
				scope.tenantId,
			);
			return rows.length === 1;
		},
		async softDeleteIfUnreferenced(scope, skillId) {
			return client.transaction(async (tx) => {
				const locked = await txRows(
					tx,
					"select id from skills where id = $1 and tenant_id = $2 and deleted_at is null for update",
					skillId,
					scope.tenantId,
				);
				if (locked.length !== 1) return "not_found";
				const references = await txRows(
					tx,
					`select 1
					 from agent_revision_skills ars
					 join published_apps pa
					   on pa.tenant_id = ars.tenant_id and pa.agent_definition_id = ars.agent_definition_id
					 join published_app_versions pav
					   on pav.tenant_id = pa.tenant_id and pav.published_app_id = pa.id
					  and pav.source_agent_revision = ars.agent_revision
					 where ars.tenant_id = $1 and ars.skill_id = $2
					 limit 1`,
					scope.tenantId,
					skillId,
				);
				if (references.length > 0) return "published_reference";
				await txRows(
					tx,
					"update skills set status = 'disabled', deleted_at = now(), updated_at = now() where id = $1 and tenant_id = $2",
					skillId,
					scope.tenantId,
				);
				return "deleted";
			});
		},
		async bindAgentRevision(input) {
			return client.transaction(async (tx) => {
				const agent = await txRows(
					tx,
					`select 1 from agent_definitions
					 where tenant_id = $1 and id = $2 and revision = $3 and deleted_at is null`,
					input.scope.tenantId,
					input.agentDefinitionId,
					input.agentRevision,
				);
				if (agent.length !== 1) return "agent_not_found";
				for (const binding of input.bindings) {
					const skill = await txRows(
						tx,
						`select 1 from skill_revisions sr
						 join skills s on s.id = sr.skill_id and s.tenant_id = sr.tenant_id
						 where sr.tenant_id = $1 and sr.skill_id = $2 and sr.revision = $3
						   and s.deleted_at is null and s.status = 'enabled'
						   and not (sr.diagnostics @> '[{"severity":"error"}]'::jsonb)`,
						input.scope.tenantId,
						binding.skillId,
						binding.skillRevision,
					);
					if (skill.length !== 1) return "skill_unavailable";
				}
				await txRows(
					tx,
					`delete from agent_revision_skills
					 where tenant_id = $1 and agent_definition_id = $2 and agent_revision = $3`,
					input.scope.tenantId,
					input.agentDefinitionId,
					input.agentRevision,
				);
				for (const [position, binding] of input.bindings.entries()) {
					await txRows(
						tx,
						`insert into agent_revision_skills
						 (tenant_id, agent_definition_id, agent_revision, position, skill_id, skill_revision)
						 values ($1, $2, $3, $4, $5, $6)`,
						input.scope.tenantId,
						input.agentDefinitionId,
						input.agentRevision,
						position,
						binding.skillId,
						binding.skillRevision,
					);
				}
				return "bound";
			});
		},
		async listBindings(scope, agentDefinitionId, agentRevision) {
			const rows = await client.run(
				`select * from agent_revision_skills
				 where tenant_id = $1 and agent_definition_id = $2 and agent_revision = $3
				 order by position`,
				scope.tenantId,
				agentDefinitionId,
				agentRevision,
			);
			return rows.map(
				(row): AgentRevisionSkillBindingRecord => ({
					tenantId: row.tenant_id as TenantId,
					agentDefinitionId: row.agent_definition_id as AgentDefinitionId,
					agentRevision: Number(row.agent_revision),
					position: Number(row.position),
					skillId: row.skill_id as SkillId,
					skillRevision: Number(row.skill_revision),
				}),
			);
		},
		async listBindingsForSkill(scope, skillId) {
			const rows = await client.run(
				`select * from agent_revision_skills
				 where tenant_id = $1 and skill_id = $2
				 order by agent_definition_id, agent_revision, position`,
				scope.tenantId,
				skillId,
			);
			return rows.map(
				(row): AgentRevisionSkillBindingRecord => ({
					tenantId: row.tenant_id as TenantId,
					agentDefinitionId: row.agent_definition_id as AgentDefinitionId,
					agentRevision: Number(row.agent_revision),
					position: Number(row.position),
					skillId: row.skill_id as SkillId,
					skillRevision: Number(row.skill_revision),
				}),
			);
		},
	};
}

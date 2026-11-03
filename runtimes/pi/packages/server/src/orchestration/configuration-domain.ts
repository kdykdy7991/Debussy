import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { validateModelParameters } from "../model-parameters.ts";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import type { ControlService } from "../publishing/control/service.ts";
import { fromPublicId, type TenantId } from "../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { type CompilerInput, compileRuntimeSpec } from "../publishing/runtime-spec/compiler.ts";
import { configurationSchema, OrchestrationError } from "./contracts.ts";

export const taskConfigurationSchema = configurationSchema
	.omit({ expectedRevision: true, expectedDraftRevision: true, expectedActiveVersion: true })
	.extend({
		mcpServers: configurationSchema.shape.mcpServers.default([]),
		skills: configurationSchema.shape.skills.default([]),
		contextPolicy: z
			.object({
				maxTurns: z.number().int().positive().optional(),
				maxContextTokens: z.number().int().positive().optional(),
				toolResultMaxBytes: z.number().int().positive().optional(),
			})
			.strict()
			.optional(),
		runtimePolicy: z
			.object({
				profile: z.literal("chat-only").optional(),
				turnTimeoutMs: z.number().int().positive().optional(),
				idleTtlMs: z.number().int().positive().optional(),
				maxConcurrentTurnsPerConversation: z.literal(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((configuration, context) => {
		if (
			new Set(configuration.mcpServers.map((ref) => ref.mcpServerId)).size !== configuration.mcpServers.length ||
			new Set(configuration.skills.map((ref) => ref.skillId)).size !== configuration.skills.length
		)
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Resource references must be unique" });
	});
export type TaskConfiguration = z.infer<typeof taskConfigurationSchema>;
export interface OrchestrationVersion {
	readonly id: string;
	readonly configurationId: string;
	readonly sourceDraftRevision: number;
	readonly snapshot: TaskConfiguration;
	readonly runtimeSpec: unknown;
	readonly runtimeSpecHash: string;
}
export interface PreparedOrchestrationVersion extends OrchestrationVersion {
	readonly tenantId: string;
}

/** Task facts live here, never in AgentDefinition or a Chat publication repository. */
export class OrchestrationConfigurationRepository {
	private readonly client: PostgresClient;
	constructor(client: PostgresClient) {
		this.client = client;
	}
	async getDefinition(tenantId: string, id: string) {
		const [row] = await this.client.run(
			"select draft,draft_revision from orchestration_configurations where tenant_id=$1 and id=$2",
			tenantId,
			id,
		);
		return row
			? { draft: taskConfigurationSchema.parse(row.draft), revision: Number(row.draft_revision) }
			: undefined;
	}
	async getVersion(tenantId: string, id: string, configurationId: string): Promise<OrchestrationVersion | undefined> {
		const [row] = await this.client.run(
			"select * from orchestration_versions where tenant_id=$1 and id=$2 and configuration_id=$3",
			tenantId,
			id,
			configurationId,
		);
		return row
			? {
					id: String(row.id),
					configurationId: String(row.configuration_id),
					sourceDraftRevision: Number(row.source_draft_revision),
					snapshot: taskConfigurationSchema.parse(row.snapshot),
					runtimeSpec: row.runtime_spec,
					runtimeSpecHash: String(row.runtime_spec_hash),
				}
			: undefined;
	}
	async insertVersion(tx: TransactionSql, version: PreparedOrchestrationVersion) {
		await txRows(
			tx,
			"insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash) values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)",
			version.id,
			version.tenantId,
			version.configurationId,
			version.snapshot,
			version.sourceDraftRevision,
			version.runtimeSpec as object,
			version.runtimeSpecHash,
		);
	}
	async create(tx: TransactionSql, name: string, version: PreparedOrchestrationVersion) {
		await txRows(
			tx,
			"insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,$3,$4::jsonb,$5)",
			version.configurationId,
			version.tenantId,
			name,
			version.snapshot,
			version.sourceDraftRevision,
		);
		await this.insertVersion(tx, version);
	}
}

/** Compile from explicit task resource revisions, not Agent revision bindings. */
export async function prepareOrchestrationVersion(options: {
	tenantId: TenantId;
	configurationId?: string;
	draftRevision: number;
	configuration: TaskConfiguration;
	control: ControlService;
	repositories: PublishingRepositories;
}): Promise<PreparedOrchestrationVersion> {
	const { configuration, repositories: repos, tenantId } = options;
	const models = await options.control.listLlmModels();
	if (!models.ok) throw new OrchestrationError(503, "MODEL_CATALOG_UNAVAILABLE", "模型目录不可用");
	const matching = models.data.items.filter((m) => m.id === configuration.modelId);
	if (matching.length !== 1) throw new OrchestrationError(422, "INVALID_MODEL", "模型不存在或标识不唯一");
	const model = matching[0]!;
	if (validateModelParameters(configuration.parameters, model.parameterCapabilities).length)
		throw new OrchestrationError(422, "INVALID_PARAMETERS", "模型不支持所选参数");
	const skills: NonNullable<CompilerInput["skills"]>[number][] = [];
	for (const ref of configuration.skills) {
		const id = fromPublicId("SkillId", ref.skillId);
		if (!id) throw new OrchestrationError(422, "INVALID_SKILL", "Skill 标识无效");
		const skill = await repos.skills.get({ tenantId }, id);
		const revision = await repos.skills.getRevision({ tenantId }, id, ref.revision);
		if (!skill || skill.status !== "enabled" || !revision)
			throw new OrchestrationError(422, "INVALID_SKILL", "Skill 版本不可用");
		skills.push({
			skillId: ref.skillId,
			revision: revision.revision,
			sourceHash: revision.sourceHash,
			name: revision.parsedName,
			description: revision.description,
			instructionText: revision.instructionText,
			disableModelInvocation: revision.disableModelInvocation,
		});
	}
	const mcpServers: NonNullable<CompilerInput["mcpServers"]>[number][] = [];
	if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
		throw new OrchestrationError(422, "INVALID_SKILL", "Skill 目录名称重复");
	for (const ref of configuration.mcpServers) {
		const id = fromPublicId("McpServerId", ref.mcpServerId);
		if (!id) throw new OrchestrationError(422, "INVALID_MCP", "MCP 标识无效");
		const server = await repos.mcpServers.get({ tenantId }, id);
		const revision = await repos.mcpServers.getRevision({ tenantId }, id, ref.revision);
		if (!server || server.status !== "enabled" || !revision)
			throw new OrchestrationError(422, "INVALID_MCP", "MCP 版本不可用");
		const tools = (await repos.mcpServers.listTools({ tenantId }, id, ref.revision)).filter((t) =>
			ref.toolNames.includes(t.name),
		);
		if (tools.length !== ref.toolNames.length || new Set(ref.toolNames).size !== ref.toolNames.length)
			throw new OrchestrationError(422, "INVALID_MCP", "工具白名单与冻结版本不符");
		mcpServers.push({
			mcpServerId: ref.mcpServerId,
			revision: revision.revision,
			transport: revision.transport,
			endpoint: revision.endpoint,
			authentication: revision.authentication,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
				inputSchemaHash: t.inputSchemaHash,
			})),
		});
	}
	const id = randomUUID();
	const compiled = compileRuntimeSpec({
		publishedAppVersionId: `orv_${id}`,
		agent: {
			prompt: configuration.systemPrompt,
			model: { provider: model.provider, modelId: model.id, params: configuration.parameters },
			...(configuration.contextPolicy ? { contextPolicy: configuration.contextPolicy } : {}),
			...(configuration.runtimePolicy ? { runtimePolicy: configuration.runtimePolicy } : {}),
			uploads: { enabled: false },
		},
		catalog: {
			models: [{ provider: model.provider, modelId: model.id, parameterCapabilities: model.parameterCapabilities }],
			tools: [],
			knowledgeBases: [],
		},
		skills,
		mcpServers,
	});
	if (!compiled.ok) throw new OrchestrationError(422, "CONFIGURATION_REJECTED", "执行配置编译失败");
	return {
		id,
		tenantId,
		configurationId: options.configurationId ?? randomUUID(),
		sourceDraftRevision: options.draftRevision,
		snapshot: configuration,
		runtimeSpec: compiled.spec,
		runtimeSpecHash: compiled.sha256,
	};
}

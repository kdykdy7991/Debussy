import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
	ConfigurationGrant,
	ConfigurationPermission,
	ExternalAgentConfiguration,
	ExternalConfigurationField,
	ExternalConfigurationView,
} from "@earendil-works/pi-protocol";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { parseStrictOrigin } from "../embed/auth/origin.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import { canonicalJson } from "../publishing/runtime-spec/hash.ts";
import { configurationSchema, OrchestrationError } from "./contracts.ts";
import { credentialHash } from "./credentials.ts";
import type { OrchestrationService } from "./service.ts";
import type { IntegrationRecord } from "./store.ts";

const permissionSchema = z.enum(["config.view", "config.edit", "config.publish"]);
const fieldSchema = z.enum(["systemPrompt", "modelId", "parameters", "mcpServerIds"]);
const originSchema = z
	.string()
	.refine((value) => parseStrictOrigin(value)?.canonical === value, "Origin must be canonical");
const policySchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		permissions: z.array(permissionSchema).min(1).max(3),
		editable_fields: z.array(fieldSchema).max(4),
		allowed_origins: z.array(originSchema).min(1).max(20),
	})
	.strict()
	.refine((value) => value.permissions.includes("config.view"), "config.view is required");
const configSchema = z
	.object({
		systemPrompt: configurationSchema.shape.systemPrompt,
		modelId: configurationSchema.shape.modelId,
		parameters: configurationSchema.shape.parameters,
		mcpServerIds: z.array(z.string().regex(/^mcp_[0-9a-f-]{36}$/)).max(8),
	})
	.strict();
const draftSchema = z
	.object({ expected_draft_revision: z.number().int().min(0), changes: configSchema.partial() })
	.strict();
const resetSchema = z
	.object({
		expected_draft_revision: z.number().int().min(0),
		expected_active_version: z.string(),
		reset: z.literal(true),
	})
	.strict();
const publishSchema = z
	.object({ expected_draft_revision: z.number().int().positive(), expected_active_version: z.string() })
	.strict();
const refsSchema = z.array(
	z
		.object({ mcpServerId: z.string(), revision: z.number().int().positive(), toolNames: z.array(z.string()) })
		.strict(),
);
type GrantRecord = ConfigurationGrant & { capabilityVersionId: string };
const denied = () => new OrchestrationError(403, "CONFIGURATION_FORBIDDEN", "没有此配置操作权限");

function grant(row: Record<string, unknown>): GrantRecord {
	return {
		id: String(row.id),
		name: String(row.name),
		enabled: row.enabled === true,
		revision: Number(row.revision),
		permissions: z.array(permissionSchema).parse(row.permissions),
		editable_fields: z.array(fieldSchema).parse(row.editable_fields),
		allowed_origins: z.array(originSchema).parse(row.allowed_origins),
		capabilityVersionId: String(row.capability_version_id),
	};
}

/** Configuration-only capabilities; never accepted by chat, Run or legacy configuration auth. */
export class ExternalConfigurationService {
	private readonly service: OrchestrationService;
	constructor(service: OrchestrationService) {
		this.service = service;
	}
	private get store() {
		return this.service.store;
	}
	async grants(integrationId: string): Promise<ConfigurationGrant[]> {
		await this.store.getIntegration(integrationId);
		const rows = await this.store.client.run(
			"select * from orchestration_configuration_grants where tenant_id=$1 and integration_id=$2 order by created_at,id",
			this.store.tenantId,
			integrationId,
		);
		return rows.map((row) => {
			const { capabilityVersionId: _, ...value } = grant(row);
			return value;
		});
	}
	async createGrant(integrationId: string, body: unknown) {
		const policy = policySchema.parse(body),
			id = randomUUID(),
			secret = randomBytes(32).toString("base64url");
		await this.store.client.transaction(async (tx) => {
			const i = await this.store.getIntegration(integrationId, tx);
			if (i.configurationId)
				throw new OrchestrationError(
					409,
					"EXTERNAL_CONFIGURATION_UNAVAILABLE",
					"独立编排由平台配置，外部项目只调用任务 API",
				);
			await tx`insert into orchestration_configuration_grants(id,tenant_id,integration_id,name,secret_hash,permissions,editable_fields,allowed_origins,capability_version_id)
			values (${id},${this.store.tenantId},${integrationId},${policy.name},${credentialHash(secret)},${tx.json(policy.permissions)},${tx.json(policy.editable_fields)},${tx.json(policy.allowed_origins)},${i.versionId})`;
		});
		return { id, credential: `oc_${id}.${secret}` };
	}
	async updateGrant(integrationId: string, id: string, body: unknown) {
		const input = z
			.object({
				expected_revision: z.number().int().positive(),
				enabled: z.boolean().optional(),
				policy: policySchema.optional(),
				rotate: z.boolean().optional(),
			})
			.strict()
			.parse(body);
		const secret = input.rotate ? randomBytes(32).toString("base64url") : undefined;
		await this.store.client.transaction(async (tx) => {
			const i = await this.store.getIntegration(integrationId, tx);
			const rows = await txRows(
				tx,
				"select * from orchestration_configuration_grants where tenant_id=$1 and integration_id=$2 and id=$3 for update",
				this.store.tenantId,
				integrationId,
				id,
			);
			if (!rows[0]) throw new OrchestrationError(404, "NOT_FOUND", "配置授权不存在");
			const current = grant(rows[0]);
			if (current.revision !== input.expected_revision)
				throw new OrchestrationError(409, "GRANT_CONFLICT", "授权已更新");
			const policy = input.policy ?? current;
			await txRows(
				tx,
				`update orchestration_configuration_grants set name=$4,enabled=$5,permissions=$6::jsonb,editable_fields=$7::jsonb,allowed_origins=$8::jsonb,revision=revision+1,secret_hash=$9,capability_version_id=$10 where tenant_id=$1 and integration_id=$2 and id=$3`,
				this.store.tenantId,
				integrationId,
				id,
				policy.name,
				input.enabled ?? current.enabled,
				policy.permissions,
				policy.editable_fields,
				policy.allowed_origins,
				secret ? credentialHash(secret) : String(rows[0].secret_hash),
				input.policy ? i.versionId : current.capabilityVersionId,
			);
		});
		return { id, revision: input.expected_revision + 1, ...(secret ? { credential: `oc_${id}.${secret}` } : {}) };
	}
	async exchange(header: string | undefined, body: unknown) {
		const input = z.object({ integration_id: z.string().uuid(), origin: originSchema }).strict().parse(body);
		const match = /^Bearer oc_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header ?? "");
		if (!match) throw new OrchestrationError(401, "CONFIGURATION_UNAUTHORIZED", "配置凭据无效");
		return this.store.client.transaction(async (tx) => {
			const i = await this.store.getIntegration(input.integration_id, tx);
			const rows = await txRows(
				tx,
				"select * from orchestration_configuration_grants where tenant_id=$1 and integration_id=$2 and id=$3",
				this.store.tenantId,
				i.id,
				match[1],
			);
			const expected = Buffer.from(String(rows[0]?.secret_hash ?? "0".repeat(64)), "hex");
			if (
				expected.length !== 32 ||
				!timingSafeEqual(expected, Buffer.from(credentialHash(match[2]!), "hex")) ||
				!rows[0]?.enabled ||
				!i.enabled
			)
				throw new OrchestrationError(401, "CONFIGURATION_UNAUTHORIZED", "配置凭据无效");
			const g = grant(rows[0]);
			if (!g.allowed_origins.includes(input.origin)) throw denied();
			await txRows(
				tx,
				"delete from orchestration_configuration_sessions where tenant_id=$1 and expires_at<=now()",
				this.store.tenantId,
			);
			const code = `cfgc_${randomBytes(32).toString("base64url")}`;
			await txRows(
				tx,
				"insert into orchestration_configuration_sessions values ($1,$2,$3,$4,$5,'code',$6,now()+interval '60 seconds')",
				credentialHash(code),
				this.store.tenantId,
				i.id,
				g.id,
				g.revision,
				input.origin,
			);
			return { code, expires_in: 60, page_path: `/aaas/integrations/${i.id}/configuration#code=${code}` };
		});
	}
	async consume(body: unknown) {
		const { code } = z
			.object({ code: z.string().regex(/^cfgc_[A-Za-z0-9_-]{43}$/) })
			.strict()
			.parse(body);
		return this.store.client.transaction(async (tx) => {
			// Delete first: concurrent consumers cannot mint more than one browser session.
			const codes = await txRows(
				tx,
				"delete from orchestration_configuration_sessions where tenant_id=$1 and secret_hash=$2 and kind='code' and expires_at>now() returning *",
				this.store.tenantId,
				credentialHash(code),
			);
			const c = codes[0];
			if (!c) throw new OrchestrationError(401, "CONFIGURATION_SESSION_INVALID", "配置入口已使用或过期");
			const i = await this.store.getIntegration(String(c.integration_id), tx);
			const rows = await txRows(
				tx,
				"select * from orchestration_configuration_grants where tenant_id=$1 and integration_id=$2 and id=$3",
				this.store.tenantId,
				i.id,
				String(c.grant_id),
			);
			if (!i.enabled || !rows[0]?.enabled || Number(rows[0].revision) !== Number(c.grant_revision))
				throw new OrchestrationError(401, "CONFIGURATION_SESSION_INVALID", "配置授权已失效");
			const token = `cfgs_${randomBytes(32).toString("base64url")}`;
			await txRows(
				tx,
				"insert into orchestration_configuration_sessions values ($1,$2,$3,$4,$5,'session',$6,now()+interval '15 minutes')",
				credentialHash(token),
				this.store.tenantId,
				i.id,
				String(c.grant_id),
				Number(c.grant_revision),
				String(c.origin),
			);
			return { access_token: token, integration_id: i.id, expires_in: 900 };
		});
	}
	private async access(
		header: string | undefined,
		i: IntegrationRecord,
		permission: ConfigurationPermission,
		tx: TransactionSql,
	): Promise<GrantRecord> {
		if (!/^Bearer cfgs_[A-Za-z0-9_-]{43}$/.test(header ?? ""))
			throw new OrchestrationError(401, "CONFIGURATION_UNAUTHORIZED", "需要独立配置会话");
		const rows = await txRows(
			tx,
			`select g.* from orchestration_configuration_sessions s join orchestration_configuration_grants g on g.tenant_id=s.tenant_id and g.integration_id=s.integration_id and g.id=s.grant_id where s.tenant_id=$1 and s.integration_id=$2 and s.secret_hash=$3 and s.kind='session' and s.expires_at>now() and s.grant_revision=g.revision and g.enabled=true`,
			this.store.tenantId,
			i.id,
			credentialHash(header!.slice(7)),
		);
		if (!rows[0] || !i.enabled)
			throw new OrchestrationError(401, "CONFIGURATION_SESSION_INVALID", "配置会话已过期或授权已撤回");
		const g = grant(rows[0]);
		if (!g.permissions.includes(permission)) throw denied();
		return g;
	}
	private async draft(i: IntegrationRecord, tx: TransactionSql) {
		const rows = await txRows(
			tx,
			"select * from orchestration_configuration_drafts where tenant_id=$1 and integration_id=$2",
			this.store.tenantId,
			i.id,
		);
		if (rows[0])
			return {
				revision: Number(rows[0].revision),
				baseVersionId: String(rows[0].base_version_id),
				configuration: configSchema.parse(rows[0].configuration),
				refs: refsSchema.parse(rows[0].mcp_refs),
			};
		const source = await this.service.configurationSource(i);
		return {
			revision: 0,
			baseVersionId: i.versionId,
			configuration: configSchema.parse(source.configuration),
			refs: source.refs,
		};
	}
	private async viewData(
		i: IntegrationRecord,
		g: GrantRecord,
		tx: TransactionSql,
	): Promise<ExternalConfigurationView> {
		const [source, draft, approved, models] = await Promise.all([
			this.service.configurationSource(i),
			this.draft(i, tx),
			this.service.configurationSource({ ...i, versionId: g.capabilityVersionId }),
			this.service.configurationModels(i),
		]);
		return {
			integration_id: i.id,
			name: i.name,
			published_version: `pav_${i.versionId}`,
			published: source.configuration,
			draft: {
				revision: draft.revision,
				base_version: `pav_${draft.baseVersionId}`,
				configuration: draft.configuration,
			},
			editable_fields: g.editable_fields,
			permissions: {
				view: true,
				edit: g.permissions.includes("config.edit"),
				publish: g.permissions.includes("config.publish"),
			},
			options: { models, mcpServers: approved.servers },
		};
	}
	async view(header: string | undefined, id: string) {
		return this.store.client.transaction(async (tx) => {
			const i = await this.store.getIntegration(id, tx),
				g = await this.access(header, i, "config.view", tx);
			return this.viewData(i, g, tx);
		});
	}
	private checkFields(fields: readonly string[], g: GrantRecord) {
		if (fields.some((field) => !g.editable_fields.includes(field as ExternalConfigurationField)))
			throw new OrchestrationError(403, "FIELD_NOT_EDITABLE", "包含未授权修改的字段");
	}
	private async checkConfiguration(configuration: ExternalAgentConfiguration, i: IntegrationRecord) {
		if (!i.settings.allowedModels.includes(configuration.modelId))
			throw new OrchestrationError(403, "MODEL_NOT_ALLOWED", "模型不在接入白名单内");
		if (new Set(configuration.mcpServerIds).size !== configuration.mcpServerIds.length)
			throw new OrchestrationError(400, "INVALID_MCP_SELECTION", "MCP 服务不能重复");
		const models = await this.service.configurationModels(i),
			model = models.find((m) => m.id === configuration.modelId),
			reasoning = configuration.parameters.reasoning;
		if (model && reasoning) {
			const c = model.parameterCapabilities.reasoning;
			if (
				(!c.supported && Object.keys(reasoning).length > 0) ||
				(reasoning.enabled === false && !c.toggle) ||
				(reasoning.effort && !c.efforts.includes(reasoning.effort))
			)
				throw new OrchestrationError(422, "INVALID_PARAMETERS", "当前模型不支持所选思考参数");
		}
	}
	async saveDraft(header: string | undefined, id: string, body: unknown) {
		const reset = typeof body === "object" && body !== null && "reset" in body;
		const request = reset ? resetSchema.parse(body) : draftSchema.parse(body);
		return this.store.client.transaction(async (tx) => {
			const i = await this.store.getIntegration(id, tx),
				g = await this.access(header, i, "config.edit", tx),
				current = await this.draft(i, tx);
			if (current.revision !== request.expected_draft_revision)
				throw new OrchestrationError(409, "DRAFT_CONFLICT", "草稿已更新，请重新读取，当前修改未保存");
			let configuration = current.configuration,
				refs = current.refs,
				baseVersionId = current.baseVersionId;
			if ("reset" in request) {
				if (request.expected_active_version !== `pav_${i.versionId}`)
					throw new OrchestrationError(409, "ACTIVE_VERSION_CONFLICT", "生效版本已更新");
				const source = await this.service.configurationSource(i);
				this.checkFields(
					Object.keys(current.configuration).filter(
						(key) =>
							canonicalJson(current.configuration[key as keyof ExternalAgentConfiguration]) !==
							canonicalJson(source.configuration[key as keyof ExternalAgentConfiguration]),
					),
					g,
				);
				if (canonicalJson(current.refs) !== canonicalJson(source.refs)) this.checkFields(["mcpServerIds"], g);
				configuration = configSchema.parse(source.configuration);
				refs = source.refs;
				baseVersionId = i.versionId;
			} else {
				this.checkFields(Object.keys(request.changes), g);
				configuration = configSchema.parse({ ...configuration, ...request.changes });
				if (request.changes.mcpServerIds) {
					const approved = await this.service.configurationSource({ ...i, versionId: g.capabilityVersionId });
					if (
						configuration.mcpServerIds.some((server) => !approved.refs.some((ref) => ref.mcpServerId === server))
					)
						throw new OrchestrationError(403, "MCP_NOT_ALLOWED", "只能选择明确授权的已发布 MCP 服务");
					refs = approved.refs.filter((ref) => configuration.mcpServerIds.includes(ref.mcpServerId));
				}
				await this.checkConfiguration(configuration, i);
			}
			await txRows(
				tx,
				`insert into orchestration_configuration_drafts(tenant_id,integration_id,revision,base_version_id,configuration,mcp_refs,updated_by) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) on conflict(tenant_id,integration_id) do update set revision=excluded.revision,base_version_id=excluded.base_version_id,configuration=excluded.configuration,mcp_refs=excluded.mcp_refs,updated_by=excluded.updated_by,updated_at=now()`,
				this.store.tenantId,
				i.id,
				current.revision + 1,
				baseVersionId,
				configuration,
				refs,
				g.id,
			);
			return this.viewData(i, g, tx);
		});
	}
	async publish(header: string | undefined, id: string, body: unknown) {
		const request = publishSchema.parse(body);
		return this.store.client.transaction(async (tx) => {
			const i = await this.store.getIntegration(id, tx),
				g = await this.access(header, i, "config.publish", tx),
				draft = await this.draft(i, tx);
			if (draft.revision !== request.expected_draft_revision)
				throw new OrchestrationError(409, "DRAFT_CONFLICT", "草稿已更新，请重新读取后发布");
			if (request.expected_active_version !== `pav_${i.versionId}`)
				throw new OrchestrationError(409, "ACTIVE_VERSION_CONFLICT", "生效版本已更新，请核对后发布");
			if (draft.baseVersionId !== i.versionId)
				throw new OrchestrationError(409, "DRAFT_BASE_CONFLICT", "草稿基于旧版本，请从当前生效版本重建后编辑");
			const source = await this.service.configurationSource(i);
			const changed = Object.keys(draft.configuration).filter(
				(key) =>
					canonicalJson(draft.configuration[key as keyof ExternalAgentConfiguration]) !==
					canonicalJson(source.configuration[key as keyof ExternalAgentConfiguration]),
			);
			if (canonicalJson(draft.refs) !== canonicalJson(source.refs) && !changed.includes("mcpServerIds"))
				changed.push("mcpServerIds");
			this.checkFields(changed, g);
			await this.checkConfiguration(draft.configuration, i);
			if (changed.includes("mcpServerIds")) {
				const approved = await this.service.configurationSource({ ...i, versionId: g.capabilityVersionId });
				if (draft.refs.some((ref) => !approved.refs.some((a) => canonicalJson(a) === canonicalJson(ref))))
					throw new OrchestrationError(403, "MCP_NOT_ALLOWED", "草稿 MCP 选择不在当前授权范围");
			}
			const versionId = await this.service.prepareConfigurationVersion(i, draft.configuration, draft.refs, tx);
			await txRows(
				tx,
				"update orchestration_integrations set revision=revision+1,published_app_version_id=$3 where tenant_id=$1 and id=$2",
				this.store.tenantId,
				i.id,
				versionId,
			);
			await txRows(
				tx,
				"update orchestration_configuration_drafts set revision=revision+1,base_version_id=$3,updated_by=$4,updated_at=now() where tenant_id=$1 and integration_id=$2",
				this.store.tenantId,
				i.id,
				versionId,
				g.id,
			);
			return this.viewData({ ...i, versionId, revision: i.revision + 1 }, g, tx);
		});
	}
	async pageOrigins(id: string) {
		return (await this.grants(id)).filter((g) => g.enabled).flatMap((g) => g.allowed_origins);
	}
}

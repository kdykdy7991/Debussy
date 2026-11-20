import { randomUUID } from "node:crypto";
import type {
	AgentMcpRevisionReference,
	AnalysisConfiguration,
	OrchestrationCatalog,
} from "@earendil-works/pi-protocol";
import type { TransactionSql } from "postgres";
import type { z } from "zod";
import type { ExecutionPrincipal } from "../embed/conversations/execution-configuration.ts";
import type { ConversationService } from "../embed/conversations/service.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import type { ControlService } from "../publishing/control/service.ts";
import type { PrincipalId, PublishedAppId, PublishedAppVersionId, TenantId, TurnId } from "../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { legacyConfigurationWritable } from "./api-key.ts";
import {
	CONNECTION_FAILED,
	CREDENTIAL_EXPIRED,
	MCP_AUTH_FAILED,
	MCP_RESULT_BLOCKED,
	type McpRunGuard,
} from "./api-key-boundary.ts";
import {
	prepareOrchestrationVersion,
	type TaskConfiguration,
	taskConfigurationSchema,
} from "./configuration-domain.ts";
import { validatePlatformBindings, type PlatformBinding } from "./api-key.ts";
import { type configurationSchema, type createIntegrationSchema, OrchestrationError } from "./contracts.ts";
import { modelToolSchema } from "./protected-tool.ts";
import type { ClaimedAssignment, IntegrationRecord, OrchestrationStore } from "./store.ts";

/** Application Router: accepts explicit work and delegates execution through the existing conversation service. */
export class OrchestrationService {
	readonly store: OrchestrationStore;
	private readonly control: ControlService;
	private readonly repos: PublishingRepositories;
	private readonly conversations: ConversationService;
	/** Optional MCP safety guard; undefined keeps the legacy execution path untouched. */
	private readonly mcpGuard?: McpRunGuard;
	constructor(
		store: OrchestrationStore,
		control: ControlService,
		repos: PublishingRepositories,
		conversations: ConversationService,
		mcpGuard?: McpRunGuard,
	) {
		this.store = store;
		this.control = control;
		this.repos = repos;
		this.conversations = conversations;
		this.mcpGuard = mcpGuard;
	}

	async createIntegration(input: z.infer<typeof createIntegrationSchema>) {
		const configuration = taskConfigurationSchema.parse(input.configuration);
		if (!input.settings.allowedModels.includes(configuration.modelId))
			throw new OrchestrationError(403, "MODEL_NOT_ALLOWED", "模型不在接入白名单内");
		const version = await prepareOrchestrationVersion({
			tenantId: this.store.tenantId as TenantId,
			draftRevision: 1,
			configuration,
			control: this.control,
			repositories: this.repos,
		});
		this.validateBindings(version.runtimeSpec, input.settings.bindings);
		return this.store.createTaskIntegration(input.name, input.settings, version);
	}

	async createIndependentConfiguration(name: string, input: unknown) {
		const draft = taskConfigurationSchema.parse(input);
		const id = randomUUID();
		await this.store.client.run(
			"insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,$3,$4::jsonb,1)",
			id,
			this.store.tenantId,
			name,
			draft,
		);
		return this.independentConfiguration(id);
	}

	async independentConfigurations() {
		const rows = await this.store.client.run(
			"select id,name,draft_revision from orchestration_configurations where tenant_id=$1 and enabled=true order by name,id",
			this.store.tenantId,
		);
		return rows.map((row) => ({
			id: String(row.id),
			name: String(row.name),
			draftRevision: Number(row.draft_revision),
		}));
	}

	async independentConfiguration(id: string) {
		const [row] = await this.store.client.run(
			"select id,name,draft,draft_revision from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
			this.store.tenantId,
			id,
		);
		if (!row) throw new OrchestrationError(404, "NOT_FOUND", "编排配置不存在");
		const versions = await this.store.client.run(
			"select id,source_draft_revision,created_at from orchestration_versions where tenant_id=$1 and configuration_id=$2 order by source_draft_revision desc",
			this.store.tenantId,
			id,
		);
		return {
			id: String(row.id),
			name: String(row.name),
			draft: taskConfigurationSchema.parse(row.draft),
			draftRevision: Number(row.draft_revision),
			versions: versions.map((v) => ({
				id: String(v.id),
				revision: Number(v.source_draft_revision),
				createdAt: (v.created_at as Date).toISOString(),
			})),
		};
	}

	async saveIndependentDraft(id: string, expectedRevision: number, input: unknown) {
		const draft = taskConfigurationSchema.parse(input);
		const rows = await this.store.client.run(
			"update orchestration_configurations set draft=$4::jsonb,draft_revision=draft_revision+1 where tenant_id=$1 and id=$2 and enabled=true and draft_revision=$3 returning id",
			this.store.tenantId,
			id,
			expectedRevision,
			draft,
		);
		if (!rows.length) {
			await this.independentConfiguration(id);
			throw new OrchestrationError(409, "DRAFT_CONFLICT", "草稿已更新，请重新读取");
		}
		return this.independentConfiguration(id);
	}

	async independentVersion(id: string, versionId: string) {
		const version = await this.store.configurations.getVersion(this.store.tenantId, versionId, id);
		if (!version) throw new OrchestrationError(404, "NOT_FOUND", "编排版本不存在");
		return {
			id: version.id,
			configurationId: version.configurationId,
			revision: version.sourceDraftRevision,
			snapshot: version.snapshot,
		};
	}

	async publishIndependentConfiguration(id: string, expectedRevision: number) {
		return this.store.client.transaction(async (tx) => {
			const [row] = await txRows(
				tx,
				"select draft,draft_revision from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true for update",
				this.store.tenantId,
				id,
			);
			if (!row) throw new OrchestrationError(404, "NOT_FOUND", "编排配置不存在");
			if (Number(row.draft_revision) !== expectedRevision)
				throw new OrchestrationError(409, "DRAFT_CONFLICT", "草稿已更新，请重新读取");
			const [existing] = await txRows(
				tx,
				"select id from orchestration_versions where tenant_id=$1 and configuration_id=$2 and source_draft_revision=$3",
				this.store.tenantId,
				id,
				expectedRevision,
			);
			if (existing) return { id: String(existing.id), revision: expectedRevision };
			const version = await prepareOrchestrationVersion({
				tenantId: this.store.tenantId as TenantId,
				configurationId: id,
				draftRevision: expectedRevision,
				configuration: taskConfigurationSchema.parse(row.draft),
				control: this.control,
				repositories: this.repos,
			});
			await this.store.configurations.insertVersion(tx, version);
			return { id: version.id, revision: expectedRevision };
		});
	}

	/**
	 * Gateway-style "save and apply": one transaction writes the draft, publishes a
	 * new immutable version, registers that version's credential mapping, and points
	 * the platform default at it. Versions stay immutable and already accepted Runs
	 * keep their frozen capability snapshot; only new Runs see the new configuration.
	 */
	async applyCurrentConfiguration(input: {
		configurationId: string | null;
		name: string;
		draft: unknown;
		expectedRevision?: number;
		credentialBindings: readonly PlatformBinding[];
	}) {
		const draft = taskConfigurationSchema.parse(input.draft);
		const bindings = input.credentialBindings;
		return this.store.client.transaction(async (tx) => {
			if (!(await legacyConfigurationWritable(this.store.client, this.store.tenantId, tx)))
				throw new OrchestrationError(409, "LEGACY_CONFIGURATION_RETIRED", "旧 AaaS 执行配置已进入只读状态");
			let configurationId = input.configurationId;
			let draftRevision: number;
			if (configurationId === null) {
				configurationId = randomUUID();
				draftRevision = 1;
				await txRows(
					tx,
					"insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,$3,$4::jsonb,1)",
					configurationId,
					this.store.tenantId,
					input.name,
					draft,
				);
			} else {
				const [row] = await txRows(
					tx,
					"select draft_revision from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true for update",
					this.store.tenantId,
					configurationId,
				);
				if (!row) throw new OrchestrationError(404, "NOT_FOUND", "编排配置不存在");
				if (input.expectedRevision !== undefined && Number(row.draft_revision) !== input.expectedRevision)
					throw new OrchestrationError(409, "DRAFT_CONFLICT", "草稿已更新，请重新读取");
				draftRevision = Number(row.draft_revision) + 1;
				await txRows(
					tx,
					"update orchestration_configurations set name=$4,draft=$3::jsonb,draft_revision=$5 where tenant_id=$1 and id=$2",
					this.store.tenantId,
					configurationId,
					draft,
					input.name,
					draftRevision,
				);
			}
			const version = await prepareOrchestrationVersion({
				tenantId: this.store.tenantId as TenantId,
				configurationId,
				draftRevision,
				configuration: draft,
				control: this.control,
				repositories: this.repos,
			});
			const compiled = parseRuntimeSpec(version.runtimeSpec);
			if (!compiled.ok) throw new OrchestrationError(422, "INVALID_VERSION", "执行配置编译失败");
			validatePlatformBindings(compiled.spec, bindings);
			await this.store.configurations.insertVersion(tx, version);
			await txRows(
				tx,
				`insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings)
				 values ($1,$2,$3::jsonb) on conflict (tenant_id,orchestration_version_id) do nothing`,
				this.store.tenantId,
				version.id,
				bindings,
			);
			// The configuration's own effective pointer moves atomically with publish.
			await txRows(
				tx,
				"update orchestration_configurations set active_version_id=$3 where tenant_id=$1 and id=$2",
				this.store.tenantId,
				configurationId,
				version.id,
			);
			// Only move the platform-default pointer when the saved configuration IS the
			// platform default; saving a named configuration must not affect other Keys.
			const [platform] = await txRows(
				tx,
				"select configuration_id from aaas_platform_configuration where tenant_id=$1 and enabled=true",
				this.store.tenantId,
			);
			if (platform && String(platform.configuration_id) === configurationId) {
				await txRows(
					tx,
					`update aaas_platform_configuration set orchestration_version_id=$3,credential_bindings=$4::jsonb,updated_at=now()
					 where tenant_id=$1 and configuration_id=$2`,
					this.store.tenantId,
					configurationId,
					version.id,
					bindings,
				);
			} else if (!platform) {
				// No default yet: the first saved configuration becomes the platform default.
				await txRows(
					tx,
					`insert into aaas_platform_configuration(tenant_id,configuration_id,orchestration_version_id,credential_bindings,enabled)
					 values ($1,$2,$3,$4::jsonb,true)`,
					this.store.tenantId,
					configurationId,
					version.id,
					bindings,
				);
			}
			return {
				configurationId,
				orchestrationVersionId: version.id,
				revision: draftRevision,
			};
		});
	}

	private validateBindings(runtimeSpec: unknown, bindings: IntegrationRecord["settings"]["bindings"]) {
		const parsed = parseRuntimeSpec(runtimeSpec);
		if (!parsed.ok) throw new OrchestrationError(422, "INVALID_VERSION", "执行配置不可用");
		for (const binding of bindings) {
			const tool = parsed.spec.capabilities.mcpServers
				.find((s) => s.mcpServerId === binding.mcpServerId)
				?.tools.find((t) => t.name === binding.toolName);
			if (!tool) throw new OrchestrationError(422, "INVALID_BINDING", "工具不在编排版本白名单内");
			modelToolSchema(
				tool.inputSchema,
				bindings.filter((b) => b.mcpServerId === binding.mcpServerId && b.toolName === binding.toolName),
			);
		}
	}

	async catalog(): Promise<OrchestrationCatalog> {
		const tenantId = this.store.tenantId as TenantId;
		const models = await this.control.listLlmModels();
		if (!models.ok) throw new OrchestrationError(503, "MODEL_CATALOG_UNAVAILABLE", "无法加载模型目录");
		const mcpServers: NonNullable<OrchestrationCatalog["mcpServers"]>[number][] = [];
		for (const server of await this.repos.mcpServers.list({ tenantId }, 100)) {
			if (server.status !== "enabled") continue;
			const tools = await this.repos.mcpServers.listTools({ tenantId }, server.mcpServerId, server.currentRevision);
			mcpServers.push({
				id: `mcp_${server.mcpServerId}`,
				name: server.name,
				revision: server.currentRevision,
				tools: tools.map((tool) => {
					const properties = tool.inputSchema.properties;
					const credentialParameters =
						properties && typeof properties === "object"
							? Object.keys(properties).filter((parameter) => {
									if (
										!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter) ||
										["__proto__", "constructor", "prototype"].includes(parameter)
									)
										return false;
									try {
										modelToolSchema(tool.inputSchema, [
											{
												mcpServerId: `mcp_${server.mcpServerId}`,
												toolName: tool.name,
												parameter,
												credential: "taskKey",
											},
										]);
										return true;
									} catch {
										return false;
									}
								})
							: [];
					return {
						mcpServerId: `mcp_${server.mcpServerId}`,
						serverName: server.name,
						name: tool.name,
						credentialParameters,
					};
				}),
			});
		}
		const skills = (await this.repos.skills.list({ tenantId }, 100))
			.filter((s) => s.status === "enabled")
			.map((s) => ({ id: `skill_${s.skillId}`, name: s.name, revision: s.currentRevision }));
		return {
			models: models.data.items.map(({ id, name, provider, parameterCapabilities }) => ({
				id,
				name,
				provider,
				parameterCapabilities,
			})),
			applications: [],
			mcpServers,
			skills,
		};
	}

	private async snapshot(i: IntegrationRecord): Promise<TaskConfiguration> {
		if (i.configurationId) {
			const version = await this.store.configurations.getVersion(i.tenantId, i.versionId, i.configurationId);
			if (!version) throw new OrchestrationError(409, "VERSION_UNAVAILABLE", "编排版本不存在");
			return version.snapshot;
		}
		if (!i.appId) throw new OrchestrationError(409, "VERSION_UNAVAILABLE", "历史版本归属缺失");
		const version = await this.repos.publishedAppVersions.get(
			{ tenantId: i.tenantId as TenantId, publishedAppId: i.appId as PublishedAppId },
			i.versionId as PublishedAppVersionId,
		);
		const parsed = parseRuntimeSpec(version?.runtimeSpec);
		if (!parsed.ok) throw new OrchestrationError(409, "VERSION_UNAVAILABLE", "历史冻结配置不可用");
		const spec = parsed.spec;
		return taskConfigurationSchema.parse({
			systemPrompt: spec.agent.systemPrompt,
			modelId: spec.agent.model.modelId,
			parameters: spec.agent.model.params ?? {},
			mcpServers: spec.capabilities.mcpServers.map((s) => ({
				mcpServerId: s.mcpServerId,
				revision: s.revision,
				toolNames: s.tools.map((t) => t.name),
			})),
			skills: spec.capabilities.skills.map((s) => ({ skillId: s.skillId, revision: s.revision })),
			contextPolicy: {
				maxTurns: spec.contextPolicy.maxTurns,
				maxContextTokens: spec.contextPolicy.maxContextTokens,
				toolResultMaxBytes: spec.contextPolicy.toolResultMaxBytes,
			},
			runtimePolicy: spec.runtimePolicy,
		});
	}

	async configuration(i: IntegrationRecord): Promise<AnalysisConfiguration> {
		const snapshot = await this.snapshot(i);
		const definition = i.configurationId
			? await this.store.configurations.getDefinition(i.tenantId, i.configurationId)
			: undefined;
		return {
			...(definition ? { draftRevision: definition.revision } : {}),
			revision: i.revision,
			versionId: `${i.configurationId ? "orv" : "pav"}_${i.versionId}`,
			systemPrompt: snapshot.systemPrompt,
			modelId: snapshot.modelId,
			parameters: snapshot.parameters,
			allowedModels: i.settings.allowedModels,
			mcpServers: snapshot.mcpServers,
			skills: snapshot.skills,
		};
	}

	async saveConfiguration(i: IntegrationRecord, request: z.infer<typeof configurationSchema>) {
		const effective = await this.store.client.transaction(async (tx) => {
			const current = await this.store.getIntegration(i.id, tx);
			if (!current.enabled) throw new OrchestrationError(403, "DISABLED", "接入已停用");
			if (request.expectedRevision !== current.revision)
				throw new OrchestrationError(409, "CONFIGURATION_CONFLICT", "配置已更新，请重新读取");
			if (
				request.expectedActiveVersion !== undefined &&
				request.expectedActiveVersion !== `${current.configurationId ? "orv" : "pav"}_${current.versionId}`
			)
				throw new OrchestrationError(409, "ACTIVE_VERSION_CONFLICT", "生效版本已更新");
			if (!current.configurationId)
				throw new OrchestrationError(409, "MIGRATION_REQUIRED", "请先显式迁移历史接入的配置");
			const versionId = await this.prepareConfigurationVersion(current, request, undefined, tx);
			await txRows(
				tx,
				"update orchestration_integrations set revision=revision+1,orchestration_version_id=$3 where tenant_id=$1 and id=$2",
				current.tenantId,
				current.id,
				versionId,
			);
			return { ...current, versionId, revision: current.revision + 1 };
		});
		return this.configuration(effective);
	}

	async configurationSource(i: IntegrationRecord) {
		const snapshot = await this.snapshot(i),
			refs = snapshot.mcpServers;
		const servers = await Promise.all(
			refs.map(async (ref) => {
				const id = ref.mcpServerId.slice(4) as Parameters<PublishingRepositories["mcpServers"]["get"]>[1];
				const server = await this.repos.mcpServers.get({ tenantId: i.tenantId as TenantId }, id);
				return { id: ref.mcpServerId, name: server?.name ?? "MCP 服务", toolNames: ref.toolNames };
			}),
		);
		return {
			configuration: {
				systemPrompt: snapshot.systemPrompt,
				modelId: snapshot.modelId,
				parameters: snapshot.parameters,
				mcpServerIds: refs.map((r) => r.mcpServerId),
			},
			refs,
			servers,
		};
	}

	async configurationModels(i: IntegrationRecord) {
		const models = await this.control.listLlmModels();
		return models.ok
			? models.data.items
					.filter((m) => i.settings.allowedModels.includes(m.id))
					.map(({ id, name, provider, parameterCapabilities }) => ({ id, name, provider, parameterCapabilities }))
			: [];
	}

	async prepareConfigurationVersion(
		i: IntegrationRecord,
		request: Pick<AnalysisConfiguration, "systemPrompt" | "modelId" | "parameters" | "mcpServers" | "skills"> & {
			readonly expectedDraftRevision?: number;
		},
		mcpServers?: readonly AgentMcpRevisionReference[],
		tx?: TransactionSql,
	) {
		if (!tx || !i.configurationId)
			throw new OrchestrationError(409, "MIGRATION_REQUIRED", "发布需要独立编排配置及事务");
		if (!i.settings.allowedModels.includes(request.modelId))
			throw new OrchestrationError(403, "MODEL_NOT_ALLOWED", "模型不在接入白名单内");
		const [definition] = await txRows(
			tx,
			"select * from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true for update",
			i.tenantId,
			i.configurationId,
		);
		if (!definition) throw new OrchestrationError(409, "CONFIGURATION_UNAVAILABLE", "编排配置不可用");
		if (
			request.expectedDraftRevision !== undefined &&
			request.expectedDraftRevision !== Number(definition.draft_revision)
		)
			throw new OrchestrationError(409, "DRAFT_CONFLICT", "草稿已更新");
		const snapshot = await this.snapshot(i);
		const configuration = taskConfigurationSchema.parse({
			...snapshot,
			systemPrompt: request.systemPrompt,
			modelId: request.modelId,
			parameters: request.parameters,
			mcpServers: mcpServers ?? request.mcpServers ?? snapshot.mcpServers,
			skills: request.skills ?? snapshot.skills,
		});
		const revision = Number(definition.draft_revision) + 1;
		const version = await prepareOrchestrationVersion({
			tenantId: i.tenantId as TenantId,
			configurationId: i.configurationId,
			draftRevision: revision,
			configuration,
			control: this.control,
			repositories: this.repos,
		});
		this.validateBindings(version.runtimeSpec, i.settings.bindings);
		await txRows(
			tx,
			"update orchestration_configurations set draft=$3::jsonb,draft_revision=$4 where tenant_id=$1 and id=$2",
			i.tenantId,
			i.configurationId,
			configuration,
			revision,
		);
		await this.store.configurations.insertVersion(tx, version);
		return version.id;
	}

	/** Explicit one-time import of the current frozen snapshot. Historical work remains untouched. */
	async migrateConfiguration(id: string, expectedRevision: number, expectedVersion: string) {
		return this.store.client.transaction(async (tx) => {
			const current = await this.store.getLegacyIntegration(id, tx);
			if (
				current.revision !== expectedRevision ||
				`pav_${current.versionId}` !== expectedVersion ||
				current.configurationId
			)
				throw new OrchestrationError(409, "CONFIGURATION_CONFLICT", "接入已迁移或配置已改变");
			const snapshot = await this.snapshot(current);
			const frozen = await this.repos.publishedAppVersions.get(
				{ tenantId: current.tenantId as TenantId, publishedAppId: current.appId as PublishedAppId },
				current.versionId as PublishedAppVersionId,
			);
			const parsed = parseRuntimeSpec(frozen?.runtimeSpec);
			if (
				!parsed.ok ||
				frozen?.status !== "ready" ||
				(frozen?.runtimeSpecHash && sha256Hex(canonicalJson(parsed.spec)) !== frozen.runtimeSpecHash)
			)
				throw new OrchestrationError(409, "INVALID_VERSION", "历史配置校验失败");
			if (
				parsed.spec.runtimePolicy.profile !== "chat-only" ||
				parsed.spec.capabilities.tools.length ||
				parsed.spec.capabilities.knowledgeBases.length
			)
				throw new OrchestrationError(
					422,
					"UNSUPPORTED_CAPABILITIES",
					"历史快照包含当前任务 Runtime 不支持的能力，不能隐式丢弃",
				);
			const versionId = randomUUID(),
				configurationId = randomUUID();
			const spec = { ...parsed.spec, publishedAppVersionId: `orv_${versionId}` };
			await this.store.configurations.create(tx, current.name, {
				id: versionId,
				tenantId: current.tenantId,
				configurationId,
				sourceDraftRevision: 1,
				snapshot,
				runtimeSpec: spec,
				runtimeSpecHash: sha256Hex(canonicalJson(spec)),
			});
			await txRows(
				tx,
				`update orchestration_integrations set published_app_id=null,published_app_version_id=null,configuration_id=$3,orchestration_version_id=$4,revision=revision+1 where tenant_id=$1 and id=$2`,
				current.tenantId,
				id,
				configurationId,
				versionId,
			);
			// Historical external configuration grants cannot silently expand into the independent domain.
			await txRows(
				tx,
				"update orchestration_configuration_grants set enabled=false,revision=revision+1 where tenant_id=$1 and integration_id=$2",
				current.tenantId,
				id,
			);
			return { configurationId, versionId: `orv_${versionId}`, revision: current.revision + 1 };
		});
	}

	principal(i: IntegrationRecord, a: ClaimedAssignment): ExecutionPrincipal {
		if (a.configurationId)
			return {
				tokenId: `orchestration:${a.id}`,
				tenantId: i.tenantId as TenantId,
				publishedAppId: null,
				integrationId: i.id,
				principalId: a.principalId as PrincipalId,
			};
		const appId = a.appId ?? i.appId;
		if (!appId) throw new OrchestrationError(409, "INVALID_EXECUTION_OWNER", "历史任务归属缺失");
		return {
			tokenId: `orchestration:${a.id}`,
			tenantId: i.tenantId as TenantId,
			publishedAppId: appId as PublishedAppId,
			principalId: a.principalId as PrincipalId,
			principalType: "service",
			scopes: [],
			issuedAt: new Date(),
			expiresAt: new Date(Date.now() + 120000),
			publishedAppVersionId: a.versionId as PublishedAppVersionId,
		};
	}

	async execute(a: ClaimedAssignment) {
		const i = await this.store.getIntegration(a.integrationId);
		if (!i.enabled) throw new OrchestrationError(403, "DISABLED", "接入已停用");
		if (a.configurationId) {
			const enabled = await this.store.client.run(
				"select 1 from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
				i.tenantId,
				a.configurationId,
			);
			if (!enabled[0]) throw new OrchestrationError(403, "CONFIGURATION_UNAVAILABLE", "编排已停用");
		}
		const principal = this.principal(i, a);
		await this.store.credentials(a.conversationId, a.turnId);
		this.mcpGuard?.clear(a.conversationId);
		const result = await this.runTurn(a, principal);
		// A safety-boundary hit or a connection auth failure must terminate the Run
		// even when the model would otherwise continue and produce a success report.
		// The hit may land after the turn settled; the marker is still persisted so a
		// restart cannot judge this Run successful.
		const fatal = this.mcpGuard?.take(a.conversationId);
		if (
			fatal === MCP_RESULT_BLOCKED ||
			fatal === MCP_AUTH_FAILED ||
			fatal === CREDENTIAL_EXPIRED ||
			fatal === CONNECTION_FAILED
		) {
			await this.persistFatal(a, fatal);
			throw new OrchestrationError(502, fatal, "任务执行失败");
		}
		if (!result.ok) throw new OrchestrationError(502, "EXECUTION_FAILED", "分析执行失败");
		const committed = await this.store.client.run(
			"select 1 from conversation_events where tenant_id=$1 and conversation_id=$2 and turn_id=$3 and event_type='turn/end'",
			i.tenantId,
			a.conversationId,
			a.turnId,
		);
		if (!committed[0]) throw new OrchestrationError(500, "TURN_NOT_COMMITTED", "执行结果未持久提交");
		return this.validateOutput(a.conversationId, a.turnId, result.data.outputText);
	}

	/**
	 * Executes the turn while watching the MCP safety boundary. A fatal hit ends
	 * the Run immediately: the in-flight turn is aborted and the Run fails with the
	 * fixed code instead of a model-authored success report.
	 */
	private async runTurn(a: ClaimedAssignment, principal: ExecutionPrincipal) {
		const input = {
			principal,
			conversationId: a.conversationId as Parameters<ConversationService["executeTurn"]>[0]["conversationId"],
			turnId: a.turnId as TurnId,
			text: a.input,
		};
		const guard = this.mcpGuard;
		let release: (() => void) | undefined;
		// The subscription is armed before the turn starts: a hit is only
		// observable while the turn is still in flight.
		const fatal = new Promise<string>((resolve) => {
			if (guard) release = guard.onFatal(a.conversationId, resolve);
		});
		const turn = this.conversations.executeTurn(input);
		if (!guard) return turn;
		const settled = turn.then(
			(result) => ({ kind: "turn" as const, result }),
			(error: unknown) => ({ kind: "error" as const, error }),
		);
		try {
			const outcome = await Promise.race([settled, fatal.then((code) => ({ kind: "fatal" as const, code }))]);
			if (outcome.kind === "fatal") {
				// The in-memory marker is consumed here; the durable one is persisted.
				guard.take(a.conversationId);
				await this.persistFatal(a, outcome.code);
				// Runtime cancellation may wait for an uncooperative tool to become idle.
				// The durable fatal marker and terminal state must not wait for it.
				void this.abortTurn(a, principal);
				throw new OrchestrationError(502, outcome.code, "任务执行失败");
			}
			if (outcome.kind === "error") {
				const code = guard.take(a.conversationId);
				if (
					code === MCP_RESULT_BLOCKED ||
					code === MCP_AUTH_FAILED ||
					code === CREDENTIAL_EXPIRED ||
					code === CONNECTION_FAILED
				) {
					await this.persistFatal(a, code);
					throw new OrchestrationError(502, code, "任务执行失败");
				}
				throw outcome.error;
			}
			return outcome.result;
		} finally {
			release?.();
		}
	}

	/**
	 * Durable fatal marker on the assignment. A restart reads it and must fail the
	 * Run instead of judging a committed model output successful.
	 */
	private async persistFatal(a: ClaimedAssignment, code: string): Promise<void> {
		try {
			await this.store.client.run(
				"update orchestration_assignments set error=$3 where tenant_id=$1 and id=$2 and state='running'",
				this.store.tenantId,
				a.id,
				code,
			);
		} catch {
			// The fixed code stays the outcome even when the marker cannot be written.
			console.warn(`[orchestration] fatal marker not persisted for assignment ${a.id}`);
		}
	}

	/** Stops the in-flight turn; the fixed code is the outcome either way. */
	private async abortTurn(a: ClaimedAssignment, principal: ExecutionPrincipal): Promise<void> {
		try {
			await this.conversations.cancelTurn({
				principal,
				conversationId: a.conversationId as Parameters<ConversationService["cancelTurn"]>[0]["conversationId"],
			});
		} catch {
			// An abort failure must never change the fixed outcome.
		}
	}

	/** Applied to normal completion and recovery; output formatting is owned by the Agent prompt. */
	async validateOutput(conversationId: string, turnId: string, output: string) {
		const credentials = await this.store.credentials(conversationId, turnId);
		if (
			Object.values(credentials.values).some(
				(key) => output.includes(key) || output.includes(JSON.stringify(key).slice(1, -1)),
			)
		)
			throw new OrchestrationError(422, "CREDENTIAL_IN_REPORT", "输出包含受保护内容");
		return output;
	}

	async cancel(id: string, integrationId?: string) {
		await this.store.cancel(id, integrationId);
		await this.abort(id);
		return { cancelled: true };
	}

	/** Stops computation without changing the business outcome (timeout/shutdown recovery). */
	async abort(id: string) {
		const rows = await this.store.client.run(
			"select * from orchestration_work_items where tenant_id=$1 and id=$2",
			this.store.tenantId,
			id,
		);
		const r = rows[0];
		if (!r) throw new OrchestrationError(404, "NOT_FOUND", "任务不存在");
		const i = await this.store.getIntegration(String(r.integration_id));
		const independent = r.orchestration_version_id !== null;
		const contexts = await this.store.client.run(
			"select published_app_id from conversations where tenant_id=$1 and id=$2",
			i.tenantId,
			String(r.conversation_id),
		);
		const principal: ExecutionPrincipal = independent
			? {
					tokenId: "orchestration:cancel",
					tenantId: i.tenantId as TenantId,
					publishedAppId: null,
					integrationId: i.id,
					principalId: String(r.principal_id) as PrincipalId,
				}
			: {
					tokenId: "orchestration:cancel",
					tenantId: i.tenantId as TenantId,
					publishedAppId: String(contexts[0]?.published_app_id) as PublishedAppId,
					principalId: String(r.principal_id) as PrincipalId,
					principalType: "service",
					scopes: [],
					issuedAt: new Date(),
					expiresAt: new Date(),
					publishedAppVersionId: String(r.published_app_version_id) as PublishedAppVersionId,
				};
		await this.conversations.cancelTurn({
			principal,
			conversationId: String(r.conversation_id) as Parameters<
				ConversationService["cancelTurn"]
			>[0]["conversationId"],
		});
	}
}

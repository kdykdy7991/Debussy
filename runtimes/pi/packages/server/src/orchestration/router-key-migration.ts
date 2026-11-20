import { randomUUID } from "node:crypto";
import type { TenantId } from "../publishing/domain/ids.ts";
import { newMcpToolId, newRequestId } from "../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import type { DirectCapabilities, SensitiveBinding, SensitiveRuleBatch } from "./router-capability-contracts.ts";
import { ROUTER_SUPPORTED_MODEL_PARAMETERS } from "./router-capability-contracts.ts";
import { expandSensitiveRules, internalServerId, validateSensitiveBindings } from "./router-capability.ts";

export type MigrationSourceMode = "fixed" | "explicit" | "platform";

export interface RouterKeyMigrationResult {
	readonly dryRun: boolean;
	readonly keys: readonly {
		readonly key_id: string;
		readonly source_mode: MigrationSourceMode;
		readonly source_version_id: string | null;
		readonly status: "migrated" | "skipped" | "pending";
		readonly capability_revision: number | null;
		readonly reason: string | null;
		readonly tools_mapped: number;
	}[];
	/** With dryRun enabled, revisions marked created are estimates only. */
	readonly revisions: readonly { readonly server_id: string; readonly revision: number; readonly created: boolean }[];
	readonly pending: readonly { readonly key_id: string; readonly reason: string; readonly source_version_id: string | null }[];
}

interface SourceKeyRow {
	readonly id: string;
	readonly versionId: string | null;
	readonly configurationId: string | null;
	readonly scope: string;
	readonly directCapabilities: unknown;
	readonly revision: number;
}

function reason(message: string): never {
	throw new Error(message);
}

/** Resolve a source version without ever silently substituting the platform default. */
export async function resolveMigrationSourceVersion(options: {
	readonly client: PostgresClient;
	readonly tenantId: string;
	readonly key: SourceKeyRow;
	readonly mode?: MigrationSourceMode;
}): Promise<{ readonly mode: MigrationSourceMode; readonly versionId: string | null; readonly reason: string | null }> {
	const { client, tenantId, key } = options;
	const requested = options.mode ?? (key.versionId !== null ? "fixed" : key.configurationId !== null ? "explicit" : "platform");
	if (requested === "fixed") {
		if (key.versionId === null) return { mode: requested, versionId: null, reason: "固定版本模式缺少版本关联" };
		const [row] = await client.run(
			"select 1 from orchestration_versions where tenant_id=$1 and id=$2",
			tenantId,
			key.versionId,
		);
		return { mode: requested, versionId: key.versionId, reason: row ? null : "显式版本关联失效" };
	}
	if (requested === "explicit") {
		if (key.configurationId === null) return { mode: requested, versionId: null, reason: "显式配置模式缺少配置关联" };
		const [row] = await client.run(
			"select active_version_id from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
			tenantId,
			key.configurationId,
		);
		if (!row || row.active_version_id === null)
			return { mode: requested, versionId: null, reason: "显式配置关联失效或没有生效版本" };
		return { mode: requested, versionId: String(row.active_version_id), reason: null };
	}
	// Platform default follows the same resolution as the live legacy /runs:
	// the configuration's active version wins over the stored version pointer.
	const [row] = await client.run(
		`select coalesce(c.active_version_id, p.orchestration_version_id) as version_id
		 from aaas_platform_configuration p
		 left join orchestration_configurations c
		   on c.tenant_id=p.tenant_id and c.id=p.configuration_id and c.enabled=true
		 where p.tenant_id=$1 and p.enabled=true`,
		tenantId,
	);
	return {
		mode: requested,
		versionId: row?.version_id == null ? null : String(row.version_id),
		reason: row?.version_id == null ? "平台默认配置不可用" : null,
	};
}

/** Validate a frozen source spec and its digest before any capability is derived. */
export function readMigrationRuntimeSpec(row: Record<string, unknown>): RuntimeSpec {
	const parsed = parseRuntimeSpec(row.runtime_spec);
	if (!parsed.ok) reason("源编排版本 RuntimeSpec 校验失败");
	if (String(row.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec)))
		reason("源编排版本 RuntimeSpec 摘要不一致");
	return parsed.spec;
}

/** Historical bindings are per Tool; group them into one batch rule per Server/parameter. */
export function toSensitiveRuleBatches(
	serverId: string,
	bindings: readonly { readonly mcpServerId: string; readonly toolName: string; readonly parameter: string; readonly credentialId: string }[],
): SensitiveRuleBatch[] {
	const grouped = new Map<string, SensitiveRuleBatch>();
	for (const binding of bindings) {
		if (internalServerId(binding.mcpServerId) !== internalServerId(serverId)) continue;
		const key = `${binding.parameter}\u0000${binding.credentialId}`;
		const existing = grouped.get(key);
		if (existing) existing.toolNames.push(binding.toolName);
		else
			grouped.set(key, {
				mcpServerId: serverId,
				toolNames: [binding.toolName],
				parameter: binding.parameter,
				credentialId: binding.credentialId,
			});
	}
	return [...grouped.values()];
}

/**
 * Spot-check used for the smart-ticket sample (39 tools mapped to authToken).
 * The real migration always derives its data from the preview query above.
 */
export function validateAuthTokenSample(
	bindings: readonly { readonly toolName: string; readonly parameter: string; readonly credentialId: string }[],
	toolNames: readonly string[],
	expectedCount = 39,
): { readonly ok: boolean; readonly count: number } {
	const mapped = bindings.filter(
		(binding) => binding.parameter === "authToken" && binding.credentialId === "tool_credential",
	);
	const valid = new Set(toolNames);
	const count = mapped.filter((binding) => valid.has(binding.toolName)).length;
	return { ok: count === expectedCount, count };
}

/** Preserve only parameters the Router schema can compile losslessly. */
export function extractMigratableModelParameters(params: unknown): Record<string, string | number | boolean | null> {
	if (params === undefined || params === null) return {};
	if (typeof params !== "object" || Array.isArray(params)) throw new Error("源模型参数无法等价转换");
	const result: Record<string, string | number | boolean | null> = {};
	for (const [name, value] of Object.entries(params)) {
		if (!(ROUTER_SUPPORTED_MODEL_PARAMETERS as readonly string[]).includes(name))
			throw new Error(`源模型参数 ${name} 无法等价转换`);
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
			result[name] = value;
		else throw new Error(`源模型参数 ${name} 无法等价转换`);
	}
	return result;
}

function canonicalBindings(bindings: readonly SensitiveBinding[]): string {
	return canonicalJson([...bindings].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))));
}

/**
 * Find or freeze a Revision equivalent to the source RuntimeSpec. The catalog's
 * current_revision pointer is never moved: migration only adds a frozen Revision
 * that the migrated Key can reference.
 */
async function equivalentSourceRevision(options: {
	readonly repos: PublishingRepositories;
	readonly tenantId: string;
	readonly dryRun: boolean;
	readonly serverId: string;
	readonly source: RuntimeSpec["capabilities"]["mcpServers"][number];
	readonly rules: readonly SensitiveBinding[];
}): Promise<{ readonly revision: number; readonly created: boolean }> {
	const { repos, tenantId, dryRun, serverId, source, rules } = options;
	const scope = { tenantId: tenantId as TenantId };
	const internalId = internalServerId(serverId);
	const sourceTools = source.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		inputSchemaHash: tool.inputSchemaHash,
	}));
	validateSensitiveBindings(serverId, sourceTools, rules);
	const expectedRules = canonicalBindings(rules);
	const revisions = await repos.mcpServers.listRevisions(scope, internalId as never);
	for (const candidate of revisions) {
		if (candidate.endpoint !== source.endpoint || candidate.authentication !== source.authentication) continue;
		// NULL is "never registered" and is never equivalent to an explicit [].
		if (candidate.sensitiveBindings == null || canonicalBindings(candidate.sensitiveBindings) !== expectedRules) continue;
		const tools = await repos.mcpServers.listTools(scope, internalId as never, candidate.revision);
		const rulesRegistered = sourceTools.every((expected) => {
			const tool = tools.find((entry) => entry.name === expected.name);
			return (
				tool !== undefined &&
				tool.inputSchemaHash === expected.inputSchemaHash &&
				tool.description === expected.description &&
				tool.sensitiveBindings != null &&
				canonicalBindings(tool.sensitiveBindings) === canonicalBindings(rules.filter((binding) => binding.toolName === expected.name))
			);
		});
		if (tools.length === sourceTools.length && rulesRegistered) return { revision: candidate.revision, created: false };
	}
	if (dryRun) {
		const estimatedRevision = revisions.reduce((max, entry) => Math.max(max, entry.revision), 0) + 1;
		return { revision: estimatedRevision, created: true };
	}
	const created = await repos.mcpServers.addRevision({
		scope,
		mcpServerId: internalId as never,
		advanceCurrentRevision: false,
		revision: {
			mcpServerId: internalId as never,
			tenantId: tenantId as TenantId,
			transport: source.transport,
			endpoint: source.endpoint,
			authentication: source.authentication,
			sensitiveBindings: rules,
			createdAt: new Date(),
		},
		tools: sourceTools.map((tool) => ({
			mcpToolId: newMcpToolId(),
			tenantId: tenantId as TenantId,
			mcpServerId: internalId as never,
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			inputSchemaHash: tool.inputSchemaHash,
			sensitiveBindings: rules.filter((binding) => binding.toolName === tool.name),
			createdAt: new Date(),
		})),
	});
	if (created === undefined) throw new Error("等价 Revision 冻结失败，请重试迁移");
	return { revision: created.revision, created: true };
}

/**
 * Preview or run the legacy Key migration. `dryRun` defaults to true; a run only
 * CAS-backfills Keys whose direct capabilities are still unconfigured, keeps the
 * legacy entry eligible ('dual'), and records an audit event per migrated Key.
 */
export async function migrateRouterKeys(options: {
	readonly client: PostgresClient;
	readonly repos: PublishingRepositories;
	readonly tenantId: string;
	readonly mode?: MigrationSourceMode;
	readonly dryRun?: boolean;
	readonly keyIds?: readonly string[];
}): Promise<RouterKeyMigrationResult> {
	const { client, repos, tenantId } = options;
	const dryRun = options.dryRun !== false;
	const keyRows: SourceKeyRow[] = (
		await client.run(
			`select id,orchestration_version_id,orchestration_configuration_id,
				router_capability_scope,direct_capabilities,direct_capability_revision
			 from aaas_api_keys where tenant_id=$1 order by created_at,id`,
			tenantId,
		)
	)
		.filter((row) => options.keyIds === undefined || options.keyIds.includes(String(row.id)))
		.map((row) => ({
			id: String(row.id),
			versionId: row.orchestration_version_id === null ? null : String(row.orchestration_version_id),
			configurationId: row.orchestration_configuration_id === null ? null : String(row.orchestration_configuration_id),
			scope: String(row.router_capability_scope),
			directCapabilities: row.direct_capabilities,
			revision: Number(row.direct_capability_revision),
		}));
	const keys: RouterKeyMigrationResult["keys"][number][] = [];
	const revisions: RouterKeyMigrationResult["revisions"][number][] = [];
	const pending: RouterKeyMigrationResult["pending"][number][] = [];

	for (const key of keyRows) {
		if (key.directCapabilities !== null && key.revision > 0) {
			keys.push({
				key_id: key.id,
				source_mode: options.mode ?? "fixed",
				source_version_id: null,
				status: "skipped",
				capability_revision: key.revision,
				reason: "已配置直接能力，不覆盖人工编辑",
				tools_mapped: 0,
			});
			continue;
		}
		let source: Awaited<ReturnType<typeof resolveMigrationSourceVersion>>;
		try {
			source = await resolveMigrationSourceVersion({ client, tenantId, key, mode: options.mode });
		} catch {
			pending.push({ key_id: key.id, reason: "源版本解析失败", source_version_id: null });
			continue;
		}
		if (source.reason !== null || source.versionId === null) {
			pending.push({ key_id: key.id, reason: source.reason ?? "源版本不可用", source_version_id: source.versionId });
			keys.push({
				key_id: key.id,
				source_mode: source.mode,
				source_version_id: source.versionId,
				status: "pending",
				capability_revision: null,
				reason: source.reason ?? "源版本不可用",
				tools_mapped: 0,
			});
			continue;
		}
		try {
			const [versionRow] = await client.run(
				"select runtime_spec,runtime_spec_hash from orchestration_versions where tenant_id=$1 and id=$2",
				tenantId,
				source.versionId,
			);
			if (!versionRow) throw new Error("显式版本关联失效");
			const spec = readMigrationRuntimeSpec(versionRow);
			const [bindingRow] = await client.run(
				"select credential_bindings from aaas_version_credential_bindings where tenant_id=$1 and orchestration_version_id=$2",
				tenantId,
				source.versionId,
			);
			if (!bindingRow || !Array.isArray(bindingRow.credential_bindings))
				throw new Error("源版本敏感规则未登记，需人工确认空规则后再迁移");
			const legacyBindings = (bindingRow.credential_bindings as Record<string, unknown>[]).map((value) => ({
				mcpServerId: String(value.mcpServerId),
				toolName: String(value.toolName),
				parameter: String(value.parameter),
				credentialId: String(value.credentialId),
			}));
			const parameters = extractMigratableModelParameters(spec.agent.model.params);
			const mcpServers: DirectCapabilities["mcp_servers"] = [];
			let toolsMapped = 0;
			for (const server of spec.capabilities.mcpServers) {
				const internalId = internalServerId(server.mcpServerId);
				const serverRecord = await repos.mcpServers.get({ tenantId: tenantId as TenantId }, internalId as never);
				const sourceRevision = await repos.mcpServers.getRevision(
					{ tenantId: tenantId as TenantId },
					internalId as never,
					server.revision,
				);
				if (!serverRecord || !sourceRevision)
					throw new Error("源 MCP Revision 在当前目录中不可用，需人工处理");
				if (sourceRevision.authentication !== server.authentication || sourceRevision.endpoint !== server.endpoint)
					throw new Error("源 RuntimeSpec 的 MCP 认证或端点与冻结 Revision 不一致");
				const frozenTools = new Map(
					(
						await repos.mcpServers.listTools(
							{ tenantId: tenantId as TenantId },
							internalId as never,
							server.revision,
						)
					).map((tool) => [tool.name, tool]),
				);
				const schemaEquivalent = server.tools.every((tool) => {
					const frozen = frozenTools.get(tool.name);
					return (
						frozen !== undefined &&
						frozen.inputSchemaHash === tool.inputSchemaHash &&
						canonicalJson(frozen.inputSchema) === canonicalJson(tool.inputSchema)
					);
				});
				if (!schemaEquivalent) throw new Error("源 RuntimeSpec 的工具 Schema 与冻结 Revision 不一致");
				const serverBindings = legacyBindings.filter(
					(binding) => internalServerId(binding.mcpServerId) === internalId,
				);
				const toolCredentials = new Set(
					serverBindings.filter((binding) => binding.credentialId !== "connection").map((binding) => binding.credentialId),
				);
				if (toolCredentials.size > 1)
					throw new Error("旧逐工具凭据无法无损转换为每 Server 一份 tool_credential，需人工处理");
				const batches = toSensitiveRuleBatches(server.mcpServerId, serverBindings);
				const rules = expandSensitiveRules(server.mcpServerId, batches);
				const equivalent = await equivalentSourceRevision({
					repos,
					tenantId,
					dryRun,
					serverId: server.mcpServerId,
					source: server,
					rules,
				});
				revisions.push({ server_id: server.mcpServerId, revision: equivalent.revision, created: equivalent.created });
				mcpServers.push({
					server_id: server.mcpServerId,
					revision: equivalent.revision,
					authentication: server.authentication,
					tool_allowlist: server.tools.map((tool) => tool.name),
				});
				toolsMapped += server.tools.length;
			}
			const direct: DirectCapabilities = {
				model: {
					provider: spec.agent.model.provider,
					model_id: spec.agent.model.modelId,
					parameters,
				},
				mcp_servers: mcpServers,
				skills: spec.capabilities.skills.map((skill) => ({
					skill_id: skill.skillId,
					revision: skill.revision,
					artifact_hash: skill.sourceHash,
				})),
				execution_policy: {
					max_pending_operations: 4,
					queue_timeout_ms: 3_600_000,
					credential_max_ms: 1_800_000,
				},
			};
			const targetRevision = key.revision + 1;
			if (!dryRun) {
				const updated = await client.run(
					`update aaas_api_keys set router_capability_scope=case when router_capability_scope='legacy' then 'dual' else router_capability_scope end,
						direct_capabilities=$4::jsonb,direct_capability_revision=$5,router_capability_updated_at=now(),updated_at=now()
					 where tenant_id=$1 and id=$2 and direct_capabilities is null and direct_capability_revision=$3 returning id`,
					tenantId,
					key.id,
					key.revision,
					direct as unknown as Record<string, unknown>,
					targetRevision,
				);
				if (updated.length !== 1) {
					pending.push({ key_id: key.id, reason: "CAS 回填冲突，Key 已被人工修改", source_version_id: source.versionId });
					continue;
				}
				await client.run(
					`insert into audit_events
					 (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
					 values ($1,$2,'platform_admin',$3,'aaas.key.router-migrated','aaas_api_key',$4,$5,$6::jsonb)`,
					randomUUID(),
					tenantId,
					tenantId,
					key.id,
					newRequestId(),
					{
						source_mode: source.mode,
						source_version_id: source.versionId,
						capability_revision: targetRevision,
						tools_mapped: toolsMapped,
					},
				);
			}
			keys.push({
				key_id: key.id,
				source_mode: source.mode,
				source_version_id: source.versionId,
				status: dryRun ? "skipped" : "migrated",
				capability_revision: targetRevision,
				reason: dryRun ? "预演：未写入" : null,
				tools_mapped: toolsMapped,
			});
		} catch (error) {
			const reasonText = error instanceof Error ? error.message : "迁移失败";
			pending.push({ key_id: key.id, reason: reasonText, source_version_id: source.versionId });
			keys.push({
				key_id: key.id,
				source_mode: source.mode,
				source_version_id: source.versionId,
				status: "pending",
				capability_revision: null,
				reason: reasonText,
				tools_mapped: 0,
			});
		}
	}

	return { dryRun, keys, revisions, pending };
}

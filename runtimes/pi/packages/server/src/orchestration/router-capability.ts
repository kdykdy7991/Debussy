import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { TenantId } from "../publishing/domain/ids.ts";
import { fromPublicId, newMcpToolId, newRequestId, parseId } from "../publishing/domain/ids.ts";
import type { McpToolRecord, PublishingRepositories } from "../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import type { ApiKeyPrincipal } from "./api-key-contracts.ts";
import { OrchestrationError } from "./contracts.ts";
import { modelToolSchema } from "./protected-tool.ts";
import type {
	DirectCapabilities,
	RouterCapabilityScope,
	RouterEffectiveCapabilities,
	RouterEffectiveServer,
	RouterCapabilitySnapshot,
	SensitiveBinding,
	SensitiveBindings,
	SensitiveRuleBatch,
} from "./router-capability-contracts.ts";
import {
	directCapabilitiesSchema,
	parseRouterCapabilitySnapshot,
	sensitiveBindingSchema,
} from "./router-capability-contracts.ts";

/** Router contracts use `mcp_<uuid>`; control repositories use the bare UUID. */
export function internalServerId(external: string): string {
	return external.startsWith("mcp_") ? external.slice(4) : external;
}

const capabilityError = (code: string, message: string) => new OrchestrationError(403, code, message);
const unavailable = () => capabilityError("CAPABILITY_UNAVAILABLE", "Router 直接能力未登记、引用失效或规则缺失");
const scopeRequired = () => capabilityError("CAPABILITY_SCOPE_REQUIRED", "双入口 Key 必须显式选择 Router 能力范围");

export function internalSkillId(id: string) {
	const parsed = fromPublicId("SkillId", id) ?? parseId("SkillId", id);
	if (!parsed) throw unavailable();
	return parsed;
}

/**
 * Scope is resolved once and shared by discovery and acceptance. An explicit
 * Router request never falls back to the legacy configuration chain.
 */
export function resolveCapabilityScope(
	keyScope: RouterCapabilityScope,
	header: string | undefined,
	selection?: { readonly scope: "router" },
): "router" | "legacy" {
	const explicitRouter = header === "router" || selection?.scope === "router";
	if (explicitRouter) {
		if (keyScope === "legacy") throw unavailable();
		return "router";
	}
	if (header === "legacy") {
		if (keyScope === "router") throw scopeRequired();
		return "legacy";
	}
	return keyScope === "router" ? "router" : "legacy";
}

/** Expand a batch rule to the exact tools named by the administrator. */
export function expandSensitiveRules(serverId: string, rules: readonly SensitiveRuleBatch[]): SensitiveBinding[] {
	const expanded: SensitiveBinding[] = [];
	const seenTools = new Set<string>();
	const canonical = `mcp_${internalServerId(serverId)}`;
	for (const rule of rules) {
		if (internalServerId(rule.mcpServerId) !== internalServerId(serverId))
			throw new OrchestrationError(422, "INVALID_BINDING", "敏感规则引用了其他 MCP Server");
		for (const toolName of rule.toolNames) {
			if (seenTools.has(`${toolName}\u0000${rule.parameter}`))
				throw new OrchestrationError(422, "INVALID_BINDING", "敏感规则参数重复");
			seenTools.add(`${toolName}\u0000${rule.parameter}`);
			expanded.push({
				mcpServerId: canonical,
				toolName,
				parameter: rule.parameter,
				credentialId: rule.credentialId,
			});
		}
	}
	return expanded;
}

/**
 * Validate a frozen rule set against one Revision's tools. NULL means rules
 * were never registered and is never authorizable; [] is a reviewed empty set.
 */
export function validateSensitiveBindings(
	serverId: string,
	tools: readonly Pick<McpToolRecord, "name" | "inputSchema">[],
	bindings: SensitiveBindings,
): readonly SensitiveBinding[] {
	if (bindings === null || bindings === undefined) throw unavailable();
	const result: SensitiveBinding[] = [];
	const seen = new Set<string>();
	for (const value of bindings) {
		const parsedBinding = sensitiveBindingSchema.parse(value);
		if (internalServerId(parsedBinding.mcpServerId) !== internalServerId(serverId))
			throw new OrchestrationError(422, "INVALID_BINDING", "敏感规则引用了其他 MCP Server");
		const binding = { ...parsedBinding, mcpServerId: `mcp_${internalServerId(serverId)}` };
		const tool = tools.find((entry) => entry.name === binding.toolName);
		if (!tool) throw new OrchestrationError(422, "INVALID_BINDING", "敏感规则指向不存在的工具");
		const field = (tool.inputSchema as { properties?: Record<string, unknown> }).properties?.[binding.parameter] as
			| { type?: unknown }
			| undefined;
		if (field === undefined || field === null || typeof field !== "object" || field.type !== "string")
			throw new OrchestrationError(422, "INVALID_BINDING", "敏感参数不是该 Revision 下的顶层字符串参数");
		const key = `${binding.toolName}\u0000${binding.parameter}`;
		if (seen.has(key)) throw new OrchestrationError(422, "INVALID_BINDING", "敏感规则参数重复");
		seen.add(key);
		result.push(binding);
	}
	const byTool = new Map<string, SensitiveBinding[]>();
	for (const binding of result) {
		const list = byTool.get(binding.toolName) ?? [];
		list.push(binding);
		byTool.set(binding.toolName, list);
	}
	for (const [toolName, list] of byTool) {
		const tool = tools.find((entry) => entry.name === toolName)!;
		modelToolSchema(
			tool.inputSchema,
			list.map((binding) => ({
				mcpServerId: binding.mcpServerId,
				toolName: binding.toolName,
				parameter: binding.parameter,
				credential: binding.credentialId,
			})),
		);
	}
	return result;
}

/** Only rules whose tool and parameter still exist survive a Schema sync. */
export function inheritSensitiveBindings(
	previous: readonly McpToolRecord[],
	next: readonly Omit<McpToolRecord, "mcpRevision">[],
): readonly (Omit<McpToolRecord, "mcpRevision"> & { sensitiveBindings: SensitiveBindings })[] {
	return next.map((tool) => {
		const old = previous.find(
			(entry) =>
				entry.name === tool.name &&
				entry.inputSchemaHash === tool.inputSchemaHash &&
				entry.description === tool.description,
		);
		return {
			...tool,
			// A new or changed tool has no reviewed rules until an administrator
			// publishes them; it cannot be authorized by a Router Key meanwhile.
			sensitiveBindings: old ? (old.sensitiveBindings ?? null) : null,
		};
	});
}

async function readKeyRow(
	client: PostgresClient | TransactionSql,
	tenantId: string,
	keyId: string,
	forUpdate = false,
): Promise<Record<string, unknown>> {
	const query = `select id,router_capability_scope,direct_capabilities,direct_capability_revision,status
		from aaas_api_keys where tenant_id=$1 and id=$2${forUpdate ? " for update" : ""}`;
	const rows =
		typeof client === "function"
			? await txRows(client as TransactionSql, query, tenantId, keyId)
			: await (client as PostgresClient).run(query, tenantId, keyId);
	const row = rows[0];
	if (!row) throw new OrchestrationError(404, "NOT_FOUND", "Key 不存在或不可访问");
	return row;
}

/** Validate and atomically save a Key's direct capabilities with expected-revision CAS. */
export async function saveDirectCapabilities(options: {
	readonly client: PostgresClient;
	readonly repos: PublishingRepositories;
	readonly tenantId: string;
	readonly keyId: string;
	readonly expectedRevision: number;
	/** Internal provisioning may specify scope. Admin edits preserve it, or enable dual entry. */
	readonly scope?: RouterCapabilityScope;
	readonly capabilities: unknown;
	readonly requestId?: string;
}): Promise<{ readonly capabilityRevision: number; readonly scope: "router" | "dual" }> {
	const { client, repos, tenantId, keyId, expectedRevision } = options;
	const requestedScope = options.scope;
	if (requestedScope === "legacy")
		throw new OrchestrationError(422, "INVALID_CAPABILITY_SCOPE", "直接能力仅适用于 router 或 dual Key");
	if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
		throw new OrchestrationError(422, "INVALID_REVISION", "expected capability revision 无效");
	const capabilities = directCapabilitiesSchema.parse(options.capabilities) as DirectCapabilities;
	if (capabilities.local_tools?.includes("bash") && capabilities.mcp_servers.some((server) => server.tool_allowlist.includes("bash"))) {
		throw new OrchestrationError(422, "INVALID_CAPABILITY", "本地 Bash 与同名 MCP 工具不能同时授权");
	}
	return client.transaction(async (tx) => {
		const key = await readKeyRow(tx, tenantId, keyId, true);
		if (key.status === "revoked") throw new OrchestrationError(409, "KEY_REVOKED", "Key 已撤销");
		if (Number(key.direct_capability_revision) !== expectedRevision)
			throw new OrchestrationError(409, "CAPABILITY_REVISION_CONFLICT", "能力修订已更新，请重新加载");
		const scope = requestedScope ?? (key.router_capability_scope === "router" ? "router" : "dual");
		const seenServers = new Set<string>();
		for (const server of capabilities.mcp_servers) {
			if (seenServers.has(server.server_id))
				throw new OrchestrationError(422, "INVALID_CAPABILITY", "MCP Server 重复");
			seenServers.add(server.server_id);
			const internalId = internalServerId(server.server_id);
			const record = await repos.mcpServers.get({ tenantId: tenantId as TenantId }, internalId as never, tx);
			if (!record || record.status !== "enabled") throw unavailable();
			const revision = await repos.mcpServers.getRevision({ tenantId: tenantId as TenantId }, internalId as never, server.revision, tx);
			if (!revision || revision.authentication !== server.authentication) throw unavailable();
			const tools = await repos.mcpServers.listTools({ tenantId: tenantId as TenantId }, internalId as never, server.revision, tx);
			const allowed = new Set(server.tool_allowlist);
			for (const name of allowed) if (!tools.some((tool) => tool.name === name)) throw unavailable();
			if (revision.sensitiveBindings == null)
				throw capabilityError(
					"CAPABILITY_UNAVAILABLE",
					`MCP「${record.name}」v${revision.revision} 尚未审核敏感参数规则。请在 MCP 管理发布规则，再选择新修订；仅使用模型时可移除此服务。`,
				);
			validateSensitiveBindings(server.server_id, tools, revision.sensitiveBindings);
			for (const tool of tools.filter((entry) => allowed.has(entry.name))) {
				if (tool.sensitiveBindings == null)
					throw capabilityError(
						"CAPABILITY_UNAVAILABLE",
						`MCP「${record.name}」v${revision.revision} 的工具「${tool.name}」尚未审核敏感参数规则。请在 MCP 管理发布规则后选择新修订，或取消勾选该工具。`,
					);
				validateSensitiveBindings(server.server_id, tools, tool.sensitiveBindings);
			}
		}
		for (const skill of capabilities.skills) {
			const revision = await repos.skills.getRevision({ tenantId: tenantId as TenantId }, internalSkillId(skill.skill_id), skill.revision, tx);
			if (!revision || revision.sourceHash !== skill.artifact_hash) throw unavailable();
		}
		const update = await txRows(tx,
			`update aaas_api_keys set router_capability_scope=$3,direct_capabilities=$4::jsonb,
				direct_capability_revision=$5,router_capability_updated_at=now(),updated_at=now()
			 where tenant_id=$1 and id=$2 and direct_capability_revision=$6 returning id`,
			tenantId,
			keyId,
			scope,
			capabilities as unknown as Record<string, unknown>,
			expectedRevision + 1,
			expectedRevision,
		);
		if (update.length !== 1) throw new OrchestrationError(409, "CAPABILITY_REVISION_CONFLICT", "能力修订已被其他更新占用");
		await txRows(tx,
			`insert into audit_events
			 (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
			 values ($1,$2,'platform_admin',$3,'aaas.key.direct-capability.updated','aaas_api_key',$4,$5,$6::jsonb)`,
			randomUUID(),
			tenantId,
			tenantId,
			keyId,
			options.requestId ?? newRequestId(),
			{ capability_revision: expectedRevision + 1, capability_scope: scope },
		);
		return { capabilityRevision: expectedRevision + 1, scope };
	});
}

/** Resolve legacy configuration capabilities. This path is unchanged for old /runs. */
async function resolveLegacyCapabilities(options: {
	readonly client: PostgresClient;
	readonly tenantId: string;
	readonly principal: Pick<ApiKeyPrincipal, "keyId">;
	readonly selected?: readonly string[] | undefined;
	readonly tx?: TransactionSql;
}): Promise<RouterEffectiveCapabilities> {
	const query = `select v.configuration_id,v.id as orchestration_version_id,b.credential_bindings,
			v.runtime_spec,v.runtime_spec_hash from aaas_api_keys k
		left join aaas_platform_configuration p on p.tenant_id=k.tenant_id and p.enabled=true
		left join orchestration_configurations kc on kc.tenant_id=k.tenant_id and kc.id=k.orchestration_configuration_id and kc.enabled=true
		left join orchestration_configurations pc on pc.tenant_id=k.tenant_id and pc.id=p.configuration_id and pc.enabled=true
		join orchestration_versions v on v.tenant_id=k.tenant_id and v.id=coalesce(
			k.orchestration_version_id,kc.active_version_id,pc.active_version_id,p.orchestration_version_id)
		join orchestration_configurations c on c.tenant_id=v.tenant_id and c.id=v.configuration_id and c.enabled=true
		left join aaas_version_credential_bindings b on b.tenant_id=v.tenant_id and b.orchestration_version_id=v.id
		where k.tenant_id=$1 and k.id=$2`;
	const rows = options.tx
		? await txRows(options.tx, query, options.tenantId, options.principal.keyId)
		: await options.client.run(query, options.tenantId, options.principal.keyId);
	const row = rows[0];
	if (!row || !Array.isArray(row.credential_bindings)) throw unavailable();
	const parsed = parseRuntimeSpec(row.runtime_spec);
	if (!parsed.ok || String(row.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec))) throw unavailable();
	const bindings: SensitiveBinding[] = (row.credential_bindings as Record<string, unknown>[]).map((value) => ({
		mcpServerId: String(value.mcpServerId),
		toolName: String(value.toolName),
		parameter: String(value.parameter),
		credentialId: String(value.credentialId),
	}));
	const servers: RouterEffectiveServer[] = parsed.spec.capabilities.mcpServers.map((server) => {
		const toolBindings = bindings.filter((binding) => binding.mcpServerId === server.mcpServerId);
		return {
			serverId: server.mcpServerId,
			revision: server.revision,
			authentication: server.authentication,
			sensitiveBindings: toolBindings,
			tools: server.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				inputSchemaHash: tool.inputSchemaHash,
				sensitiveBindings: toolBindings.filter((binding) => binding.toolName === tool.name),
			})),
		};
	});
	const effective = options.selected === undefined ? servers : servers.filter((server) => options.selected!.includes(server.serverId));
	if (options.selected !== undefined && effective.length !== new Set(options.selected).size) throw unavailable();
	return {
		source: "legacy",
		capabilityRevision: 1,
		configurationId: String(row.configuration_id),
		orchestrationVersionId: String(row.orchestration_version_id),
		model: {
			provider: parsed.spec.agent.model.provider,
			modelId: parsed.spec.agent.model.modelId,
			parameters: {},
		},
		executionPolicy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
		servers: effective,
		skills: [],
	};
}

/**
 * The single effective-capability resolver used by MCP discovery and, from
 * phase four, by Router acceptance. `scope` must already be resolved from the
 * Key scope and the explicit capability selection header/body.
 */
export async function resolveEffectiveCapabilities(options: {
	readonly client: PostgresClient;
	readonly repos: PublishingRepositories;
	readonly tenantId: string;
	readonly principal: Pick<ApiKeyPrincipal, "keyId">;
	readonly scope: "router" | "legacy";
	readonly selected?: readonly string[] | undefined;
	readonly expectedRevision?: number | undefined;
	readonly tx?: TransactionSql;
}): Promise<RouterEffectiveCapabilities> {
	if (options.scope === "legacy") return resolveLegacyCapabilities(options);
	const row = await readKeyRow(options.tx ?? options.client, options.tenantId, options.principal.keyId);
	if (row.router_capability_scope !== "router" && row.router_capability_scope !== "dual") throw unavailable();
	if (row.direct_capabilities === null || row.direct_capabilities === undefined) throw unavailable();
	const revision = Number(row.direct_capability_revision);
	if (!Number.isInteger(revision) || revision < 1) throw unavailable();
	if (options.expectedRevision !== undefined && options.expectedRevision !== revision) throw unavailable();
	const parsed = directCapabilitiesSchema.safeParse(row.direct_capabilities);
	if (!parsed.success) throw unavailable();
	const direct = parsed.data;
	const scope = { tenantId: options.tenantId as TenantId };
	const servers: RouterEffectiveServer[] = [];
	for (const entry of direct.mcp_servers) {
		const selected = options.selected === undefined ? true : options.selected.includes(entry.server_id);
		if (!selected) continue;
		const internalId = internalServerId(entry.server_id);
		const record = await options.repos.mcpServers.get(scope, internalId as never, options.tx);
		if (!record || record.status !== "enabled") throw unavailable();
		const frozen = await options.repos.mcpServers.getRevision(scope, internalId as never, entry.revision, options.tx);
		if (!frozen || frozen.authentication !== entry.authentication) throw unavailable();
		const tools = await options.repos.mcpServers.listTools(scope, internalId as never, entry.revision, options.tx);
		// Validate the whole frozen Revision first: a rule may target a tool the
		// Key does not authorize, but it must still be a real tool in this Revision.
		const revisionBindings =
			frozen.sensitiveBindings == null ? [] : validateSensitiveBindings(entry.server_id, tools, frozen.sensitiveBindings);
		for (const tool of tools)
			if (tool.sensitiveBindings != null) validateSensitiveBindings(entry.server_id, tools, tool.sensitiveBindings);
		const allowlist = new Set(entry.tool_allowlist);
		for (const name of allowlist) if (!tools.some((tool) => tool.name === name)) throw unavailable();
		const matched = tools.filter((tool) => allowlist.has(tool.name));
		// Only authorized tools need reviewed rule registration; NULL is
		// "unregistered" and distinct from an explicit empty array.
		for (const tool of matched) if (tool.sensitiveBindings == null) throw unavailable();
		const bindings = revisionBindings.filter((binding) => allowlist.has(binding.toolName));
		servers.push({
			serverId: entry.server_id,
			revision: entry.revision,
			authentication: entry.authentication,
			sensitiveBindings: bindings,
			tools: matched.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				inputSchemaHash: tool.inputSchemaHash,
				sensitiveBindings: tool.sensitiveBindings ?? [],
			})),
		});
	}
	if (options.selected !== undefined && servers.length !== new Set(options.selected).size) throw unavailable();
	const skills: RouterEffectiveCapabilities["skills"][number][] = [];
	for (const entry of direct.skills) {
		const revision = await options.repos.skills.getRevision(scope, internalSkillId(entry.skill_id), entry.revision, options.tx);
		if (!revision || revision.sourceHash !== entry.artifact_hash) throw unavailable();
		skills.push({ ...entry, sourceHash: revision.sourceHash });
	}
	return {
		source: "router",
		capabilityRevision: revision,
		configurationId: null,
		orchestrationVersionId: null,
		model: {
			provider: direct.model.provider,
			modelId: direct.model.model_id,
			parameters: direct.model.parameters as Record<string, unknown>,
		},
		executionPolicy: direct.execution_policy,
		...(direct.local_tools?.length ? { localTools: direct.local_tools } : {}),
		servers,
		skills,
	};
}

/** Build a deterministic, credential-free snapshot from one resolution result. */
export function buildRouterCapabilitySnapshot(options: {
	readonly keyId: string;
	readonly effective: RouterEffectiveCapabilities;
}): { readonly snapshot: RouterCapabilitySnapshot; readonly digest: string } {
	const { effective } = options;
	const snapshot: RouterCapabilitySnapshot = {
		version: 2,
		keyId: options.keyId,
		capabilityRevision: effective.capabilityRevision,
		source: effective.source,
		model: effective.model,
		executionPolicy: effective.executionPolicy,
		configurationId: effective.configurationId,
		orchestrationVersionId: effective.orchestrationVersionId,
		...(effective.localTools?.length ? { localTools: effective.localTools } : {}),
		servers: effective.servers.map((server) => ({
			serverId: server.serverId,
			revision: server.revision,
			authentication: server.authentication,
			toolAllowlist: server.tools.map((tool) => tool.name),
			sensitiveBindings: server.sensitiveBindings.map((binding) => ({ ...binding })),
			tools: server.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: structuredClone(tool.inputSchema),
				inputSchemaHash: tool.inputSchemaHash,
				sensitiveBindings: tool.sensitiveBindings.map((binding) => ({ ...binding })),
			})),
		})),
		skills: effective.skills.map((skill) => ({ ...skill })),
	};
	return { snapshot, digest: sha256Hex(canonicalJson(snapshot)) };
}

/** Verify a stored snapshot against its digest before any execution consumes it. */
export function verifyRouterCapabilitySnapshot(raw: unknown, expectedDigest: string): RouterCapabilitySnapshot {
	const snapshot = parseRouterCapabilitySnapshot(raw);
	if (!snapshot || typeof expectedDigest !== "string" || sha256Hex(canonicalJson(snapshot)) !== expectedDigest)
		throw new OrchestrationError(409, "INVALID_CAPABILITY_SNAPSHOT", "能力快照摘要或格式不一致");
	return snapshot;
}

function bindingsEqual(a: readonly SensitiveBinding[], b: SensitiveBindings): boolean {
	return canonicalJson([...a].sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y)))) ===
		canonicalJson(b == null ? null : [...b].sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y))));
}

/**
 * Publish reviewed sensitive rules by freezing a new MCP Revision. An equivalent
 * Revision is reused (migration re-runs never publish duplicates). Rules are
 * expanded to the exact tool set before being stored at both revision and tool
 * level, so older Revisions remain independently interpretable.
 */
export async function publishMcpSensitiveRules(options: {
	readonly client?: PostgresClient;
	readonly repos: PublishingRepositories;
	readonly tenantId: string;
	readonly mcpServerId: string;
	readonly rules: readonly SensitiveRuleBatch[];
	readonly expectedRevision?: number;
	readonly reuseEquivalent?: boolean;
}): Promise<{ readonly revision: number; readonly created: boolean; readonly sensitiveBindings: readonly SensitiveBinding[] }> {
	const { client, repos, tenantId, mcpServerId } = options;
	const scope = { tenantId: tenantId as TenantId };
	const internalId = internalServerId(mcpServerId);
	const server = await repos.mcpServers.get(scope, internalId as never);
	if (!server) throw unavailable();
	const current = await repos.mcpServers.getRevision(scope, internalId as never, server.currentRevision);
	if (!current) throw unavailable();
	if (options.expectedRevision !== undefined && options.expectedRevision !== server.currentRevision)
		throw new OrchestrationError(409, "CAPABILITY_REVISION_CONFLICT", "MCP Revision 已被其他更新占用");
	const tools = await repos.mcpServers.listTools(scope, internalId as never, current.revision);
	const expanded = expandSensitiveRules(mcpServerId, options.rules);
	validateSensitiveBindings(mcpServerId, tools, expanded);
	const config = {
		mcpServerId: current.mcpServerId,
		tenantId: current.tenantId,
		transport: current.transport,
		endpoint: current.endpoint,
		authentication: current.authentication,
		createdAt: new Date(),
	};
	if (options.reuseEquivalent !== false) {
		const revisions = await repos.mcpServers.listRevisions(scope, internalId as never);
		for (const candidate of revisions) {
			const candidateTools = await repos.mcpServers.listTools(scope, internalId as never, candidate.revision);
			if (
				candidate.endpoint === current.endpoint &&
				candidate.authentication === current.authentication &&
				candidateTools.length === tools.length &&
				candidateTools.every((tool) =>
					tools.some(
						(next) =>
							next.name === tool.name &&
							next.inputSchemaHash === tool.inputSchemaHash &&
							next.description === tool.description,
					),
				) &&
				bindingsEqual(expanded, candidate.sensitiveBindings)
			)
				return { revision: candidate.revision, created: false, sensitiveBindings: expanded };
		}
	}
	const nextTools = tools.map((tool) => ({
		...tool,
		mcpToolId: newMcpToolId(),
		sensitiveBindings: expanded.filter((binding) => binding.toolName === tool.name) as SensitiveBindings,
	}));
	const created = await repos.mcpServers.addRevision({
		scope,
		mcpServerId: internalId as never,
		expectedRevision: current.revision,
		revision: { ...config, sensitiveBindings: expanded },
		tools: nextTools,
	});
	if (!created) throw new OrchestrationError(409, "CAPABILITY_REVISION_CONFLICT", "MCP Revision 并发更新失败，请重试");
	if (client) {
		await client.run(
			`insert into audit_events
			 (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
			 values ($1,$2,'platform_admin',$3,'mcp-server.sensitive-rules-published','mcp_server',$4,$5,$6::jsonb)`,
			randomUUID(),
			tenantId,
			tenantId,
			mcpServerId,
			newRequestId(),
			{ revision: created.revision, rules: options.rules.length },
		);
	}
	return { revision: created.revision, created: true, sensitiveBindings: expanded };
}

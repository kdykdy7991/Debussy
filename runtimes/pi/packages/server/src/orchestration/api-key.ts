import { hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { API_KEY_TOKEN_PATTERN, type ApiKeyPrincipal, type ApiKeyStatus } from "./api-key-contracts.ts";
import { OrchestrationError, type OrchestrationSettings } from "./contracts.ts";
import { credentialHash, WorkCredentialBox } from "./credentials.ts";
import { modelToolSchema } from "./protected-tool.ts";

export type ApiKeyConfigurationMode = "platform" | "configuration" | "version";

export async function legacyConfigurationWritable(client: PostgresClient, tenantId: string, tx?: TransactionSql): Promise<boolean> {
	const sql = `select not exists (select 1 from aaas_api_keys k where k.tenant_id=$1 and to_jsonb(k)->>'router_capability_scope'='router')
		or exists (select 1 from aaas_api_keys k where k.tenant_id=$1 and k.status<>'revoked'
		and coalesce(to_jsonb(k)->>'router_capability_scope','legacy') in ('legacy','dual')) as writable`;
	const [row] = tx ? await txRows(tx, sql, tenantId) : await client.run(sql, tenantId);
	return row.writable === true;
}

export interface ApiKeyRecord {
	readonly keyId: string;
	readonly name: string;
	readonly status: ApiKeyStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Legacy fixed Version ID binding, preserved until explicitly converted. */
	readonly orchestrationVersionId: string | null;
	/** Followed configuration; its active version is resolved at Run acceptance. */
	readonly orchestrationConfigurationId: string | null;
	/** Resolved from the two fields above: version=fixed, configuration=follow named, platform=default. */
	readonly configurationMode: ApiKeyConfigurationMode;
	/** Read-only admin view: the effective version/configuration actually used by new Runs. */
	readonly effectiveVersionId?: string | null;
	readonly effectiveConfigurationId?: string | null;
	readonly effectiveConfigurationName?: string | null;
	readonly effectiveToolCount?: number;
	readonly effectiveUnavailable?: boolean;
	/** Router V1 phase three: direct capability scope and monotonic revision. */
	readonly routerCapabilityScope?: "legacy" | "dual" | "router";
	readonly directCapabilityRevision?: number;
}

export interface PlatformConfigurationBinding {
	readonly configurationId: string;
	readonly orchestrationVersionId: string;
	readonly modelId: string;
}

/** Platform-registered Tool parameter binding; callers cannot choose the parameter name. */
export interface PlatformBinding {
	readonly mcpServerId: string;
	readonly toolName: string;
	readonly parameter: string;
	readonly credentialId: string;
}

/**
 * A platform mapping may only name a Server/Tool/parameter that the bound version
 * really exposes, and only a supported top-level string parameter. Rejecting here
 * keeps unsupported schemas and dangling mappings out of every later Run.
 */
export function validatePlatformBindings(spec: RuntimeSpec, bindings: readonly PlatformBinding[]): void {
	const seen = new Set<string>();
	for (const binding of bindings) {
		const server = spec.capabilities.mcpServers.find((entry) => entry.mcpServerId === binding.mcpServerId);
		if (server === undefined)
			throw new OrchestrationError(422, "INVALID_BINDING", "凭据映射引用了不存在的 MCP Server");
		const tool = server.tools.find((entry) => entry.name === binding.toolName);
		if (tool === undefined) throw new OrchestrationError(422, "INVALID_BINDING", "凭据映射引用了不存在的 MCP Tool");
		const schema = tool.inputSchema as { properties?: Record<string, unknown> };
		const field = schema.properties?.[binding.parameter] as { type?: unknown } | undefined;
		if (field === undefined || field === null || typeof field !== "object" || field.type !== "string")
			throw new OrchestrationError(422, "INVALID_BINDING", "凭据映射参数缺失或不是顶层字符串");
		const key = `${binding.mcpServerId}\u0000${binding.toolName}\u0000${binding.parameter}`;
		if (seen.has(key)) throw new OrchestrationError(422, "INVALID_BINDING", "凭据映射参数重复");
		seen.add(key);
	}
	for (const server of spec.capabilities.mcpServers) {
		for (const tool of server.tools) {
			const toolBindings = bindings.filter(
				(binding) => binding.mcpServerId === server.mcpServerId && binding.toolName === tool.name,
			);
			if (toolBindings.length === 0) continue;
			modelToolSchema(
				tool.inputSchema,
				toolBindings.map((binding) => ({
					mcpServerId: binding.mcpServerId,
					toolName: binding.toolName,
					parameter: binding.parameter,
					credential: binding.credentialId,
				})),
			);
		}
	}
}

function rowToKey(row: Record<string, unknown>): ApiKeyRecord {
	return {
		keyId: String(row.id),
		name: String(row.name),
		status: String(row.status) as ApiKeyStatus,
		createdAt: (row.created_at as Date).toISOString(),
		updatedAt: (row.updated_at as Date).toISOString(),
		orchestrationVersionId: row.orchestration_version_id == null ? null : String(row.orchestration_version_id),
		orchestrationConfigurationId: row.orchestration_configuration_id == null ? null : String(row.orchestration_configuration_id),
		configurationMode:
			row.orchestration_version_id != null
				? "version"
				: row.orchestration_configuration_id != null
					? "configuration"
					: "platform",
		...(row.router_capability_scope !== undefined
			? {
					routerCapabilityScope: String(row.router_capability_scope) as "legacy" | "dual" | "router",
					directCapabilityRevision: Number(row.direct_capability_revision ?? 0),
				}
			: {}),
	};
}

const unavailable = () => new OrchestrationError(403, "CONFIGURATION_UNAVAILABLE", "平台执行配置不可用");
const notFound = () => new OrchestrationError(404, "NOT_FOUND", "Key 不存在或不可访问");

/**
 * The independent API Key is the only external identity and ownership boundary.
 * Each Key owns exactly one non-login internal Integration carrier; the carrier
 * is an execution adapter, never a business-visible resource or a permission rule.
 */
export class ApiKeyStore {
	private readonly client: PostgresClient;
	private readonly tenantId: string;
	private readonly secretBox: WorkCredentialBox;

	constructor(client: PostgresClient, tenantId: string, masterKey: Uint8Array) {
		this.client = client;
		this.tenantId = tenantId;
		if (masterKey.length !== 32) throw new Error("AaaS Key encryption requires a 32-byte master key");
		this.secretBox = new WorkCredentialBox(
			Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "debussy:aaas:recoverable-api-key:v1", 32)),
		);
	}

	/** Constant-time authentication. A revoked/disabled Key and an old rotated secret are all 401. */
	async authenticate(header: string | undefined): Promise<ApiKeyPrincipal> {
		const match = API_KEY_TOKEN_PATTERN.exec(header ?? "");
		if (!match) throw new OrchestrationError(401, "UNAUTHORIZED", "API Key 无效");
		const rows = await this.client.run(
			`select k.id,k.status,k.secret_hash,c.carrier_integration_id from aaas_api_keys k
			 left join aaas_key_carriers c on c.key_id=k.id and c.tenant_id=k.tenant_id
			 where k.tenant_id=$1 and k.id=$2`,
			this.tenantId,
			match[1],
		);
		const row = rows[0];
		const expected = Buffer.from(String(row?.secret_hash ?? "0".repeat(64)), "hex");
		const actual = Buffer.from(credentialHash(match[2]!), "hex");
		const valid = expected.length === 32 && timingSafeEqual(expected, actual);
		if (!valid || row?.status !== "enabled") throw new OrchestrationError(401, "UNAUTHORIZED", "API Key 无效");
		return {
			kind: "apiKey",
			tenantId: this.tenantId,
			keyId: String(row.id),
			carrierIntegrationId: row.carrier_integration_id == null ? null : String(row.carrier_integration_id),
			secretHash: String(row.secret_hash),
		};
	}

	/** Legacy write access follows the remaining non-revoked compatibility Keys. */
	async legacyConfigurationWritable(): Promise<boolean> {
		return legacyConfigurationWritable(this.client, this.tenantId);
	}

	async assertLegacyConfigurationWritable(): Promise<void> {
		if (!(await this.legacyConfigurationWritable()))
			throw new OrchestrationError(409, "LEGACY_CONFIGURATION_RETIRED", "旧 AaaS 执行配置已进入只读状态");
	}

	/** Administrator binds an already-published platform configuration/version. */
	async setPlatformConfiguration(
		configurationId: string,
		orchestrationVersionId: string,
		credentialBindings?: readonly Record<string, unknown>[],
	): Promise<void> {
		const rows = await this.client.run(
			`select runtime_spec,runtime_spec_hash from orchestration_versions
			 where tenant_id=$1 and id=$2 and configuration_id=$3`,
			this.tenantId,
			orchestrationVersionId,
			configurationId,
		);
		const row = rows[0];
		if (row === undefined) throw new OrchestrationError(422, "INVALID_VERSION", "平台执行配置版本不存在");
		const parsed = parseRuntimeSpec(row.runtime_spec);
		if (!parsed.ok) throw new OrchestrationError(422, "INVALID_VERSION", "平台执行配置版本无效");
		if (String(row.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec)))
			throw new OrchestrationError(422, "INVALID_VERSION", "平台执行配置版本摘要不一致");
		if (credentialBindings !== undefined) await this.setVersionBindings(orchestrationVersionId, credentialBindings as unknown as readonly PlatformBinding[]);
		const registered = await this.versionBindings(orchestrationVersionId);
		if (registered === null) throw new OrchestrationError(422, "BINDING_UNREGISTERED", "请先登记版本凭据映射");
		validatePlatformBindings(parsed.spec, registered);
		await this.client.run(
			`insert into aaas_platform_configuration(tenant_id,configuration_id,orchestration_version_id,credential_bindings)
			 values ($1,$2,$3,$4::jsonb)
			 on conflict (tenant_id) do update set configuration_id=excluded.configuration_id,
			 orchestration_version_id=excluded.orchestration_version_id,
			 credential_bindings=excluded.credential_bindings,enabled=true,updated_at=now()`,
			this.tenantId,
			configurationId,
			orchestrationVersionId,
			registered as unknown as Record<string, unknown>,
		);
	}

	/** Platform-owned published configuration shared by every carrier. */
	async platformConfiguration(tx?: TransactionSql): Promise<PlatformConfigurationBinding> {
		const query = `select p.configuration_id,p.orchestration_version_id,v.snapshot
			from aaas_platform_configuration p join orchestration_versions v
			on v.tenant_id=p.tenant_id and v.id=p.orchestration_version_id and v.configuration_id=p.configuration_id
			where p.tenant_id=$1 and p.enabled=true`;
		const rows = tx ? await txRows(tx, query, this.tenantId) : await this.client.run(query, this.tenantId);
		const row = rows[0];
		if (!row) throw unavailable();
		const snapshot = row.snapshot as { modelId?: unknown };
		if (typeof snapshot?.modelId !== "string" || snapshot.modelId.length === 0) throw unavailable();
		return {
			configurationId: String(row.configuration_id),
			orchestrationVersionId: String(row.orchestration_version_id),
			modelId: snapshot.modelId,
		};
	}

	/** Administrator view contains configuration identifiers and mapping names only. */
	async platformConfigurationView(): Promise<Record<string, unknown> | null> {
		const [row] = await this.client.run(
			"select configuration_id,orchestration_version_id,credential_bindings,enabled from aaas_platform_configuration where tenant_id=$1",
			this.tenantId,
		);
		if (!row) return null;
		return {
			configuration_id: String(row.configuration_id),
			orchestration_version_id: String(row.orchestration_version_id),
			credential_bindings: Array.isArray(row.credential_bindings)
				? row.credential_bindings.map((entry: PlatformBinding) => ({
						mcpServerId: entry.mcpServerId,
						toolName: entry.toolName,
						parameter: entry.parameter,
						credentialId: entry.credentialId,
					}))
				: [],
			enabled: row.enabled === true,
		};
	}

	/** Published orchestration versions, limited to non-sensitive selection metadata. */
	async platformConfigurationVersions(includeDisabled = false): Promise<readonly Record<string, unknown>[]> {
		const rows = await this.client.run(
			`select c.id as configuration_id,c.name,v.id as version_id,v.source_draft_revision,
			 v.snapshot->>'modelId' as model_id,v.created_at
			 from orchestration_configurations c join orchestration_versions v
			 on v.tenant_id=c.tenant_id and v.configuration_id=c.id
			 where c.tenant_id=$1 and ($2::boolean or c.enabled=true) order by c.name,v.created_at desc,v.id desc`,
			this.tenantId,
			includeDisabled,
		);
		return rows.map((row) => ({
			configuration_id: String(row.configuration_id),
			name: String(row.name),
			orchestration_version_id: String(row.version_id),
			revision: Number(row.source_draft_revision),
			model_id: row.model_id == null ? null : String(row.model_id),
			created_at: (row.created_at as Date).toISOString(),
		}));
	}

	/** Named configurations with their effective version, for administrator selection. */
	async configurationChoices(): Promise<readonly Record<string, unknown>[]> {
		const rows = await this.client.run(
			`select c.id as configuration_id,c.name,c.active_version_id,
			 v.source_draft_revision as revision,v.snapshot->>'modelId' as model_id,
			 (select count(*) from jsonb_array_elements(
				case when jsonb_typeof(v.runtime_spec->'capabilities'->'mcpServers')='array'
				     then v.runtime_spec->'capabilities'->'mcpServers' else '[]'::jsonb end)) as mcp_count,
			 (select coalesce(sum(jsonb_array_length(s->'tools')),0) from jsonb_array_elements(
				case when jsonb_typeof(v.runtime_spec->'capabilities'->'mcpServers')='array'
				     then v.runtime_spec->'capabilities'->'mcpServers' else '[]'::jsonb end) s) as tool_count
			 from orchestration_configurations c
			 left join orchestration_versions v on v.tenant_id=c.tenant_id and v.id=c.active_version_id
			 where c.tenant_id=$1 and c.enabled=true order by c.name,c.id`,
			this.tenantId,
		);
		return rows.map((row) => ({
			configuration_id: String(row.configuration_id),
			name: String(row.name),
			orchestration_version_id: row.active_version_id == null ? null : String(row.active_version_id),
			revision: row.revision == null ? null : Number(row.revision),
			model_id: row.model_id == null ? null : String(row.model_id),
			mcp_count: Number(row.mcp_count ?? 0),
			tool_count: Number(row.tool_count ?? 0),
		}));
	}

	/** Register the reviewed sensitive-parameter mapping for one published version. */
	async setVersionBindings(versionId: string, bindings: readonly PlatformBinding[]): Promise<void> {
		const [row] = await this.client.run(
			`select v.runtime_spec,v.runtime_spec_hash from orchestration_versions v
			 join orchestration_configurations c on c.tenant_id=v.tenant_id and c.id=v.configuration_id
			 where v.tenant_id=$1 and v.id=$2 and c.enabled=true`,
			this.tenantId, versionId,
		);
		if (!row) throw new OrchestrationError(422, "INVALID_VERSION", "编排版本不存在或不可用");
		const parsed = parseRuntimeSpec(row.runtime_spec);
		if (!parsed.ok || String(row.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec)))
			throw new OrchestrationError(422, "INVALID_VERSION", "编排版本无效");
		validatePlatformBindings(parsed.spec, bindings);
		await this.client.run(
			`insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings)
			 values ($1,$2,$3::jsonb) on conflict (tenant_id,orchestration_version_id)
			 do nothing`,
			this.tenantId, versionId, bindings as unknown as Record<string, unknown>,
		);
		const [registered] = await this.client.run("select credential_bindings from aaas_version_credential_bindings where tenant_id=$1 and orchestration_version_id=$2", this.tenantId, versionId);
		if (!registered || canonicalJson(registered.credential_bindings) !== canonicalJson(bindings))
			throw new OrchestrationError(409, "BINDING_IMMUTABLE", "版本凭据映射已登记，请发布新版本");
	}

	async versionBindings(versionId: string): Promise<readonly PlatformBinding[] | null> {
		const [version] = await this.client.run("select 1 from orchestration_versions where tenant_id=$1 and id=$2", this.tenantId, versionId);
		if (!version) throw new OrchestrationError(404, "NOT_FOUND", "版本不存在或不可访问");
		const [row] = await this.client.run("select credential_bindings from aaas_version_credential_bindings where tenant_id=$1 and orchestration_version_id=$2", this.tenantId, versionId);
		return row ? row.credential_bindings as PlatformBinding[] : null;
	}

	/** Set how a Key associates with an execution configuration. Mutually exclusive by mode. */
	async setKeyConfiguration(
		id: string,
		mode: ApiKeyConfigurationMode,
		target: { versionId?: string | null; configurationId?: string | null } = {},
	): Promise<ApiKeyRecord> {
		await this.client.transaction(async (tx) => {
			const [key] = await txRows(tx, "select to_jsonb(k)->>'router_capability_scope' as scope from aaas_api_keys k where tenant_id=$1 and id=$2 for update", this.tenantId, id);
			if (!key) throw notFound();
			if (key.scope === "router") throw new OrchestrationError(409, "LEGACY_CONFIGURATION_RETIRED", "Router-only Key 的旧配置关联只读");
			let versionId: string | null = null;
			let configurationId: string | null = null;
			if (mode === "version") {
				versionId = target.versionId ?? null;
				if (versionId === null) throw new OrchestrationError(422, "INVALID_VERSION", "固定版本模式需要版本 ID");
				const [version] = await txRows(tx,
					`select v.runtime_spec,v.runtime_spec_hash from orchestration_versions v
					 join orchestration_configurations c on c.tenant_id=v.tenant_id and c.id=v.configuration_id
					 where v.tenant_id=$1 and v.id=$2 and c.enabled=true`, this.tenantId, versionId);
				if (!version) throw new OrchestrationError(422, "INVALID_VERSION", "编排版本不存在或不可用");
				const parsed = parseRuntimeSpec(version.runtime_spec);
				if (!parsed.ok || String(version.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec)))
					throw new OrchestrationError(422, "INVALID_VERSION", "编排版本无效");
			} else if (mode === "configuration") {
				configurationId = target.configurationId ?? null;
				if (configurationId === null) throw new OrchestrationError(422, "INVALID_VERSION", "指定配置模式需要配置 ID");
				const [config] = await txRows(tx,
					"select active_version_id from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
					this.tenantId, configurationId);
				if (!config || config.active_version_id == null)
					throw new OrchestrationError(422, "INVALID_VERSION", "编排配置不存在或没有生效版本");
			}
			await txRows(
				tx,
				"update aaas_api_keys set orchestration_version_id=$3,orchestration_configuration_id=$4,updated_at=now() where tenant_id=$1 and id=$2",
				this.tenantId, id, versionId, configurationId,
			);
		});
		const [row] = await this.client.run("select * from aaas_api_keys where tenant_id=$1 and id=$2", this.tenantId, id);
		return rowToKey(row!);
	}

	/** Backward-compatible fixed-version setter. */
	async setKeyVersion(id: string, versionId: string | null): Promise<void> {
		await this.setKeyConfiguration(id, versionId === null ? "platform" : "version", { versionId });
	}

	/** Issue a Key independently of the platform execution configuration. */
	async create(
		name: string,
		versionId: string | null = null,
		configurationId: string | null = null,
		routerOnly = false,
	): Promise<{ readonly record: ApiKeyRecord; readonly token: string }> {
		return this.client.transaction(async (tx) => {
			if (routerOnly && (versionId !== null || configurationId !== null))
				throw new OrchestrationError(422, "INVALID_VERSION", "Router-only Key 使用直接能力");
			if (versionId !== null && configurationId !== null)
				throw new OrchestrationError(422, "INVALID_VERSION", "固定版本与指定配置不可同时使用");
			if (versionId !== null) {
				const [version] = await txRows(tx, `select v.runtime_spec,v.runtime_spec_hash from orchestration_versions v join orchestration_configurations c on c.tenant_id=v.tenant_id and c.id=v.configuration_id where v.tenant_id=$1 and v.id=$2 and c.enabled=true`, this.tenantId, versionId);
				const parsed = version && parseRuntimeSpec(version.runtime_spec);
				if (!version || !parsed || !parsed.ok || String(version.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec)))
					throw new OrchestrationError(422, "INVALID_VERSION", "编排版本不存在或不可用");
			}
			if (configurationId !== null) {
				const [config] = await txRows(tx,
					"select active_version_id from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
					this.tenantId, configurationId);
				if (!config || config.active_version_id == null)
					throw new OrchestrationError(422, "INVALID_VERSION", "编排配置不存在或没有生效版本");
			}
			const keyId = randomUUID();
			const secret = randomBytes(32).toString("base64url");
			await txRows(
				tx,
				`insert into aaas_api_keys(id,tenant_id,name,secret_hash,status,sealed_secret,orchestration_version_id,orchestration_configuration_id)
				 values ($1,$2,$3,$4,'enabled',$5::jsonb,$6,$7)`,
				keyId,
				this.tenantId,
				name,
				credentialHash(secret),
				this.secretBox.sealValue(`aaas-key:${this.tenantId}:${keyId}`, secret),
				versionId,
				configurationId,
			);
			if (routerOnly) await txRows(tx, "update aaas_api_keys set router_capability_scope='router' where tenant_id=$1 and id=$2", this.tenantId, keyId);
			const [row] = await txRows(
				tx,
				"select * from aaas_api_keys where tenant_id=$1 and id=$2",
				this.tenantId,
				keyId,
			);
			return { record: rowToKey(row!), token: `ak_${keyId}.${secret}` };
		});
	}

	/** Called after the Key row is locked and new-Run validation succeeds. */
	async ensureCarrier(tx: TransactionSql, keyId: string, platform: PlatformConfigurationBinding): Promise<string> {
		const [existing] = await txRows(
			tx,
			"select carrier_integration_id from aaas_key_carriers where tenant_id=$1 and key_id=$2",
			this.tenantId,
			keyId,
		);
		if (existing) return String(existing.carrier_integration_id);
		const carrierId = randomUUID();
		const settings: OrchestrationSettings = {
			allowedModels: [platform.modelId],
			bindings: [],
			queueTimeoutMs: 3_600_000,
		};
		await txRows(
			tx,
			`insert into orchestration_integrations
			(id,tenant_id,name,secret_hash,settings,configuration_id,orchestration_version_id,kind,published_app_id,published_app_version_id)
			values ($1,$2,$3,$4,$5::jsonb,$6,$7,'internal_key_carrier',null,null)`,
			carrierId,
			this.tenantId,
			`AaaS Key carrier ${keyId}`,
			credentialHash(randomBytes(32).toString("base64url")),
			settings,
			platform.configurationId,
			platform.orchestrationVersionId,
		);
		await txRows(
			tx,
			"insert into aaas_key_carriers(tenant_id,key_id,carrier_integration_id) values ($1,$2,$3)",
			this.tenantId,
			keyId,
			carrierId,
		);
		return carrierId;
	}

	async list(): Promise<readonly ApiKeyRecord[]> {
		const rows = await this.client.run(
			"select * from aaas_api_keys where tenant_id=$1 order by created_at desc,id desc",
			this.tenantId,
		);
		return rows.map(rowToKey);
	}

	/** Admin view with the effective version, configuration name and frozen tool count per Key. */
	async listViews(): Promise<readonly ApiKeyRecord[]> {
		const rows = await this.client.run(
			`select k.*, v.id as effective_version_id, ec.id as effective_configuration_id,
				ec.name as effective_configuration_name,
				(select coalesce(sum(jsonb_array_length(s->'tools')),0) from jsonb_array_elements(
					case when jsonb_typeof(v.runtime_spec->'capabilities'->'mcpServers')='array'
					     then v.runtime_spec->'capabilities'->'mcpServers' else '[]'::jsonb end) s) as effective_tool_count
			 from aaas_api_keys k
			 left join aaas_platform_configuration p on p.tenant_id=k.tenant_id and p.enabled=true
			 left join orchestration_configurations kc on kc.tenant_id=k.tenant_id and kc.id=k.orchestration_configuration_id and kc.enabled=true
			 left join orchestration_configurations pc on pc.tenant_id=k.tenant_id and pc.id=p.configuration_id and pc.enabled=true
			 left join orchestration_versions v on v.tenant_id=k.tenant_id and v.id=coalesce(
				k.orchestration_version_id, kc.active_version_id, pc.active_version_id, p.orchestration_version_id)
			 left join orchestration_configurations ec on ec.tenant_id=k.tenant_id and ec.id=v.configuration_id
			 where k.tenant_id=$1 order by k.created_at desc,k.id desc`,
			this.tenantId,
		);
		return rows.map((row) => ({
			...rowToKey(row),
			effectiveVersionId: row.effective_version_id == null ? null : String(row.effective_version_id),
			effectiveConfigurationId: row.effective_configuration_id == null ? null : String(row.effective_configuration_id),
			effectiveConfigurationName: row.effective_configuration_name == null ? null : String(row.effective_configuration_name),
			effectiveToolCount: row.effective_version_id == null ? 0 : Number(row.effective_tool_count ?? 0),
			effectiveUnavailable: row.effective_version_id == null,
		}));
	}

	/** Admin-only caller; legacy hashes cannot be recovered and revoked secrets are never returned. */
	async reveal(id: string): Promise<string> {
		const [row] = await this.client.run(
			"select status,secret_hash,sealed_secret from aaas_api_keys where tenant_id=$1 and id=$2",
			this.tenantId,
			id,
		);
		if (!row) throw notFound();
		if (row.status === "revoked") throw new OrchestrationError(409, "KEY_REVOKED", "Key 已撤销，不可查看");
		if (row.sealed_secret == null)
			throw new OrchestrationError(409, "KEY_NOT_RECOVERABLE", "历史 Key 无法恢复，请轮换生成新密钥");
		try {
			const secret = this.secretBox.openValue(`aaas-key:${this.tenantId}:${id}`, row.sealed_secret);
			if (credentialHash(secret) !== String(row.secret_hash)) throw new Error("Secret hash mismatch");
			return `ak_${id}.${secret}`;
		} catch {
			throw new OrchestrationError(503, "KEY_DECRYPTION_UNAVAILABLE", "密钥暂时无法读取，请检查服务密钥配置");
		}
	}

	/** Revocation is terminal; only a disabled Key can be re-enabled. Rotation keeps the logical ID. */
	async updateAccess(
		id: string,
		action: "enable" | "disable" | "revoke" | "rotate",
	): Promise<{ readonly status?: ApiKeyStatus; readonly token?: string }> {
		return this.client.transaction(async (tx) => {
			const [row] = await txRows(
				tx,
				"select status from aaas_api_keys where tenant_id=$1 and id=$2 for update",
				this.tenantId,
				id,
			);
			if (!row) throw notFound();
			const status = String(row.status) as ApiKeyStatus;
			if (status === "revoked") throw new OrchestrationError(409, "KEY_REVOKED", "Key 已撤销，不可恢复");
			if (action === "enable" && status !== "disabled")
				throw new OrchestrationError(409, "KEY_STATE", "仅禁用的 Key 可启用");
			if (action === "rotate") {
				if (status !== "enabled") throw new OrchestrationError(409, "KEY_STATE", "仅启用的 Key 可轮换");
				const secret = randomBytes(32).toString("base64url");
				await txRows(
					tx,
					"update aaas_api_keys set secret_hash=$3,sealed_secret=$4::jsonb,updated_at=now() where tenant_id=$1 and id=$2",
					this.tenantId,
					id,
					credentialHash(secret),
					this.secretBox.sealValue(`aaas-key:${this.tenantId}:${id}`, secret),
				);
				return { token: `ak_${id}.${secret}` };
			}
			const next: ApiKeyStatus = action === "revoke" ? "revoked" : action === "disable" ? "disabled" : "enabled";
			await txRows(
				tx,
				"update aaas_api_keys set status=$3,sealed_secret=case when $3='revoked' then null else sealed_secret end,updated_at=now() where tenant_id=$1 and id=$2",
				this.tenantId,
				id,
				next,
			);
			return { status: next };
		});
	}

	/** Router scope is read at discovery/acceptance time, never cached on the principal. */
	async keyScope(keyId: string): Promise<"legacy" | "dual" | "router"> {
		const [row] = await this.client.run(
			"select router_capability_scope from aaas_api_keys where tenant_id=$1 and id=$2",
			this.tenantId,
			keyId,
		);
		if (!row) throw notFound();
		return String(row.router_capability_scope) as "legacy" | "dual" | "router";
	}

	/**
	 * Legacy /runs acceptance must reject a Router-only Key even when the old
	 * platform configuration is still usable. Called after idempotent replay so
	 * already accepted Runs remain readable and replayable.
	 */
	async assertLegacyEntryAllowed(tx: TransactionSql, keyId: string): Promise<void> {
		// Pre-0035 baseline still accepts legacy Runs: no scope column yet.
		const [column] = await txRows(
			tx,
			`select 1 from information_schema.columns
			 where table_schema=current_schema() and table_name='aaas_api_keys'
			   and column_name='router_capability_scope' limit 1`,
		);
		if (!column) return;
		const [row] = await txRows(
			tx,
			"select router_capability_scope from aaas_api_keys where tenant_id=$1 and id=$2",
			this.tenantId,
			keyId,
		);
		if (!row) throw notFound();
		if (String(row.router_capability_scope) === "router")
			throw new OrchestrationError(403, "CAPABILITY_SCOPE_REQUIRED", "Router-only Key 不可新建旧 Run");
	}

	/** T017: serialize acceptance per Key and re-verify current hash/status inside the transaction. */
	async lockAndVerify(tx: TransactionSql, principal: ApiKeyPrincipal, secretHash: string): Promise<void> {
		const [row] = await txRows(
			tx,
			"select status,secret_hash from aaas_api_keys where tenant_id=$1 and id=$2 for update",
			this.tenantId,
			principal.keyId,
		);
		if (!row || row.status !== "enabled" || String(row.secret_hash) !== secretHash)
			throw new OrchestrationError(401, "UNAUTHORIZED", "API Key 状态已变更");
	}
}

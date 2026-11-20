import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { ToolCredentialBinding } from "@earendil-works/pi-protocol";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import { newRequestId, type TenantId } from "../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { type ApiKeyStore, type PlatformBinding, validatePlatformBindings } from "./api-key.ts";
import type {
	ApiKeyCredentials,
	ApiKeyMcpServerSummary,
	ApiKeyMcpServerView,
	ApiKeyPrincipal,
	ApiKeyRunRequest,
	ApiKeyRunView,
	ApiKeyUsageView,
	CapabilitySnapshot,
} from "./api-key-contracts.ts";
import { apiKeyRunRequestSchema } from "./api-key-contracts.ts";
import type { IdempotencyKeyring, IdempotencyRecord } from "./api-key-idempotency.ts";
import { OrchestrationError, type OrchestrationSettings } from "./contracts.ts";
import type { OrchestrationStore } from "./store.ts";
import { publicToolDescription, publicToolSchema } from "./protected-tool.ts";
import type { RouterEffectiveCapabilities, RouterEffectiveServer, SensitiveBinding } from "./router-capability-contracts.ts";
import { resolveCapabilityScope, resolveEffectiveCapabilities } from "./router-capability.ts";

const CONNECTION_CREDENTIAL_ID = "connection";
const CREDENTIAL_EXPIRY_MS = 30 * 60 * 1000;
const fixedError = (code: string, message: string) => new OrchestrationError(400, code, message);

interface PlatformCapabilities {
	readonly configurationId: string;
	readonly orchestrationVersionId: string;
	readonly modelId: string;
	readonly revision: number;
	readonly servers: readonly {
		readonly serverId: string;
		readonly revision: number;
		readonly authentication: "none" | "bearer" | "api_key";
		readonly tools: readonly {
			readonly name: string;
			readonly description: string | null;
			readonly inputSchema: Record<string, unknown>;
		}[];
	}[];
	readonly bindings: readonly PlatformBinding[];
}

function knownSecrets(credentials: ApiKeyCredentials): readonly string[] {
	const values: string[] = [];
	if ("tools" in credentials) {
		for (const server of Object.values(credentials.servers)) values.push(server.connection.value);
		for (const tools of Object.values(credentials.tools))
			for (const parameters of Object.values(tools)) values.push(...Object.values(parameters));
	} else {
		for (const server of Object.values(credentials.servers)) {
			if (server.connection_credential !== undefined) values.push(server.connection_credential);
			if (server.tool_credential !== undefined) values.push(server.tool_credential);
		}
	}
	return values;
}

/**
 * V1 checks the exact secret text and the explicitly supported encodings (JSON
 * escape body, base64, URL encoding). It does not promise to detect arbitrary
 * obfuscation, and never echoes the offending input.
 */
export function containsKnownSecret(text: string, secrets: readonly string[]): boolean {
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		const forms = [
			secret,
			JSON.stringify(secret).slice(1, -1),
			Buffer.from(secret, "utf8").toString("base64"),
			encodeURIComponent(secret),
		];
		if (forms.some((form) => form.length > 0 && text.includes(form))) return true;
	}
	return false;
}

function requiredCredentialsFor(
	servers: PlatformCapabilities["servers"],
	bindings: readonly PlatformBinding[],
): ApiKeyMcpServerView["required_credentials"] {
	const entries: {
		credential_id: string;
		scope: "connection" | "tool";
		tool_name?: string;
		parameter?: string;
		required: boolean;
	}[] = [];
	for (const server of servers) {
		if (server.authentication !== "none")
			entries.push({ credential_id: CONNECTION_CREDENTIAL_ID, scope: "connection", required: true });
		for (const binding of bindings.filter((b) => b.mcpServerId === server.serverId))
			entries.push({
				credential_id: binding.credentialId,
				scope: "tool",
				tool_name: binding.toolName,
				parameter: binding.parameter,
				required: true,
			});
	}
	return entries;
}

function publicSchema(schema: Record<string, unknown>, parameters: readonly string[]): Record<string, unknown> {
	return parameters.length ? publicToolSchema(schema, parameters) : schema;
}

/** Independent API Key Run acceptance, ownership queries, MCP metadata and usage. */
export class ApiKeyRunService {
	private readonly client: PostgresClient;
	private readonly tenantId: string;
	private readonly store: OrchestrationStore;
	private readonly keys: ApiKeyStore;
	private readonly idempotency: IdempotencyKeyring;
	private readonly repos: PublishingRepositories;

	constructor(options: {
		client: PostgresClient;
		tenantId: string;
		store: OrchestrationStore;
		keys: ApiKeyStore;
		idempotency: IdempotencyKeyring;
		repos: PublishingRepositories;
	}) {
		this.client = options.client;
		this.tenantId = options.tenantId;
		this.store = options.store;
		this.keys = options.keys;
		this.idempotency = options.idempotency;
		this.repos = options.repos;
	}

	/** Platform configuration ∩ registry availability ∩ this selection; omitted = all configured and available. */
	private async effectiveCapabilities(
		principal: ApiKeyPrincipal,
		selected: readonly string[] | undefined,
		tx?: TransactionSql,
	): Promise<{ capabilities: PlatformCapabilities; effective: PlatformCapabilities["servers"] }> {
		const query = `select v.configuration_id,v.id as orchestration_version_id,
			b.credential_bindings,
			v.runtime_spec,v.runtime_spec_hash
			from aaas_api_keys k
			left join aaas_platform_configuration p on p.tenant_id=k.tenant_id and p.enabled=true
			left join orchestration_configurations kc on kc.tenant_id=k.tenant_id and kc.id=k.orchestration_configuration_id and kc.enabled=true
			left join orchestration_configurations pc on pc.tenant_id=k.tenant_id and pc.id=p.configuration_id and pc.enabled=true
			join orchestration_versions v on v.tenant_id=k.tenant_id and v.id=coalesce(
				k.orchestration_version_id,
				kc.active_version_id,
				pc.active_version_id,
				p.orchestration_version_id
			)
			join orchestration_configurations c on c.tenant_id=v.tenant_id and c.id=v.configuration_id and c.enabled=true
			left join aaas_version_credential_bindings b on b.tenant_id=v.tenant_id and b.orchestration_version_id=v.id
			where k.tenant_id=$1 and k.id=$2`;
		const [row] = tx ? await txRows(tx, query, this.tenantId, principal.keyId) : await this.client.run(query, this.tenantId, principal.keyId);
		if (!row) throw new OrchestrationError(403, "CONFIGURATION_UNAVAILABLE", "平台执行配置不可用");
		if (!Array.isArray(row.credential_bindings)) throw new OrchestrationError(403, "CONFIGURATION_UNAVAILABLE", "版本凭据映射尚未登记");
		const parsed = parseRuntimeSpec(row.runtime_spec);
		if (!parsed.ok) throw new OrchestrationError(409, "INVALID_EXECUTION_SPEC", "平台执行配置校验失败");
		if (String(row.runtime_spec_hash) !== sha256Hex(canonicalJson(parsed.spec)))
			throw new OrchestrationError(409, "INVALID_EXECUTION_SPEC", "平台执行配置校验失败");
		const bindings = (Array.isArray(row.credential_bindings) ? row.credential_bindings : []).map(
			(value: unknown): PlatformBinding => {
				const binding = value as Record<string, unknown>;
				return {
					mcpServerId: String(binding.mcpServerId),
					toolName: String(binding.toolName),
					parameter: String(binding.parameter),
					credentialId: String(binding.credentialId),
				};
			},
		);
		const servers = parsed.spec.capabilities.mcpServers.map((server) => ({
			serverId: server.mcpServerId,
			revision: server.revision,
			authentication: server.authentication,
			tools: server.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
		}));
		try {
			validatePlatformBindings(parsed.spec, bindings);
		} catch (error) {
			// A stale/dangling platform mapping must never become an executable Run.
			throw new OrchestrationError(
				409,
				"INVALID_EXECUTION_SPEC",
				error instanceof OrchestrationError ? error.message : "平台凭据映射校验失败",
			);
		}
		const capabilities: PlatformCapabilities = {
			configurationId: String(row.configuration_id),
			orchestrationVersionId: String(row.orchestration_version_id),
			modelId: parsed.spec.agent.model.modelId,
			revision: 1,
			servers,
			bindings,
		};
		const available = new Set(
			(await this.repos.mcpServers.list({ tenantId: this.tenantId as TenantId }, 100))
				.filter((server) => server.status === "enabled")
				.map((server) => `mcp_${server.mcpServerId}`),
		);
		const platform = servers.filter((server) => available.has(server.serverId));
		if (selected === undefined) return { capabilities, effective: platform };
		for (const id of new Set(selected))
			if (!available.has(id) || !platform.some((server) => server.serverId === id))
				throw fixedError("INVALID_MCP_SELECTION", "MCP Server 未配置或不可用");
		return { capabilities, effective: platform.filter((server) => selected.includes(server.serverId)) };
	}

	/** Every configured credential for every effective Server/Tool is required, even if unused. */
	private validateCredentials(
		request: ApiKeyRunRequest,
		effective: PlatformCapabilities["servers"],
		bindings: readonly PlatformBinding[],
		modelId: string,
	): { readonly settings: OrchestrationSettings; readonly flat: Record<string, string> } {
		if (!("tools" in request.credentials)) {
			const supplied = request.credentials.servers;
			for (const id of Object.keys(supplied))
				if (!effective.some((server) => server.serverId === id)) throw fixedError("INVALID_CREDENTIAL", "请求包含未启用 Server 的凭据");
			const flat: Record<string, string> = {};
			const settingsBindings: ToolCredentialBinding[] = [];
			let index = 0;
			for (const server of effective) {
				const entry = supplied[server.serverId];
				if (server.authentication !== "none") {
					if (!entry?.connection_credential) throw fixedError("MISSING_CREDENTIAL", "缺少必需的连接凭据");
					flat[`srv:${server.serverId}:${CONNECTION_CREDENTIAL_ID}`] = entry.connection_credential;
				} else if (entry?.connection_credential) throw fixedError("INVALID_CREDENTIAL", "该 Server 不接受连接凭据");
				const mapped = bindings.filter((binding) => binding.mcpServerId === server.serverId);
				if (mapped.length && !entry?.tool_credential) throw fixedError("MISSING_CREDENTIAL", "缺少必需的工具凭据");
				if (!mapped.length && entry?.tool_credential) throw fixedError("INVALID_CREDENTIAL", "该 Server 不接受工具凭据");
				for (const binding of mapped) {
					const credentialName = `task_credential_${index++}`;
					flat[credentialName] = entry!.tool_credential!;
					settingsBindings.push({ mcpServerId: server.serverId, toolName: binding.toolName, parameter: binding.parameter, credential: credentialName });
				}
			}
			return { settings: { allowedModels: [modelId], bindings: settingsBindings, queueTimeoutMs: 3_600_000 }, flat };
		}
		const { servers: suppliedServers, tools: suppliedTools } = request.credentials;
		const unknownServers = Object.keys(suppliedServers).filter(
			(id) => !effective.some((server) => server.serverId === id),
		);
		const unknownToolServers = Object.keys(suppliedTools).filter(
			(id) => !effective.some((server) => server.serverId === id),
		);
		if (unknownServers.length || unknownToolServers.length)
			throw fixedError("INVALID_CREDENTIAL", "请求包含未启用 Server 的凭据");
		// A Tool/credential that is not part of the effective platform mapping must
		// be rejected, not silently ignored: callers cannot widen or confuse the
		// transport-side injection surface.
		for (const [serverId, tools] of Object.entries(suppliedTools)) {
			const server = effective.find((entry) => entry.serverId === serverId);
			if (server === undefined) continue;
			for (const [toolName, credentials] of Object.entries(tools)) {
				const tool = server.tools.find((entry) => entry.name === toolName);
				if (tool === undefined) throw fixedError("INVALID_CREDENTIAL", "请求包含未启用 Tool 的凭据");
				const configured = new Set(
					bindings
						.filter((binding) => binding.mcpServerId === serverId && binding.toolName === toolName)
						.map((binding) => binding.credentialId),
				);
				for (const credentialId of Object.keys(credentials))
					if (!configured.has(credentialId)) throw fixedError("INVALID_CREDENTIAL", "请求包含未配置的工具凭据");
			}
		}
		const flat: Record<string, string> = {};
		const settingsBindings: ToolCredentialBinding[] = [];
		let index = 0;
		for (const server of effective) {
			const supplied = suppliedServers[server.serverId];
			if (server.authentication !== "none") {
				if (!supplied || supplied.connection.credential_id !== CONNECTION_CREDENTIAL_ID)
					throw fixedError("MISSING_CREDENTIAL", "缺少必需的连接凭据");
				flat[`srv:${server.serverId}:${CONNECTION_CREDENTIAL_ID}`] = supplied.connection.value;
			} else if (supplied) throw fixedError("INVALID_CREDENTIAL", "该 Server 不接受连接凭据");
			for (const binding of bindings.filter((b) => b.mcpServerId === server.serverId)) {
				const tool = suppliedTools[server.serverId]?.[binding.toolName];
				const value = tool?.[binding.credentialId];
				if (typeof value !== "string") throw fixedError("MISSING_CREDENTIAL", "缺少必需的工具凭据");
				// `bindingSchema.credential` only allows identifier characters; a synthetic
				// name keeps the flat credential map and the binding in sync.
				const credentialName = `task_credential_${index++}`;
				flat[credentialName] = value;
				settingsBindings.push({
					mcpServerId: server.serverId,
					toolName: binding.toolName,
					parameter: binding.parameter,
					credential: credentialName,
				});
			}
		}
		return {
			settings: { allowedModels: [modelId], bindings: settingsBindings, queueTimeoutMs: 3_600_000 },
			flat,
		};
	}

	private snapshot(
		capabilities: PlatformCapabilities,
		effective: PlatformCapabilities["servers"],
		bindings: readonly PlatformBinding[],
	): { readonly snapshot: CapabilitySnapshot; readonly hash: string } {
		const snapshot: CapabilitySnapshot = {
			version: 1,
			configurationId: capabilities.configurationId,
			orchestrationVersionId: capabilities.orchestrationVersionId,
			revision: capabilities.revision,
			servers: effective.map((server) => ({
				serverId: server.serverId,
				revision: server.revision,
				authentication: server.authentication,
				connectionCredentialId: server.authentication === "none" ? null : CONNECTION_CREDENTIAL_ID,
				tools: server.tools.map((tool) => ({
					name: tool.name,
					inputSchema: structuredClone(tool.inputSchema),
					parameterCredentials: bindings
						.filter((b) => b.mcpServerId === server.serverId && b.toolName === tool.name)
						.map((b) => ({ credentialId: b.credentialId, parameter: b.parameter })),
				})),
			})),
		};
		return { snapshot, hash: sha256Hex(canonicalJson(snapshot)) };
	}

	/** T025 fixed order: authenticate + re-verify → idempotency match → only then validate config/credentials. */
	async submit(
		principal: ApiKeyPrincipal,
		idempotencyKey: string,
		body: unknown,
	): Promise<{ run_id: string; status: string; duplicate: boolean }> {
		const parsed = apiKeyRunRequestSchema.safeParse(body);
		if (!parsed.success) throw fixedError("INVALID_REQUEST", "请求不符合接口契约");
		const request = parsed.data;
		const secrets = knownSecrets(request.credentials);
		if (
			containsKnownSecret(request.prompt, secrets) ||
			(request.task_id !== undefined && containsKnownSecret(request.task_id, secrets))
		)
			throw fixedError("CREDENTIAL_IN_INPUT", "请求包含凭据，已拒绝受理");
		const normalized = {
			prompt: request.prompt,
			...(request.task_id ? { task_id: request.task_id } : {}),
			mcp_servers: request.mcp_servers ?? null,
			credentials: request.credentials,
		};
		const digest = this.idempotency.digest(normalized);
		const idempotencyKeyValue = idempotencyKey.trim();
		if (idempotencyKeyValue.length === 0 || idempotencyKeyValue.length > 200)
			throw fixedError("INVALID_REQUEST", "Idempotency-Key 无效");

		try {
			return await this.client.transaction(async (tx) => {
				await this.keys.lockAndVerify(tx, principal, principal.secretHash);
				const [previous] = await txRows(
					tx,
					`select request_hash,canonicalization_version,digest_key_version,work_item_id
					 from aaas_key_idempotency where tenant_id=$1 and key_id=$2 and idempotency_key=$3`,
					this.tenantId,
					principal.keyId,
					idempotencyKeyValue,
				);
				if (previous) {
					const record: IdempotencyRecord = {
						requestHash: String(previous.request_hash),
						canonicalizationVersion: Number(previous.canonicalization_version),
						digestKeyVersion: Number(previous.digest_key_version),
						workItemId: String(previous.work_item_id),
					};
					if (!this.idempotency.matches(normalized, record))
						throw new OrchestrationError(409, "EVENT_CONFLICT", "幂等键已用于其他请求");
					const replay = await this.runInTx(tx, principal, record.workItemId);
					return { run_id: record.workItemId, status: replay.status, duplicate: true };
				}

				// A replayed Run is returned above; a new Run must pass the current scope gate.
				await this.keys.assertLegacyEntryAllowed(tx, principal.keyId);
				// Only a new request resolves current platform config, grants and credentials.
				const { capabilities, effective } = await this.effectiveCapabilities(principal, request.mcp_servers, tx);
				const { settings, flat } = this.validateCredentials(
					request,
					effective,
					capabilities.bindings,
					capabilities.modelId,
				);
				const { snapshot, hash } = this.snapshot(capabilities, effective, capabilities.bindings);
				const carrierId = await this.keys.ensureCarrier(tx, principal.keyId, capabilities);
				const carrier = await this.store.getIntegration(carrierId, tx);
				const accepted = await this.store.accept(
					carrier,
					{
						eventId: `ak_${randomUUID()}`,
						alarmId: request.task_id ?? idempotencyKeyValue,
						input: request.prompt,
						credentials: flat,
						credentialExpiresAt: new Date(Date.now() + CREDENTIAL_EXPIRY_MS).toISOString(),
					},
					{
						origin: "aaas",
						taskPrompt: request.prompt,
						requestContract: "legacy_prompt",
						requestHash: digest.requestHash,
						keyId: principal.keyId,
						taskId: request.task_id,
						capabilitySnapshot: snapshot,
						capabilitySnapshotHash: hash,
						settings,
						executionVersion: { configurationId: capabilities.configurationId, orchestrationVersionId: capabilities.orchestrationVersionId },
					},
					tx,
				);
				await txRows(
					tx,
					`insert into aaas_key_idempotency(tenant_id,key_id,idempotency_key,request_hash,canonicalization_version,digest_key_version,work_item_id)
					 values ($1,$2,$3,$4,$5,$6,$7)`,
					this.tenantId,
					principal.keyId,
					idempotencyKeyValue,
					digest.requestHash,
					digest.canonicalizationVersion,
					digest.digestKeyVersion,
					accepted.workItemId,
				);
				// The audit row commits atomically with the accepted Run and idempotency record.
				// Generate the request identifier locally: caller-provided headers and inputs
				// must never enter this security metadata.
				await txRows(
					tx,
					`insert into audit_events
					 (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
					 values ($1,$2,'aaas_api_key',$3,'aaas.run.accepted','aaas_run',$4,$5,$6::jsonb)`,
					randomUUID(),
					this.tenantId,
					principal.keyId,
					accepted.workItemId,
					newRequestId(),
					{ carrier_integration_id: carrierId },
				);
				return { run_id: accepted.workItemId, status: "queued", duplicate: false };
			});
		} catch (error) {
			// Unique conflict: recover the winning record under a re-verified Key transaction.
			if (error instanceof Error && "code" in error && String(error.code) === "23505") {
				for (let attempt = 0; attempt < 3; attempt++)
					try {
						return await this.client.transaction(async (tx) => {
							await this.keys.lockAndVerify(tx, principal, principal.secretHash);
							const [winner] = await txRows(
								tx,
								`select request_hash,canonicalization_version,digest_key_version,work_item_id
								 from aaas_key_idempotency where tenant_id=$1 and key_id=$2 and idempotency_key=$3`,
								this.tenantId,
								principal.keyId,
								idempotencyKeyValue,
							);
							if (!winner) throw new OrchestrationError(500, "IDEMPOTENCY_UNAVAILABLE", "幂等记录不可用");
							const record: IdempotencyRecord = {
								requestHash: String(winner.request_hash),
								canonicalizationVersion: Number(winner.canonicalization_version),
								digestKeyVersion: Number(winner.digest_key_version),
								workItemId: String(winner.work_item_id),
							};
							if (!this.idempotency.matches(normalized, record))
								throw new OrchestrationError(409, "EVENT_CONFLICT", "幂等键已用于其他请求");
							const replay = await this.runInTx(tx, principal, record.workItemId);
							return { run_id: record.workItemId, status: replay.status, duplicate: true };
						});
					} catch (retry) {
						if (retry instanceof OrchestrationError) throw retry;
						if (attempt === 2) throw retry;
					}
				throw new OrchestrationError(500, "IDEMPOTENCY_UNAVAILABLE", "幂等记录不可用");
			}
			throw error;
		}
	}

	private async runInTx(tx: Parameters<typeof txRows>[0], principal: ApiKeyPrincipal, runId: string) {
		const [row] = await txRows(
			tx,
			`select w.id,w.state,a.report,a.error,w.task_id,w.created_at,a.started_at,a.ended_at
			 from orchestration_work_items w left join lateral (
			   select * from orchestration_assignments where work_item_id=w.id and tenant_id=w.tenant_id
			   order by created_at,id limit 1
			 ) a on true
			 where w.tenant_id=$1 and w.key_id=$2 and w.id=$3 and w.origin='aaas'`,
			this.tenantId,
			principal.keyId,
			runId,
		);
		if (!row) throw new OrchestrationError(404, "NOT_FOUND", "Run 不存在");
		return this.toRunView(row);
	}

	private toRunView(row: Record<string, unknown>): ApiKeyRunView {
		const state = String(row.state);
		return {
			run_id: String(row.id),
			task_id: row.task_id === null ? null : String(row.task_id),
			status: (state === "succeeded" ? "completed" : state) as ApiKeyRunView["status"],
			result: state === "succeeded" && row.report !== null ? String(row.report) : null,
			error: row.error ? { code: String(row.error) } : null,
			created_at: (row.created_at as Date).toISOString(),
			started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
			completed_at: row.ended_at ? (row.ended_at as Date).toISOString() : null,
			duplicate: false,
		};
	}

	/** Ownership is mandatory: permission denied and missing are the same 404. */
	async run(principal: ApiKeyPrincipal, runId: string): Promise<ApiKeyRunView> {
		return this.client.transaction(async (tx) => this.runInTx(tx, principal, runId));
	}

	async cancel(principal: ApiKeyPrincipal, runId: string): Promise<ApiKeyRunView> {
		return this.client.transaction(async (tx) => {
			const [locked] = await txRows(
				tx,
				`select id,state from orchestration_work_items
				 where tenant_id=$1 and key_id=$2 and id=$3 and origin='aaas' for update`,
				this.tenantId,
				principal.keyId,
				runId,
			);
			if (!locked) throw new OrchestrationError(404, "NOT_FOUND", "Run 不存在");
			if (["queued", "running"].includes(String(locked.state))) {
				await txRows(
					tx,
					"update orchestration_work_items set state='cancelled',updated_at=now() where tenant_id=$1 and key_id=$2 and id=$3 and state in ('queued','running')",
					this.tenantId,
					principal.keyId,
					runId,
				);
				await txRows(
					tx,
					"update orchestration_assignments set state='cancelled',ended_at=now() where tenant_id=$1 and work_item_id=$2 and state in ('queued','running')",
					this.tenantId,
					runId,
				);
			}
			return this.runInTx(tx, principal, runId);
		});
	}

	/** Fields shared by the list and detail endpoints, derived from the same effective capabilities. */
	private async mcpServerSummary(
		server: PlatformCapabilities["servers"][number],
		bindings: readonly PlatformBinding[],
	): Promise<ApiKeyMcpServerSummary> {
		const record = await this.repos.mcpServers.get(
			{ tenantId: this.tenantId as TenantId },
			server.serverId.slice(4) as never,
		);
		return {
			server_id: server.serverId,
			name: record?.name ?? server.serverId,
			description: null,
			revision: server.revision,
			tool_count: server.tools.length,
			authentication: server.authentication,
			credential_requirements: {
				connection_credential: server.authentication !== "none",
				tool_credential: bindings.length > 0,
			},
		};
	}

	private async scopedEffective(
		principal: ApiKeyPrincipal,
		header: string | undefined,
	): Promise<{ readonly effective: RouterEffectiveCapabilities | null; readonly servers: PlatformCapabilities["servers"]; readonly bindings: readonly PlatformBinding[] }> {
		const scope = resolveCapabilityScope(await this.keys.keyScope(principal.keyId), header);
		if (scope === "legacy") {
			const { capabilities, effective } = await this.effectiveCapabilities(principal, undefined);
			return { effective: null, servers: effective, bindings: capabilities.bindings };
		}
		const effective = await resolveEffectiveCapabilities({
			client: this.client,
			repos: this.repos,
			tenantId: this.tenantId,
			principal,
			scope,
		});
		const servers: PlatformCapabilities["servers"] = effective.servers.map((server) => ({
			serverId: server.serverId,
			revision: server.revision,
			authentication: server.authentication,
			tools: server.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
		}));
		const bindings: PlatformBinding[] = effective.servers.flatMap((server) =>
			server.sensitiveBindings.map((binding) => ({
				mcpServerId: binding.mcpServerId,
				toolName: binding.toolName,
				parameter: binding.parameter,
				credentialId: binding.credentialId,
			})),
		);
		return { effective, servers, bindings };
	}

	private async routerServerSummary(
		server: RouterEffectiveServer,
		bindings: readonly SensitiveBinding[],
	): Promise<ApiKeyMcpServerSummary> {
		const record = await this.repos.mcpServers.get(
			{ tenantId: this.tenantId as TenantId },
			server.serverId.slice(4) as never,
		);
		return {
			server_id: server.serverId,
			name: record?.name ?? server.serverId,
			description: null,
			revision: server.revision,
			tool_count: server.tools.length,
			authentication: server.authentication,
			credential_requirements: {
				tool_credential: bindings.length > 0,
			},
		};
	}

	/** Lightweight Server list: no tools, input schemas or per-tool credential detail. */
	async mcpServers(principal: ApiKeyPrincipal, header?: string): Promise<readonly ApiKeyMcpServerSummary[]> {
		const scoped = await this.scopedEffective(principal, header);
		if (scoped.effective === null)
			return Promise.all(
				scoped.servers.map((server) =>
					this.mcpServerSummary(server, scoped.bindings.filter((b) => b.mcpServerId === server.serverId)),
				),
			);
		return Promise.all(
			scoped.effective.servers.map((server) =>
				this.routerServerSummary(server, server.sensitiveBindings),
			),
		);
	}

	/**
	 * On-demand detail for one effective Server. A Server outside the resolved
	 * capability scope is indistinguishable from an unknown one.
	 */
	async mcpServer(principal: ApiKeyPrincipal, serverId: string, header?: string): Promise<ApiKeyMcpServerView> {
		const scoped = await this.scopedEffective(principal, header);
		if (scoped.effective === null) {
			const server = scoped.servers.find((entry) => entry.serverId === serverId);
			if (server === undefined) throw new OrchestrationError(404, "NOT_FOUND", "MCP Server 不存在或不可访问");
			const bindings = scoped.bindings.filter((b) => b.mcpServerId === server.serverId);
			return {
				...(await this.mcpServerSummary(server, bindings)),
				tools: server.tools.map((tool) => {
					const parameters = bindings.filter((b) => b.toolName === tool.name).map((b) => b.parameter);
					return {
						name: tool.name,
						description: tool.description === null ? null : publicToolDescription(tool.description, parameters),
						input_schema: publicSchema(tool.inputSchema, parameters),
					};
				}),
				required_credentials: requiredCredentialsFor([server], bindings),
			};
		}
		const server = scoped.effective.servers.find((entry) => entry.serverId === serverId);
		if (server === undefined) throw new OrchestrationError(404, "NOT_FOUND", "MCP Server 不存在或不可访问");
		return {
			...(await this.routerServerSummary(server, server.sensitiveBindings)),
			tools: server.tools.map((tool) => {
				const parameters = tool.sensitiveBindings.map((binding) => binding.parameter);
				return {
					name: tool.name,
					description: tool.description === null ? null : publicToolDescription(tool.description, parameters),
					input_schema: publicSchema(tool.inputSchema, parameters),
				};
			}),
			required_credentials: [
				...server.sensitiveBindings.map((binding) => ({
					credential_id: binding.credentialId,
					scope: "tool" as const,
					tool_name: binding.toolName,
					parameter: binding.parameter,
					required: true,
				})),
			],
		};
	}

	/**
	 * Usage starts from Key-owned Runs only; unknown provider usage is never fabricated as zero.
	 *
	 * `partial` lives NEXT TO `total` inside `llmUsage` (it is a property of the
	 * turn, not of the aggregated totals), so the filter must read
	 * `llmUsage->>'partial'` — reading `llmUsage->'total'->>'partial'` never matches
	 * and silently reported every Key as "unknown usage".
	 *
	 * `covered` counts RUNS, not turns: a Run counts as covered only when EVERY one
	 * of its `turn/end` events carries a complete `llmUsage` — the same rule the
	 * admin orchestration view applies — so a Run with several turns is never
	 * counted twice and a Run without usage is never counted as covered.
	 */
	async usage(principal: ApiKeyPrincipal): Promise<ApiKeyUsageView> {
		const [counts, usage] = await Promise.all([
			this.client.run(
				"select state,count(*)::int as n from orchestration_work_items where tenant_id=$1 and key_id=$2 group by state",
				this.tenantId,
				principal.keyId,
			),
			this.client.run(
				`select count(*)::int as runs,
				        count(*) filter (where u.complete)::int as covered,
				        coalesce(sum(u.total_tokens) filter (where u.complete),0)::bigint as total_tokens,
				        coalesce(sum(u.input_tokens) filter (where u.complete),0)::bigint as input_tokens,
				        coalesce(sum(u.output_tokens) filter (where u.complete),0)::bigint as output_tokens,
				        coalesce(sum(u.confirmed_tokens),0)::bigint as confirmed_tokens,
				        coalesce(sum(u.confirmed_input),0)::bigint as confirmed_input,
				        coalesce(sum(u.confirmed_output),0)::bigint as confirmed_output,
				        coalesce(bool_or(u.has_confirmed),false) as has_confirmed
				 from orchestration_work_items w
				 left join lateral (
				   select bool_and(e.event_type='turn/end'
				            and e.payload->'llmUsage' is not null
				            and e.payload->'llmUsage'->>'partial'='false') as complete,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'totalTokens')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as total_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'input')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as input_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'output')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as output_tokens,
				          -- Confirmed consumption from all terminal turns with llmUsage,
				          -- including incomplete/cancelled ones. Coverage (complete)
				          -- is unchanged: only fully-measured runs are "covered".
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'totalTokens')::bigint),0)::bigint as confirmed_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'input')::bigint),0)::bigint as confirmed_input,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'output')::bigint),0)::bigint as confirmed_output,
				          bool_or(exists (
				            select 1 from jsonb_array_elements(
				              case when jsonb_typeof(e.payload->'llmUsage'->'calls')='array'
				                then e.payload->'llmUsage'->'calls' else '[]'::jsonb end
				            ) as call
				            where call->>'usageReported'='true'
				              or (not (call ? 'usageReported') and jsonb_typeof(call->'totalTokens')='number')
				          )) as has_confirmed
				   from conversation_events e
				   where e.tenant_id=w.tenant_id and e.conversation_id=w.conversation_id
				     and e.event_type in ('turn/end','turn/interrupted')
				 ) u on true
				 where w.tenant_id=$1 and w.key_id=$2`,
				this.tenantId,
				principal.keyId,
			),
		]);
		const byStatus: Record<string, number> = {};
		let runs = 0;
		for (const row of counts) {
			byStatus[String(row.state)] = Number(row.n);
			runs += Number(row.n);
		}
		const row = usage[0];
		const covered = Number(row?.covered ?? 0);
		// `confirmed_*` sums usage from every terminal turn with llmUsage,
		// including incomplete/cancelled ones; `*_tokens` sums only fully covered
		// runs. Report confirmed consumption so a failed/cancelled call's real
		// tokens are not discarded, while status/covered_runs keep the coverage
		// caliber unchanged. Never fabricate a value when nothing was reported.
		const confirmedTokens = Number(row?.confirmed_tokens ?? 0);
		const hasConfirmed = row?.has_confirmed === true;
		return {
			key_id: principal.keyId,
			runs,
			by_status: byStatus,
			usage:
				!hasConfirmed
					? null
					: {
							status: covered >= runs ? "covered" : "partial",
							covered_runs: covered,
							missing_runs: Math.max(0, runs - covered),
							total_tokens: confirmedTokens,
							input_tokens: Number(row?.confirmed_input ?? 0),
							output_tokens: Number(row?.confirmed_output ?? 0),
						},
		};
	}
}

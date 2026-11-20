import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
	AaasRun,
	AnalysisAssignmentView,
	AnalysisEventRequest,
	AnalysisWorkItem,
	OrchestrationIntegration,
} from "@earendil-works/pi-protocol";
import type { TransactionSql } from "postgres";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import { canonicalJson } from "../publishing/runtime-spec/hash.ts";
import type { LlmCallTrace } from "../types.ts";
import { OrchestrationConfigurationRepository, type PreparedOrchestrationVersion } from "./configuration-domain.ts";
import { OrchestrationError, type OrchestrationSettings, settingsSchema } from "./contracts.ts";
import {
	type CredentialDimension,
	credentialHash,
	parseWorkCredentialSet,
	type WorkCredentialBox,
	type WorkCredentialEntry,
	type WorkCredentialSet,
} from "./credentials.ts";

/** Payload-free diagnostic for a dropped provider-boundary record. */
function reportLlmTraceGap(phase: string, turnId: string, callIndex: number): void {
	console.warn(
		`[llm-trace] ${phase} affected 0 rows (turnId=${turnId}, callIndex=${callIndex}); record may be missing`,
	);
}

export interface IntegrationRecord {
	id: string;
	tenantId: string;
	appId: string | null;
	versionId: string;
	/** 历史 Chat 发布版本；迁移后仅作溯源，不再作为配置来源。 */
	publishedVersionId: string | null;
	configurationId: string | null;
	revision: number;
	name: string;
	enabled: boolean;
	settings: OrchestrationSettings;
	/** legacy 为旧 Integration Token 载体；internal_key_carrier 不可由旧入口登录或操作。 */
	kind: "legacy" | "internal_key_carrier";
}

export interface ClaimedAssignment {
	readonly configurationId?: string | null;
	readonly appId?: string | null;
	readonly requestContract?: string;
	id: string;
	workItemId: string;
	integrationId: string;
	eventId: string;
	input: string;
	conversationId: string;
	principalId: string;
	versionId: string;
	turnId: string;
	settings: OrchestrationSettings;
}

/**
 * The secrets of one running Run. The full set belongs to the trusted inspector
 * only; a Server connection and a Tool receive their own dimension and nothing else.
 */
export interface RunCredentials {
	/** Every known secret of this Run; only the trusted inspector may read the whole set. */
	readonly values: Readonly<Record<string, string>>;
	readonly keyId: string | null;
	readonly settings: OrchestrationSettings;
	/** The connection credential of one MCP Server only. */
	connectionCredential(serverId: string): string | undefined;
	/** The parameter credentials mapped to one (Server, Tool) only. */
	toolValues(
		serverId: string,
		toolName: string,
		credentialNames?: readonly string[],
	): Readonly<Record<string, string>>;
}

/** Per-dimension AAD scope: tenant, Key, Run, assignment, Server and Tool or connection. */
function dimensionScope(parts: {
	tenantId: string;
	keyId: string;
	workId: string;
	assignmentId: string;
	dimension: CredentialDimension;
}): string {
	const { tenantId, keyId, workId, assignmentId, dimension } = parts;
	const base = `${tenantId}:${keyId}:${workId}:${assignmentId}:server:${dimension.serverId}`;
	return dimension.kind === "connection"
		? `${base}:connection`
		: `${base}:tool:${dimension.toolName}:${dimension.credentialId}`;
}

/** Connection credentials are flat-named `srv:<serverId>:connection`. */
function connectionDimension(name: string): CredentialDimension | undefined {
	const match = /^srv:([^:]+):connection$/.exec(name);
	return match?.[1] === undefined ? undefined : { kind: "connection", serverId: match[1] };
}

/**
 * The platform-registered credential id of a Tool parameter. The frozen capability
 * snapshot is the only source; an unresolved or ambiguous mapping keeps the Run-local
 * credential name, which is unique inside the Run.
 */
function platformCredentialId(
	snapshot: unknown,
	binding: { mcpServerId: string; toolName: string; parameter: string },
): string | null {
	if (typeof snapshot !== "object" || snapshot === null) return null;
	const servers = (snapshot as { servers?: unknown }).servers;
	if (!Array.isArray(servers)) return null;
	for (const server of servers) {
		if (typeof server !== "object" || server === null) continue;
		const record = server as { serverId?: unknown; tools?: unknown };
		if (record.serverId !== binding.mcpServerId || !Array.isArray(record.tools)) continue;
		for (const tool of record.tools) {
			if (typeof tool !== "object" || tool === null) continue;
			const toolRecord = tool as { name?: unknown; parameterCredentials?: unknown };
			if (toolRecord.name !== binding.toolName || !Array.isArray(toolRecord.parameterCredentials)) continue;
			const matches = toolRecord.parameterCredentials.filter(
				(entry: unknown) =>
					typeof entry === "object" &&
					entry !== null &&
					(entry as { parameter?: unknown }).parameter === binding.parameter &&
					typeof (entry as { credentialId?: unknown }).credentialId === "string",
			);
			return matches.length === 1 ? (matches[0] as { credentialId: string }).credentialId : null;
		}
	}
	return null;
}

function integration(row: Record<string, unknown>): IntegrationRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		appId: row.published_app_id === null ? null : String(row.published_app_id),
		configurationId: row.configuration_id ? String(row.configuration_id) : null,
		versionId: String(row.orchestration_version_id ?? row.published_app_version_id),
		publishedVersionId:
			row.published_app_version_id === null || row.published_app_version_id === undefined
				? null
				: String(row.published_app_version_id),
		revision: Number(row.revision),
		name: String(row.name),
		enabled: row.enabled === true,
		settings: settingsSchema.parse(row.settings),
		kind: row.kind === "internal_key_carrier" ? "internal_key_carrier" : "legacy",
	};
}

/** 命名空间是版本键的一部分：orv_ 为独立编排，pav_ 为历史 Chat 发布快照。 */
function versionKey(configurationId: string | null, versionId: string | null): string | null {
	return versionId === null ? null : `${configurationId ? "orv" : "pav"}_${versionId}`;
}

const notFound = () => new OrchestrationError(404, "NOT_FOUND", "接入或工作项不存在");
const credentialExpired = () => new OrchestrationError(401, "CREDENTIAL_EXPIRED", "任务凭据已过期");

/** Postgres is the business truth; acceptance and dispatch records commit together. */
export class OrchestrationStore {
	readonly client: PostgresClient;
	readonly configurations: OrchestrationConfigurationRepository;
	readonly tenantId: string;
	private readonly box: WorkCredentialBox;
	constructor(client: PostgresClient, tenantId: string, box: WorkCredentialBox) {
		this.client = client;
		this.configurations = new OrchestrationConfigurationRepository(client);
		this.tenantId = tenantId;
		this.box = box;
	}

	/** Store exact provider-boundary context and response outside the Embed event stream. */
	async recordLlmTrace(conversationId: string, turnId: string, trace: LlmCallTrace): Promise<void> {
		const source = trace.kind === "request" ? trace.context : trace.message;
		const payload = JSON.stringify(source);
		if (trace.kind === "request") {
			// `returning` makes a silently skipped insert observable. A zero-row
			// result means either a call_index collision or no matching
			// assignment — both are real data gaps and must not be swallowed.
			const inserted = await this.client.run(
				`insert into orchestration_llm_calls
				 (tenant_id,conversation_id,turn_id,call_index,model_provider,model_id,request_payload)
				 select w.tenant_id,w.conversation_id,a.turn_id,$4,$5,$6,$7::text::jsonb
				 from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id and a.tenant_id=w.tenant_id
				 where w.tenant_id=$1 and w.conversation_id=$2 and a.turn_id=$3
				 on conflict (turn_id,call_index) do nothing
				 returning call_index`,
				this.tenantId,
				conversationId,
				turnId,
				trace.callIndex,
				trace.model.provider,
				trace.model.id,
				payload,
			);
			if (inserted.length === 0) reportLlmTraceGap("request-insert", turnId, trace.callIndex);
			return;
		}
		const updated = await this.client.run(
			`update orchestration_llm_calls set response_payload=$5::text::jsonb,completed_at=now()
			 where tenant_id=$1 and conversation_id=$2 and turn_id=$3 and call_index=$4
			 returning call_index`,
			this.tenantId,
			conversationId,
			turnId,
			trace.callIndex,
			payload,
		);
		if (updated.length === 0) reportLlmTraceGap("response-update", turnId, trace.callIndex);
	}

	async getIntegration(id: string, tx?: TransactionSql): Promise<IntegrationRecord> {
		const query = "select * from orchestration_integrations where tenant_id=$1 and id=$2";
		const rows = tx
			? await txRows(tx, `${query} for update`, this.tenantId, id)
			: await this.client.run(query, this.tenantId, id);
		if (!rows[0]) throw notFound();
		return integration(rows[0]);
	}

	/** Old management routes must never reach an internal Key carrier, even by known ID. */
	async getLegacyIntegration(id: string, tx?: TransactionSql): Promise<IntegrationRecord> {
		const query = "select * from orchestration_integrations where tenant_id=$1 and id=$2 and kind='legacy'";
		const rows = tx
			? await txRows(tx, `${query} for update`, this.tenantId, id)
			: await this.client.run(query, this.tenantId, id);
		if (!rows[0]) throw notFound();
		return integration(rows[0]);
	}

	async authenticate(header: string | undefined): Promise<IntegrationRecord> {
		const match =
			/^Bearer oi_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
				header ?? "",
			);
		if (!match) throw new OrchestrationError(401, "UNAUTHORIZED", "接入凭据无效");
		const rows = await this.client.run(
			"select * from orchestration_integrations where tenant_id=$1 and id=$2 and kind='legacy'",
			this.tenantId,
			match[1],
		);
		const expected = Buffer.from(String(rows[0]?.secret_hash ?? "0".repeat(64)), "hex");
		const valid = expected.length === 32 && timingSafeEqual(expected, Buffer.from(credentialHash(match[2]), "hex"));
		if (!valid || rows[0]?.enabled !== true) throw new OrchestrationError(401, "UNAUTHORIZED", "接入凭据无效");
		return integration(rows[0]);
	}

	async createIntegration(appId: string, versionId: string, name: string, settings: OrchestrationSettings) {
		const id = randomUUID(),
			secret = randomBytes(32).toString("base64url");
		await this.client.run(
			`insert into orchestration_integrations
		(id,tenant_id,published_app_id,published_app_version_id,name,secret_hash,settings) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
			id,
			this.tenantId,
			appId,
			versionId,
			name,
			credentialHash(secret),
			settings,
		);
		return { id, token: `oi_${id}.${secret}` };
	}

	async createTaskIntegration(name: string, settings: OrchestrationSettings, version: PreparedOrchestrationVersion) {
		const id = randomUUID(),
			secret = randomBytes(32).toString("base64url");
		await this.client.transaction(async (tx) => {
			await this.configurations.create(tx, name, version);
			await txRows(
				tx,
				`insert into orchestration_integrations(id,tenant_id,name,secret_hash,settings,configuration_id,orchestration_version_id)
   values ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
				id,
				this.tenantId,
				name,
				credentialHash(secret),
				settings,
				version.configurationId,
				version.id,
			);
		});
		return { id, token: `oi_${id}.${secret}` };
	}

	async listIntegrations(): Promise<readonly OrchestrationIntegration[]> {
		const rows = await this.client.run(
			`select i.*,a.public_app_id,a.name as chat_app_name from orchestration_integrations i left join published_apps a
		 on a.id=i.published_app_id and a.tenant_id=i.tenant_id
		 where i.tenant_id=$1 and i.kind='legacy' order by i.created_at desc`,
			this.tenantId,
		);
		return rows.map((row) => {
			const i = integration(row);
			return {
				id: i.id,
				name: i.name,
				publicAppId: row.public_app_id ? String(row.public_app_id) : "",
				chatAppName: row.chat_app_name ? String(row.chat_app_name) : null,
				legacyVersionId: versionKey(null, i.publishedVersionId),
				configurationId: i.configurationId,
				configurationSource: i.configurationId ? "orchestration" : "legacy_orchestration",
				enabled: i.enabled,
				revision: i.revision,
				versionId: versionKey(i.configurationId, i.versionId) ?? "",
				allowedModels: i.settings.allowedModels,
				bindings: i.settings.bindings,
			};
		});
	}

	async updateAccess(id: string, action: "enable" | "disable" | "rotate") {
		await this.getLegacyIntegration(id);
		if (action === "rotate") {
			const secret = randomBytes(32).toString("base64url");
			await this.client.run(
				"update orchestration_integrations set secret_hash=$3 where tenant_id=$1 and id=$2",
				this.tenantId,
				id,
				credentialHash(secret),
			);
			return { token: `oi_${id}.${secret}` };
		}
		await this.client.run(
			"update orchestration_integrations set enabled=$3 where tenant_id=$1 and id=$2",
			this.tenantId,
			id,
			action === "enable",
		);
		return { enabled: action === "enable" };
	}

	/** Display name only: identity, credentials, configuration and historical runs stay untouched. */
	async renameIntegration(id: string, name: string): Promise<{ name: string }> {
		await this.getLegacyIntegration(id);
		await this.client.run(
			"update orchestration_integrations set name=$3 where tenant_id=$1 and id=$2",
			this.tenantId,
			id,
			name,
		);
		return { name };
	}

	async accept(
		i: IntegrationRecord,
		input: AnalysisEventRequest,
		options: {
			origin?: "orchestration" | "aaas";
			requestHash?: string;
			/** 仅用于早期幂等 hash 版本 1 的重投校验，与动态 Prompt 是否为正式契约无关。 */
			legacyRequestHash?: string;
			/** 本次请求的完整 Prompt，覆盖编排版本的 System Prompt。 */
			taskPrompt?: string;
			/** 持久化契约标识，`legacy_prompt` 为动态 Prompt 正式契约，沿用历史命名。 */
			requestContract?: "input_v1" | "legacy_prompt";
			externalRef?: { type?: string; id: string };
			metadata?: Record<string, unknown>;
			/** 仅新 Key 入口提供；旧入口保持 null，历史记录不回填。 */
			keyId?: string;
			taskId?: string;
			capabilitySnapshot?: unknown;
			capabilitySnapshotHash?: string;
			/** New-Key acceptance overrides the frozen bindings for this Run only. */
			settings?: OrchestrationSettings;
			/** Key Runs freeze the resolved version independently of their shared carrier. */
			executionVersion?: { configurationId: string; orchestrationVersionId: string };
		} = {},
		outerTx?: TransactionSql,
	) {
		const origin = options.origin ?? "orchestration";
		if (origin === "aaas" && input.workItemId)
			throw new OrchestrationError(400, "INVALID_REQUEST", "Run 不接受已有工作项");
		const expires = new Date(input.credentialExpiresAt);
		const execute = async (tx: TransactionSql) => {
			const current = await this.getIntegration(i.id, tx);
			if (!current.enabled) throw new OrchestrationError(403, "DISABLED", "接入已停用");
			const configurationId = options.executionVersion?.configurationId ?? current.configurationId;
			const versionId = options.executionVersion?.orchestrationVersionId ?? current.versionId;
			if (configurationId) {
				const configuration = await txRows(
					tx,
					"select 1 from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
					this.tenantId,
					configurationId,
				);
				if (!configuration[0]) throw new OrchestrationError(403, "CONFIGURATION_UNAVAILABLE", "编排已停用");
			}

			const hash = options.requestHash ?? credentialHash(canonicalJson(input));
			const previous = await txRows(
				tx,
				"select * from orchestration_events where tenant_id=$1 and integration_id=$2 and event_id=$3",
				this.tenantId,
				i.id,
				input.eventId,
			);
			if (previous[0]) {
				if (
					previous[0].request_hash !== hash &&
					!(
						Number(previous[0].request_hash_version) === 1 &&
						options.legacyRequestHash === previous[0].request_hash
					)
				)
					throw new OrchestrationError(409, "EVENT_CONFLICT", "eventId 已用于其他请求");
				return { workItemId: String(previous[0].work_item_id), duplicate: true };
			}
			if (expires.getTime() <= Date.now() || expires.getTime() > Date.now() + 86_400_000)
				throw new OrchestrationError(400, "INVALID_EXPIRY", "凭据有效期必须在未来 24 小时以内");
			const pending = await txRows(
				tx,
				"select count(*)::int as n from orchestration_assignments where tenant_id=$1 and integration_id=$2 and state='queued'",
				this.tenantId,
				i.id,
			);
			if (Number(pending[0]?.n) >= 1000)
				throw new OrchestrationError(429, "QUEUE_FULL", "待分析队列已满，请稍后重试");
			let workId = input.workItemId;
			let settings = options.settings ?? current.settings;
			if (workId) {
				const rows = await txRows(
					tx,
					`select w.* from orchestration_work_items w join orchestration_subscriptions s on s.work_item_id=w.id
				where w.tenant_id=$1 and w.integration_id=$2 and w.id=$3 and s.alarm_id=$4 for update of w`,
					this.tenantId,
					i.id,
					workId,
					input.alarmId,
				);
				if (!rows[0]) throw notFound();
				if (rows[0].origin === "aaas")
					throw new OrchestrationError(409, "RUN_IMMUTABLE", "Run 不接受补充输入，请创建新 Run");
				if (rows[0].state === "cancelled") throw notFound();
				settings = settingsSchema.parse(rows[0].settings);
			} else {
				workId = randomUUID();
				const principalId = randomUUID(),
					conversationId = randomUUID();
				await txRows(
					tx,
					`insert into principals(id,tenant_id,published_app_id,principal_type,subject_hash,status,integration_id)
				values ($1,$2,$3,'service',$4,'active',$5)`,
					principalId,
					this.tenantId,
					current.appId,
					credentialHash(`orchestration:${i.id}:${workId}`),
					current.configurationId ? i.id : null,
				);
				await txRows(
					tx,
					`insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,title,status,source,integration_id,configuration_id,orchestration_version_id)
				values ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10)`,
					conversationId,
					this.tenantId,
					current.appId,
					configurationId ? null : versionId,
					principalId,
					`告警 ${input.alarmId}`,
					configurationId ? "orchestration" : "chat",
					configurationId ? i.id : null,
					configurationId,
					configurationId ? versionId : null,
				);
				await txRows(
					tx,
					`insert into orchestration_work_items(id,tenant_id,integration_id,alarm_id,state,configuration_revision,published_app_version_id,settings,principal_id,conversation_id,origin,task_prompt,configuration_id,orchestration_version_id,request_contract,request_hash_version,key_id,task_id,capability_snapshot,capability_snapshot_hash)
					values ($1,$2,$3,$4,'queued',$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,2,$15,$16,$17::jsonb,$18)`,
					workId,
					this.tenantId,
					i.id,
					input.alarmId,
					current.revision,
					configurationId ? null : versionId,
					settings,
					principalId,
					conversationId,
					origin,
					options.taskPrompt ?? null,
					configurationId,
					configurationId ? versionId : null,
					options.requestContract ?? "orchestration_event",
					options.keyId ?? null,
					options.taskId ?? null,
					options.capabilitySnapshot ?? null,
					options.capabilitySnapshotHash ?? null,
				);
				await txRows(
					tx,
					"update orchestration_work_items set external_ref_type=$2,external_ref_id=$3,metadata=$4::jsonb where id=$1",
					workId,
					options.externalRef?.type ?? null,
					options.externalRef?.id ?? null,
					options.metadata ?? null,
				);
				await txRows(
					tx,
					"insert into orchestration_subscriptions values ($1,$2,$3,$4)",
					this.tenantId,
					i.id,
					input.alarmId,
					workId,
				);
			}
			// New-Key Runs carry server/tool-scoped credentials validated by the V1
			// contract before acceptance; the legacy flat settings.bindings check applies
			// only to historical Integration Runs.
			if (options.keyId === undefined) {
				for (const binding of settings.bindings)
					if (!input.credentials[binding.credential])
						throw new OrchestrationError(400, "MISSING_CREDENTIAL", "缺少工具所需的任务凭据");
				const allowed = new Set(settings.bindings.map((b) => b.credential));
				if (Object.keys(input.credentials).some((key) => !allowed.has(key)))
					throw new OrchestrationError(400, "UNKNOWN_CREDENTIAL", "请求包含未配置的凭据名称");
			}
			const eventId = randomUUID(),
				credentialId = randomUUID(),
				assignmentId = randomUUID(),
				turnId = randomUUID();
			await txRows(
				tx,
				`insert into orchestration_events(id,tenant_id,integration_id,event_id,alarm_id,input,request_hash,work_item_id,request_hash_version)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,2)`,
				eventId,
				this.tenantId,
				i.id,
				input.eventId,
				input.alarmId,
				input.input,
				hash,
				workId,
			);
			// New-Key Runs seal every credential under its own
			// (tenant,key,run,assignment,server,tool) scope; legacy Runs keep their
			// historical single blob and scope so existing sealed rows stay decryptable.
			const sealed = options.keyId
				? this.sealRunCredentials({
						keyId: options.keyId,
						workId,
						assignmentId,
						settings,
						credentials: input.credentials,
						snapshot: options.capabilitySnapshot,
					})
				: this.box.seal(`${this.tenantId}:${i.id}:${workId}:${credentialId}`, input.credentials);
			await txRows(
				tx,
				`insert into orchestration_credentials values ($1,$2,$3,$4,$5::jsonb,$6)`,
				credentialId,
				this.tenantId,
				i.id,
				workId,
				sealed,
				expires,
			);
			await txRows(
				tx,
				`insert into orchestration_assignments(id,tenant_id,integration_id,work_item_id,event_id,credential_id,state,turn_id)
			 values ($1,$2,$3,$4,$5,$6,'queued',$7)`,
				assignmentId,
				this.tenantId,
				i.id,
				workId,
				eventId,
				credentialId,
				turnId,
			);
			await txRows(
				tx,
				"update orchestration_work_items set state=case when state='running' then state else 'queued' end,updated_at=now() where id=$1",
				workId,
			);
			return { workItemId: workId, duplicate: false };
		};
		return outerTx ? execute(outerTx) : this.client.transaction(execute);
	}

	/**
	 * New-Key Runs seal every credential under its own
	 * (tenant,key,run,assignment,server,tool) scope: a Server connection can only open
	 * its own connection credential and a Tool only the parameters mapped to it.
	 */
	private sealRunCredentials(input: {
		readonly keyId: string;
		readonly workId: string;
		readonly assignmentId: string;
		readonly settings: OrchestrationSettings;
		readonly credentials: Readonly<Record<string, string>>;
		readonly snapshot: unknown;
	}): WorkCredentialSet {
		const bindings = input.settings.bindings;
		const platformIds = new Map<string, string | null>();
		const platformUses = new Map<string, number>();
		for (const binding of bindings) {
			const platform = platformCredentialId(input.snapshot, binding);
			platformIds.set(binding.credential, platform);
			// Only parameters of the same (Server, Tool) share a scope, so the platform
			// credential id has to be unique inside that group.
			if (platform !== null) {
				const group = `${binding.mcpServerId}\u0000${binding.toolName}\u0000${platform}`;
				platformUses.set(group, (platformUses.get(group) ?? 0) + 1);
			}
		}
		const dimensions = new Map<string, CredentialDimension>();
		for (const binding of bindings) {
			const platform = platformIds.get(binding.credential) ?? null;
			// A platform credential id shared by several parameters of one tool cannot
			// identify one value; the Run-local credential name keeps every scope unique.
			const group = `${binding.mcpServerId}\u0000${binding.toolName}\u0000${platform ?? ""}`;
			const credentialId = platform !== null && (platformUses.get(group) ?? 0) === 1 ? platform : binding.credential;
			dimensions.set(binding.credential, {
				kind: "tool",
				serverId: binding.mcpServerId,
				toolName: binding.toolName,
				credentialId,
			});
		}
		const planned = Object.entries(input.credentials).map(([name, value]) => {
			const dimension = dimensions.get(name) ?? connectionDimension(name);
			if (!dimension) throw new OrchestrationError(400, "INVALID_CREDENTIAL", "凭据缺少 Server 或 Tool 归属");
			const scope = dimensionScope({
				tenantId: this.tenantId,
				keyId: input.keyId,
				workId: input.workId,
				assignmentId: input.assignmentId,
				dimension,
			});
			return { name, dimension, scope, value };
		});
		const sealed = this.box.sealMany(planned.map((entry) => ({ scope: entry.scope, value: entry.value })));
		return {
			version: 2,
			entries: planned.map((entry, index) => ({
				name: entry.name,
				dimension: entry.dimension,
				scope: entry.scope,
				sealed: sealed[index]!.sealed,
			})),
		};
	}

	/** Server-side filter over the newest 100 work items; archive still lives in the business system. */
	async listWorkItems(
		integrationId?: string,
		alarmId?: string,
		filter: { state?: string; query?: string; externalRefType?: string } = {},
	): Promise<readonly AnalysisWorkItem[]> {
		const rows = await this.client.run(
			`select id from orchestration_work_items where tenant_id=$1 and key_id is null
		and ($2::uuid is null or integration_id=$2) and ($3::text is null or alarm_id=$3)
		and ($4::text is null or state=$4)
		and ($5::text is null or position(lower($5) in lower(alarm_id))>0
			or position(lower($5) in lower(coalesce(external_ref_id,'')))>0 or position(lower($5) in id::text)>0
			or position(lower($5) in 'conv_' || conversation_id::text)>0)
		and ($6::text is null or external_ref_type=$6)
		order by created_at desc,id desc limit 100`,
			this.tenantId,
			integrationId ?? null,
			alarmId ?? null,
			filter.state ?? null,
			filter.query?.trim() ? filter.query.trim() : null,
			filter.externalRefType ?? null,
		);
		return Promise.all(rows.map((row) => this.workItem(String(row.id), integrationId)));
	}

	async workItem(id: string, integrationId?: string): Promise<AnalysisWorkItem> {
		const rows = await this.client.run(
			`select * from orchestration_work_items where tenant_id=$1 and id=$2 and key_id is null
		and ($3::uuid is null or integration_id=$3)`,
			this.tenantId,
			id,
			integrationId ?? null,
		);
		const row = rows[0];
		if (!row) throw notFound();
		const attempts = await this.client.run(
			`select a.*,e.event_id as external_event_id from orchestration_assignments a
		join orchestration_events e on e.id=a.event_id where a.tenant_id=$1 and a.work_item_id=$2 order by a.created_at,a.id`,
			this.tenantId,
			id,
		);
		const assignments: AnalysisAssignmentView[] = attempts.map((a) => ({
			id: String(a.id),
			eventId: String(a.external_event_id),
			state: a.state as AnalysisAssignmentView["state"],
			turnId: String(a.turn_id),
			report: a.report === null ? null : String(a.report),
			error: a.error === null ? null : String(a.error),
			createdAt: (a.created_at as Date).toISOString(),
		}));
		const latest = assignments.filter((a) => a.report !== null).at(-1);
		const configurationId = row.configuration_id ? String(row.configuration_id) : null;
		const frozenVersionId = row.orchestration_version_id
			? String(row.orchestration_version_id)
			: row.published_app_version_id
				? String(row.published_app_version_id)
				: null;
		return {
			id,
			origin: row.origin as AnalysisWorkItem["origin"],
			integrationId: String(row.integration_id),
			alarmId: String(row.alarm_id),
			state: row.state as AnalysisWorkItem["state"],
			configurationRevision: Number(row.configuration_revision),
			versionId: versionKey(configurationId, frozenVersionId),
			externalRef: row.external_ref_id
				? {
						...(row.external_ref_type ? { type: String(row.external_ref_type) } : {}),
						id: String(row.external_ref_id),
					}
				: null,
			requestContract: row.request_contract ? String(row.request_contract) : null,
			conversationId: `conv_${String(row.conversation_id)}`,
			createdAt: (row.created_at as Date).toISOString(),
			updatedAt: (row.updated_at as Date).toISOString(),
			assignments,
			report: latest?.report ?? null,
			reportEventId: latest?.eventId ?? null,
		};
	}

	/** A single SQL snapshot of the original execution, never the work's latest successful report. */
	async run(id: string, integrationId: string): Promise<AaasRun> {
		const rows = await this.client.run(
			`select w.id,w.integration_id,w.external_ref_type,w.external_ref_id,w.metadata,w.published_app_version_id,w.orchestration_version_id,w.configuration_revision,w.created_at,
		 a.state,a.report,a.error,a.started_at,a.ended_at
		 from orchestration_work_items w join lateral (
		 select * from orchestration_assignments where work_item_id=w.id and tenant_id=w.tenant_id order by created_at,id limit 1
		 ) a on true where w.tenant_id=$1 and w.integration_id=$2 and w.id=$3 and w.origin='aaas' and w.key_id is null`,
			this.tenantId,
			integrationId,
			id,
		);
		const row = rows[0];
		if (!row) throw notFound();
		const state = row.state as AnalysisWorkItem["state"];
		return {
			run_id: id,
			integration_id: integrationId,
			external_ref:
				row.external_ref_id === null
					? null
					: {
							...(row.external_ref_type === null ? {} : { type: String(row.external_ref_type) }),
							id: String(row.external_ref_id),
						},
			metadata: row.metadata as Record<string, unknown> | null,
			agent_version: row.orchestration_version_id
				? `orv_${String(row.orchestration_version_id)}`
				: `pav_${String(row.published_app_version_id)}`,
			configuration_revision: Number(row.configuration_revision),
			status: state === "succeeded" ? "completed" : state,
			result: state === "succeeded" && row.report !== null ? String(row.report) : null,
			error: row.error ? { code: String(row.error) } : null,
			created_at: (row.created_at as Date).toISOString(),
			started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
			completed_at: row.ended_at ? (row.ended_at as Date).toISOString() : null,
		};
	}

	async claim(legacyOnly = false): Promise<ClaimedAssignment | undefined> {
		return this.client.transaction(async (tx) => {
			const rows = await txRows(
				tx,
				`select a.id from orchestration_assignments a
			join orchestration_work_items w on w.id=a.work_item_id join orchestration_integrations i on i.id=a.integration_id
			join orchestration_events e on e.id=a.event_id
			where a.tenant_id=$1 and a.state='queued' and w.state not in ('cancelled','failed') and i.enabled=true
			and (not $2::boolean or (w.key_id is null and i.kind='legacy'))
			and not exists(select 1 from orchestration_assignments active where active.work_item_id=a.work_item_id and active.state='running')
			order by e.created_at,e.id,a.created_at,a.id limit 1 for update of w skip locked`,
				this.tenantId,
				legacyOnly,
			);
			if (!rows[0]) return undefined;
			const id = String(rows[0].id);
			await txRows(tx, "update orchestration_assignments set state='running',started_at=now() where id=$1", id);
			const detail = await txRows(
				tx,
				`select a.*,w.conversation_id,w.principal_id,w.published_app_version_id,w.orchestration_version_id,w.configuration_id,w.request_contract,c.published_app_id,w.settings,e.input
			from orchestration_assignments a join orchestration_work_items w on w.id=a.work_item_id join orchestration_events e on e.id=a.event_id join conversations c on c.id=w.conversation_id and c.tenant_id=w.tenant_id where a.id=$1`,
				id,
			);
			const r = detail[0]!;
			await txRows(
				tx,
				"update orchestration_work_items set state='running',updated_at=now() where id=$1",
				String(r.work_item_id),
			);
			return {
				id,
				workItemId: String(r.work_item_id),
				integrationId: String(r.integration_id),
				eventId: String(r.event_id),
				input: String(r.input),
				conversationId: String(r.conversation_id),
				principalId: String(r.principal_id),
				versionId: String(r.orchestration_version_id ?? r.published_app_version_id),
				configurationId: r.configuration_id ? String(r.configuration_id) : null,
				appId: r.published_app_id ? String(r.published_app_id) : null,
				requestContract: String(r.request_contract),
				turnId: String(r.turn_id),
				settings: settingsSchema.parse(r.settings),
			};
		});
	}

	/**
	 * The running assignment owns the Run secrets. The full set is resolved for the
	 * trusted inspector only; a Server or a Tool receives its own dimension through
	 * the narrow accessors, which open only the matching sealed value.
	 */
	async credentials(conversationId: string, turnId: string): Promise<RunCredentials> {
		const rows = await this.client.run(
			`select c.*,w.settings,w.key_id,w.id as work_id,a.id as assignment_id,(c.expires_at <= now()) as expired
		 from orchestration_credentials c
		join orchestration_assignments a on a.credential_id=c.id join orchestration_work_items w on w.id=a.work_item_id
		join orchestration_integrations i on i.id=a.integration_id
		where c.tenant_id=$1 and w.conversation_id=$2 and a.turn_id=$3 and a.state='running' and w.state='running' and i.enabled=true`,
			this.tenantId,
			conversationId,
			turnId,
		);
		const r = rows[0];
		if (!r) throw new OrchestrationError(403, "CREDENTIAL_UNAVAILABLE", "任务凭据不可用");
		// Compare with the database clock, which is also what expires the row.
		if (r.expired === true) throw credentialExpired();
		// The dispatcher's expiry sweep wipes the ciphertext but keeps the row. A
		// wiped row is an expired credential, never an ordinary missing value; the
		// app clock must not turn it into a generic decryption/parse failure.
		const sealedValue = r.sealed;
		if (
			typeof sealedValue === "object" &&
			sealedValue !== null &&
			!Array.isArray(sealedValue) &&
			Object.keys(sealedValue).length === 0
		)
			throw credentialExpired();
		const keyId = r.key_id === null ? null : String(r.key_id);
		const settings = settingsSchema.parse(r.settings);
		const workId = String(r.work_id);
		const assignmentId = String(r.assignment_id);
		const integrationId = String(r.integration_id);
		const credentialId = String(r.id);
		// Legacy Runs keep one sealed blob under their historical scope; a new-Key row
		// sealed before the per-dimension format keeps its previous single-blob scope.
		const set = keyId === null ? null : parseWorkCredentialSet(r.sealed);
		const legacyValues = (): Readonly<Record<string, string>> =>
			this.box.open(
				keyId === null
					? `${this.tenantId}:${integrationId}:${workId}:${credentialId}`
					: `${this.tenantId}:${keyId}:${integrationId}:${workId}:${credentialId}`,
				r.sealed,
			);
		const scoped = (set?.entries ?? []).map((entry) => ({ scope: entry.scope, sealed: entry.sealed }));
		const openEntry = (entry: WorkCredentialEntry): string => {
			if (keyId === null) throw new OrchestrationError(403, "CREDENTIAL_SCOPE_MISMATCH", "凭据作用域不匹配");
			const scope = dimensionScope({
				tenantId: this.tenantId,
				keyId,
				workId,
				assignmentId,
				dimension: entry.dimension,
			});
			if (scope !== entry.scope) throw new OrchestrationError(403, "CREDENTIAL_SCOPE_MISMATCH", "凭据作用域不匹配");
			// Only the value sealed under this exact scope opens.
			return this.box.openMany(scope, scoped);
		};
		let resolved: Record<string, string> | undefined;
		const values = (): Record<string, string> => {
			if (resolved) return resolved;
			if (set === null) {
				resolved = { ...legacyValues() };
				return resolved;
			}
			const all: Record<string, string> = {};
			for (const entry of set.entries) all[entry.name] = openEntry(entry);
			resolved = all;
			return resolved;
		};
		const connectionCredential = (serverId: string): string | undefined => {
			if (set === null) return values()[`srv:${serverId}:connection`];
			for (const entry of set.entries)
				if (entry.dimension.kind === "connection" && entry.dimension.serverId === serverId) return openEntry(entry);
			return undefined;
		};
		const toolValues = (
			serverId: string,
			toolName: string,
			credentialNames?: readonly string[],
		): Readonly<Record<string, string>> => {
			const mapped = settings.bindings
				.filter((binding) => binding.mcpServerId === serverId && binding.toolName === toolName)
				.map((binding) => binding.credential);
			const wanted = new Set(
				credentialNames === undefined ? mapped : mapped.filter((name) => credentialNames.includes(name)),
			);
			const selected: Record<string, string> = {};
			if (set === null) {
				const legacy = values();
				for (const name of wanted) {
					const value = legacy[name];
					if (value !== undefined) selected[name] = value;
				}
				return selected;
			}
			for (const entry of set.entries) {
				if (entry.dimension.kind !== "tool") continue;
				if (entry.dimension.serverId !== serverId || entry.dimension.toolName !== toolName) continue;
				if (!wanted.has(entry.name)) continue;
				selected[entry.name] = openEntry(entry);
			}
			return selected;
		};
		return {
			keyId,
			settings,
			get values() {
				return values();
			},
			connectionCredential,
			toolValues,
		};
	}

	/** Only the exact active assignment can resolve its frozen per-Run system prompt. */
	async taskPrompt(conversationId: string, turnId: string): Promise<string | null> {
		const rows = await this.client.run(
			`select w.task_prompt,w.key_id,w.integration_id from orchestration_work_items w
			join orchestration_assignments a on a.tenant_id=w.tenant_id and a.work_item_id=w.id
			where w.tenant_id=$1 and w.conversation_id=$2 and a.turn_id=$3 and a.state='running' and w.state='running'`,
			this.tenantId,
			conversationId,
			turnId,
		);
		if (!rows[0]) throw new OrchestrationError(403, "TASK_UNAVAILABLE", "任务执行上下文不可用");
		await this.assertRunOwnership(rows[0]);
		return rows[0].task_prompt === null ? null : String(rows[0].task_prompt);
	}

	/**
	 * Only the Run that is currently executing resolves its bindings, and a Key-owned
	 * Run must still resolve to its own carrier. A Run that is not executing and an
	 * ownership mismatch are hard failures: a silently empty binding would run the
	 * tool without its credential.
	 */
	async toolBindings(conversationId: string, turnId?: string) {
		const rows = await this.client.run(
			`select w.settings,w.key_id,w.integration_id,w.state,a.state as assignment_state from orchestration_work_items w
			left join orchestration_assignments a on a.tenant_id=w.tenant_id and a.work_item_id=w.id and a.state='running'
			and ($3::uuid is null or a.turn_id=$3::uuid)
			where w.tenant_id=$1 and w.conversation_id=$2`,
			this.tenantId,
			conversationId,
			turnId ?? null,
		);
		// No Run owns this conversation: there is no credential to bind.
		if (!rows[0]) return [];
		if (rows[0].assignment_state !== "running" || rows[0].state !== "running")
			throw new OrchestrationError(403, "TASK_UNAVAILABLE", "任务执行上下文不可用");
		await this.assertRunOwnership(rows[0]);
		return settingsSchema.parse(rows[0].settings).bindings;
	}

	/**
	 * A Key-owned Run is only executed by the carrier of that Key. Legacy Runs keep
	 * their historical behaviour and are not filtered.
	 */
	private async assertRunOwnership(row: Record<string, unknown>): Promise<void> {
		const keyId = row.key_id === null || row.key_id === undefined ? null : String(row.key_id);
		if (keyId === null) return;
		const carriers = await this.client.run(
			`select 1 from aaas_key_carriers where tenant_id=$1 and key_id=$2 and carrier_integration_id=$3`,
			this.tenantId,
			keyId,
			String(row.integration_id),
		);
		if (carriers.length === 0)
			throw new OrchestrationError(403, "RUN_OWNERSHIP_MISMATCH", "任务归属与 Key 载体不一致");
	}

	async complete(id: string, report: string | null, error: string | null) {
		await this.client.transaction(async (tx) => {
			// All lifecycle mutations lock work before assignments (also cancel/claim/retry).
			await txRows(
				tx,
				`select w.id from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id
			where a.tenant_id=$1 and a.id=$2 for update of w`,
				this.tenantId,
				id,
			);
			const rows = await txRows(
				tx,
				`update orchestration_assignments set
			state=case when error in ('MCP_RESULT_BLOCKED','MCP_AUTH_FAILED','CREDENTIAL_EXPIRED') then 'failed' else $3 end,
			report=case when error in ('MCP_RESULT_BLOCKED','MCP_AUTH_FAILED','CREDENTIAL_EXPIRED') then null else $4 end,
			error=case when error in ('MCP_RESULT_BLOCKED','MCP_AUTH_FAILED','CREDENTIAL_EXPIRED') then error else $5 end,ended_at=now()
			where tenant_id=$1 and id=$2 and state='running' returning work_item_id,error`,
				this.tenantId,
				id,
				error ? "failed" : "succeeded",
				report,
				error,
			);
			if (!rows[0]) return;
			await txRows(
				tx,
				`update orchestration_work_items w set state=case when $3::text is not null then 'failed'
			when exists(select 1 from orchestration_assignments a where a.work_item_id=w.id and a.state='queued') then 'queued' else 'succeeded' end,
			updated_at=now() where tenant_id=$1 and id=$2 and state<>'cancelled'`,
				this.tenantId,
				String(rows[0].work_item_id),
				rows[0].error === null ? null : String(rows[0].error),
			);
		});
	}

	async cancel(id: string, integrationId?: string) {
		const item = await this.workItem(id, integrationId);
		await this.client.transaction(async (tx) => {
			const locked = await txRows(
				tx,
				"select origin,state from orchestration_work_items where tenant_id=$1 and id=$2 for update",
				this.tenantId,
				id,
			);
			if (locked[0]?.origin === "aaas" && !["queued", "running"].includes(String(locked[0].state))) return;
			await txRows(
				tx,
				"update orchestration_work_items set state='cancelled',updated_at=now() where tenant_id=$1 and id=$2",
				this.tenantId,
				id,
			);
			await txRows(
				tx,
				"update orchestration_assignments set state='cancelled',ended_at=now() where tenant_id=$1 and work_item_id=$2 and state in ('queued','running')",
				this.tenantId,
				id,
			);
		});
		return item;
	}

	async retry(id: string, integrationId?: string) {
		await this.workItem(id, integrationId);
		await this.client.transaction(async (tx) => {
			const work = await txRows(
				tx,
				"select state,origin from orchestration_work_items where tenant_id=$1 and id=$2 for update",
				this.tenantId,
				id,
			);
			if (work[0]?.origin === "aaas")
				throw new OrchestrationError(409, "RUN_IMMUTABLE", "Run 不支持原地重试，请创建新 Run");
			if (work[0]?.state !== "failed") throw new OrchestrationError(409, "NOT_RETRYABLE", "只有失败工作项可以重试");
			const failed = await txRows(
				tx,
				"select * from orchestration_assignments where tenant_id=$1 and work_item_id=$2 and state='failed' order by created_at desc,id desc limit 1",
				this.tenantId,
				id,
			);
			const f = failed[0];
			if (!f) throw notFound();
			const credential = await txRows(
				tx,
				"select expires_at from orchestration_credentials where id=$1",
				String(f.credential_id),
			);
			if (!credential[0] || (credential[0].expires_at as Date).getTime() <= Date.now())
				throw new OrchestrationError(409, "CREDENTIAL_EXPIRED", "请提交带有效凭据的新补充事件");
			await txRows(
				tx,
				`insert into orchestration_assignments(id,tenant_id,integration_id,work_item_id,event_id,credential_id,state,turn_id)
			values ($1,$2,$3,$4,$5,$6,'queued',$7)`,
				randomUUID(),
				this.tenantId,
				String(f.integration_id),
				id,
				String(f.event_id),
				String(f.credential_id),
				randomUUID(),
			);
			await txRows(
				tx,
				"update orchestration_work_items set state='queued',updated_at=now() where tenant_id=$1 and id=$2",
				this.tenantId,
				id,
			);
		});
	}
}

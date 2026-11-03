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
import { OrchestrationConfigurationRepository, type PreparedOrchestrationVersion } from "./configuration-domain.ts";
import { OrchestrationError, type OrchestrationSettings, settingsSchema } from "./contracts.ts";
import { credentialHash, type WorkCredentialBox } from "./credentials.ts";

export interface IntegrationRecord {
	id: string;
	tenantId: string;
	appId: string | null;
	versionId: string;
	configurationId: string | null;
	revision: number;
	name: string;
	enabled: boolean;
	settings: OrchestrationSettings;
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

function integration(row: Record<string, unknown>): IntegrationRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		appId: row.published_app_id === null ? null : String(row.published_app_id),
		configurationId: row.configuration_id ? String(row.configuration_id) : null,
		versionId: String(row.orchestration_version_id ?? row.published_app_version_id),
		revision: Number(row.revision),
		name: String(row.name),
		enabled: row.enabled === true,
		settings: settingsSchema.parse(row.settings),
	};
}

const notFound = () => new OrchestrationError(404, "NOT_FOUND", "接入或工作项不存在");

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

	async getIntegration(id: string, tx?: TransactionSql): Promise<IntegrationRecord> {
		const query = "select * from orchestration_integrations where tenant_id=$1 and id=$2";
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
			"select * from orchestration_integrations where tenant_id=$1 and id=$2",
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
			`select i.*,a.public_app_id from orchestration_integrations i left join published_apps a
		 on a.id=i.published_app_id and a.tenant_id=i.tenant_id where i.tenant_id=$1 order by i.created_at desc`,
			this.tenantId,
		);
		return rows.map((row) => {
			const i = integration(row);
			return {
				id: i.id,
				name: i.name,
				publicAppId: row.public_app_id ? String(row.public_app_id) : "",
				configurationId: i.configurationId,
				configurationSource: i.configurationId ? "orchestration" : "legacy_orchestration",
				enabled: i.enabled,
				revision: i.revision,
				versionId: i.versionId,
				allowedModels: i.settings.allowedModels,
				bindings: i.settings.bindings,
			};
		});
	}

	async updateAccess(id: string, action: "enable" | "disable" | "rotate") {
		await this.getIntegration(id);
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

	async accept(
		i: IntegrationRecord,
		input: AnalysisEventRequest,
		options: {
			origin?: "orchestration" | "aaas";
			requestHash?: string;
			legacyRequestHash?: string;
			taskPrompt?: string;
			requestContract?: "input_v1" | "legacy_prompt";
		} = {},
	) {
		const origin = options.origin ?? "orchestration";
		if (origin === "aaas" && input.workItemId)
			throw new OrchestrationError(400, "INVALID_REQUEST", "Run 不接受已有工作项");
		const expires = new Date(input.credentialExpiresAt);
		return this.client.transaction(async (tx) => {
			const current = await this.getIntegration(i.id, tx);
			if (!current.enabled) throw new OrchestrationError(403, "DISABLED", "接入已停用");
			if (current.configurationId) {
				const configuration = await txRows(
					tx,
					"select 1 from orchestration_configurations where tenant_id=$1 and id=$2 and enabled=true",
					this.tenantId,
					current.configurationId,
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
			let settings = current.settings;
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
					current.configurationId ? null : current.versionId,
					principalId,
					`告警 ${input.alarmId}`,
					current.configurationId ? "orchestration" : "chat",
					current.configurationId ? i.id : null,
					current.configurationId,
					current.configurationId ? current.versionId : null,
				);
				await txRows(
					tx,
					`insert into orchestration_work_items(id,tenant_id,integration_id,alarm_id,state,configuration_revision,published_app_version_id,settings,principal_id,conversation_id,origin,task_prompt,configuration_id,orchestration_version_id,request_contract,request_hash_version)
					values ($1,$2,$3,$4,'queued',$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,2)`,
					workId,
					this.tenantId,
					i.id,
					input.alarmId,
					current.revision,
					current.configurationId ? null : current.versionId,
					settings,
					principalId,
					conversationId,
					origin,
					options.taskPrompt ?? null,
					current.configurationId,
					current.configurationId ? current.versionId : null,
					options.requestContract ?? "orchestration_event",
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
			for (const binding of settings.bindings)
				if (!input.credentials[binding.credential])
					throw new OrchestrationError(400, "MISSING_CREDENTIAL", "缺少工具所需的任务凭据");
			const allowed = new Set(settings.bindings.map((b) => b.credential));
			if (Object.keys(input.credentials).some((key) => !allowed.has(key)))
				throw new OrchestrationError(400, "UNKNOWN_CREDENTIAL", "请求包含未配置的凭据名称");
			const eventId = randomUUID(),
				credentialId = randomUUID();
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
			await txRows(
				tx,
				`insert into orchestration_credentials values ($1,$2,$3,$4,$5::jsonb,$6)`,
				credentialId,
				this.tenantId,
				i.id,
				workId,
				this.box.seal(`${this.tenantId}:${i.id}:${workId}:${credentialId}`, input.credentials),
				expires,
			);
			await txRows(
				tx,
				`insert into orchestration_assignments(id,tenant_id,integration_id,work_item_id,event_id,credential_id,state,turn_id)
			 values ($1,$2,$3,$4,$5,$6,'queued',$7)`,
				randomUUID(),
				this.tenantId,
				i.id,
				workId,
				eventId,
				credentialId,
				randomUUID(),
			);
			await txRows(
				tx,
				"update orchestration_work_items set state=case when state='running' then state else 'queued' end,updated_at=now() where id=$1",
				workId,
			);
			return { workItemId: workId, duplicate: false };
		});
	}

	async listWorkItems(integrationId?: string, alarmId?: string): Promise<readonly AnalysisWorkItem[]> {
		const rows = await this.client.run(
			`select id from orchestration_work_items where tenant_id=$1
		and ($2::uuid is null or integration_id=$2) and ($3::text is null or alarm_id=$3) order by created_at desc,id desc limit 100`,
			this.tenantId,
			integrationId ?? null,
			alarmId ?? null,
		);
		return Promise.all(rows.map((row) => this.workItem(String(row.id), integrationId)));
	}

	async workItem(id: string, integrationId?: string): Promise<AnalysisWorkItem> {
		const rows = await this.client.run(
			`select * from orchestration_work_items where tenant_id=$1 and id=$2
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
		return {
			id,
			origin: row.origin as AnalysisWorkItem["origin"],
			integrationId: String(row.integration_id),
			alarmId: String(row.alarm_id),
			state: row.state as AnalysisWorkItem["state"],
			configurationRevision: Number(row.configuration_revision),
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
			`select w.id,w.integration_id,w.published_app_version_id,w.orchestration_version_id,w.configuration_revision,w.created_at,
		 a.state,a.report,a.error,a.started_at,a.ended_at
		 from orchestration_work_items w join lateral (
		 select * from orchestration_assignments where work_item_id=w.id and tenant_id=w.tenant_id order by created_at,id limit 1
		 ) a on true where w.tenant_id=$1 and w.integration_id=$2 and w.id=$3 and w.origin='aaas'`,
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

	async claim(): Promise<ClaimedAssignment | undefined> {
		return this.client.transaction(async (tx) => {
			const rows = await txRows(
				tx,
				`select a.id from orchestration_assignments a
			join orchestration_work_items w on w.id=a.work_item_id join orchestration_integrations i on i.id=a.integration_id
			join orchestration_events e on e.id=a.event_id
			where a.tenant_id=$1 and a.state='queued' and w.state not in ('cancelled','failed') and i.enabled=true
			and not exists(select 1 from orchestration_assignments active where active.work_item_id=a.work_item_id and active.state='running')
			order by e.created_at,e.id,a.created_at,a.id limit 1 for update of w skip locked`,
				this.tenantId,
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

	async credentials(conversationId: string, turnId: string) {
		const rows = await this.client.run(
			`select c.*,w.settings from orchestration_credentials c
		join orchestration_assignments a on a.credential_id=c.id join orchestration_work_items w on w.id=a.work_item_id
		join orchestration_integrations i on i.id=a.integration_id
		where c.tenant_id=$1 and w.conversation_id=$2 and a.turn_id=$3 and a.state='running' and w.state='running' and i.enabled=true`,
			this.tenantId,
			conversationId,
			turnId,
		);
		const r = rows[0];
		if (!r) throw new OrchestrationError(403, "CREDENTIAL_UNAVAILABLE", "任务凭据不可用");
		if ((r.expires_at as Date).getTime() <= Date.now())
			throw new OrchestrationError(401, "CREDENTIAL_EXPIRED", "任务凭据已过期");
		return {
			values: this.box.open(
				`${this.tenantId}:${String(r.integration_id)}:${String(r.work_item_id)}:${String(r.id)}`,
				r.sealed,
			),
			settings: settingsSchema.parse(r.settings),
		};
	}

	/** Only the exact active assignment can resolve its frozen per-Run system prompt. */
	async taskPrompt(conversationId: string, turnId: string): Promise<string | null> {
		const rows = await this.client.run(
			`select w.task_prompt from orchestration_work_items w
			join orchestration_assignments a on a.tenant_id=w.tenant_id and a.work_item_id=w.id
			where w.tenant_id=$1 and w.conversation_id=$2 and a.turn_id=$3 and a.state='running' and w.state='running'`,
			this.tenantId,
			conversationId,
			turnId,
		);
		if (!rows[0]) throw new OrchestrationError(403, "TASK_UNAVAILABLE", "任务执行上下文不可用");
		return rows[0].task_prompt === null ? null : String(rows[0].task_prompt);
	}

	async toolBindings(conversationId: string) {
		const rows = await this.client.run(
			"select settings from orchestration_work_items where tenant_id=$1 and conversation_id=$2",
			this.tenantId,
			conversationId,
		);
		return rows[0] ? settingsSchema.parse(rows[0].settings).bindings : [];
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
				`update orchestration_assignments set state=$3,report=$4,error=$5,ended_at=now()
			where tenant_id=$1 and id=$2 and state='running' returning work_item_id`,
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
				error,
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

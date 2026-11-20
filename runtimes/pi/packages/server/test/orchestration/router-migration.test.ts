/**
 * Router V1 phase-1 migration gate on an isolated PostgreSQL database.
 *
 * Creates a throwaway database, applies the pre-Router baseline (0001..0034),
 * seeds representative legacy Chat, Integration and Key-owned Run records through
 * the current service paths, then applies Router migrations and checks upgrade compatibility
 * plus database invariants. Skipped (NOT RUN) when no test PostgreSQL is reachable.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createRun } from "../../src/orchestration/aaas.ts";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { settingsSchema } from "../../src/orchestration/contracts.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { orchestrationExecutionConfigResolver } from "../../src/orchestration/execution-configuration.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import type {
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	TenantId,
} from "../../src/publishing/domain/ids.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { LlmCallTrace } from "../../src/types.ts";

const ADMIN_URL = process.env.PI_ROUTER_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const DATABASE = `router_v1_${process.pid}_${Date.now().toString(36)}`;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../src/persistence/postgres/migrations/", import.meta.url));
const LEGACY_LAST = "0034_aaas_configuration_follow.sql";
const HASH = "a".repeat(64);
const masterKey = new Uint8Array(32).fill(17);
const tenantId = randomUUID();
const configurationId = randomUUID();
const versionId = randomUUID();
const otherTenantId = randomUUID();
const appId = randomUUID();
const chatVersionId = randomUUID();
const agentId = randomUUID();
const principalId = randomUUID();
const chatConversationId = randomUUID();

function databaseUrl(): string {
	const url = new URL(ADMIN_URL);
	url.pathname = `/${DATABASE}`;
	return url.toString();
}
async function adminClient(): Promise<PostgresClient> {
	return new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
}
async function probe(): Promise<boolean> {
	const admin = await adminClient();
	try {
		await admin.ping();
		return true;
	} catch {
		return false;
	} finally {
		await admin.close();
	}
}
const pgUp = await probe();

describe.skipIf(!pgUp)("Router V1 migration from the pre-Router baseline", () => {
	let client: PostgresClient;
	let repos: ReturnType<typeof createPublishingRepositories>;
	let baselineDir: string;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	let store: OrchestrationStore;
	let control: ControlService;
	let conversationsService: ConversationService;
	let httpServer: Server;
	let httpBase: string;
	let principalKeyId: string;
	let keyRunId: string;
	let conversationId: string;
	let turnId: string;
	let integrationId: string;
	let legacyToken: string;
	let legacyRunId: string;
	let mcpServerUuid: string;
	let auditId: string;
	let baseline: Record<string, readonly Record<string, unknown>[]>;
	let appliedBaseline: readonly string[];
	let appliedRouter: readonly string[];

	beforeAll(async () => {
		const admin = await adminClient();
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
			await admin.run(`create database ${DATABASE}`);
		} finally {
			await admin.close();
		}
		client = new PostgresClient({ url: databaseUrl(), connectTimeoutSeconds: 5 });
		baselineDir = mkdtempSync(join(tmpdir(), "router-v1-baseline-"));
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((file) => file.endsWith(".sql") && file <= LEGACY_LAST)
			.sort();
		for (const file of files) symlinkSync(join(MIGRATIONS_DIR, file), join(baselineDir, file));
		appliedBaseline = (await runMigrations(client, { migrationsDir: baselineDir })).applied;
		repos = createPublishingRepositories(client);

		await client.run("insert into tenants(id,name,status) values ($1,'router-legacy','active')", tenantId);
		await client.run("insert into tenants(id,name,status) values ($1,'router-other','active')", otherTenantId);
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'legacy-chat',1,$3::jsonb,$2)",
			agentId,
			tenantId,
			{ prompt: "legacy", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		await client.run(
			`insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by)
			 values ($1,$2,$3,$4,'legacy-chat','active','anonymous',$2)`,
			appId,
			tenantId,
			agentId,
			`pub_${appId}`,
		);
		const draft = {
			schemaVersion: 1,
			publishedAppVersionId: `orv_${versionId}`,
			agent: { systemPrompt: "legacy", model: { provider: "test", modelId: "test-model" } },
			capabilities: { mcpServers: [] },
			contextPolicy: {},
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		};
		const parsed = parseRuntimeSpec(draft);
		if (!parsed.ok) throw new Error(`invalid fixture spec: ${parsed.errors.join("; ")}`);
		const hash = sha256Hex(canonicalJson(parsed.spec));
		await client.run(
			`insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by)
			 values ($1,$2,$3,1,1,'{}',$4::jsonb,$5,'ready',$2)`,
			chatVersionId,
			tenantId,
			appId,
			parsed.spec,
			hash,
		);
		await client.run("update published_apps set current_version_id=$1 where id=$2", chatVersionId, appId);
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'legacy-platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,1,$5::jsonb,$6)`,
			versionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "legacy", parameters: {}, mcpServers: [], skills: [] },
			parsed.spec,
			hash,
		);

		await client.run(
			`insert into principals(id,tenant_id,published_app_id,principal_type,subject_hash,status)
			 values ($1,$2,$3,'external_user',$4,'active')`,
			principalId,
			tenantId,
			appId,
			HASH,
		);
		const chatRepository = repos.conversations;
		const nowDate = new Date();
		await chatRepository.insert({
			conversationId: chatConversationId as ConversationId,
			tenantId: tenantId as TenantId,
			publishedAppId: appId as PublishedAppId,
			publishedAppVersionId: chatVersionId as PublishedAppVersionId,
			ownerPrincipalId: principalId as PrincipalId,
			title: "legacy chat sample",
			status: "active",
			lastEventSequence: 0,
			eventCount: 0,
			eventBytes: 0,
			turnCount: 0,
			latestSummarySequence: 0,
			previousConversationId: null,
			nextConversationId: null,
			rolledOverAt: null,
			createdAt: nowDate,
			updatedAt: nowDate,
			lastActiveAt: nowDate,
			source: "chat",
		});
		const eventRepository = repos.events;
		await eventRepository.append(
			{
				tenantId: tenantId as TenantId,
				publishedAppId: appId as PublishedAppId,
				principalId: principalId as PrincipalId,
			},
			{
				conversationId: chatConversationId as ConversationId,
				eventType: "user.message",
				payload: { text: "legacy chat" },
			},
		);

		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(31));
		await keys.setPlatformConfiguration(configurationId, versionId, []);
		const createdKey = await keys.create("legacy-key");
		const keyPrincipal = await keys.authenticate(`Bearer ${createdKey.token}`);
		principalKeyId = keyPrincipal.keyId;
		store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey));
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos: {
				mcpServers: { list: async () => [], get: async () => undefined },
			} as unknown as ConstructorParameters<typeof ApiKeyRunService>[0]["repos"],
		});
		const keyRun = await runs.submit(keyPrincipal, "legacy-idem", { prompt: "legacy prompt", mcp_servers: [] });
		keyRunId = keyRun.run_id;

		const work = await client.run(
			"select conversation_id,integration_id from orchestration_work_items where id=$1",
			keyRunId,
		);
		conversationId = String(work[0]?.conversation_id);
		integrationId = String(work[0]?.integration_id);
		const assignment = await client.run(
			"select turn_id from orchestration_assignments where work_item_id=$1",
			keyRunId,
		);
		turnId = String(assignment[0]?.turn_id);
		await store.recordLlmTrace(conversationId, turnId, {
			kind: "request",
			callIndex: 1,
			model: { provider: "test", id: "test-model" },
			context: { origin: "legacy-baseline" },
		} as unknown as LlmCallTrace);

		const legacyIntegration = await store.createIntegration(
			appId,
			chatVersionId,
			"legacy-integration",
			settingsSchema.parse({ allowedModels: ["test-model"], bindings: [] }),
		);
		legacyToken = legacyIntegration.token;
		const oldRun = await createRun(store, await store.getLegacyIntegration(legacyIntegration.id), legacyToken, {
			input: { ticket_id: "TK-LEGACY" },
			external_ref: { type: "ticket", id: "TK-LEGACY" },
			credentials: {},
		});
		legacyRunId = oldRun.run_id;

		conversationsService = new ConversationService({
			repositories: repos,
			resolveExecutionConfiguration: orchestrationExecutionConfigResolver(store, repos),
			turnExecutor: async () => ({ ok: true, outputText: "legacy chat reply" }),
		});
		control = new ControlService({
			repositories: repos,
			catalog: { tools: [], knowledgeBases: [], models: [] },
			embedBaseUrl: "https://embed.test",
		});
		const orchestrationService = new OrchestrationService(store, control, repos, conversationsService);
		const handler = createOrchestrationHttp(
			orchestrationService,
			(request) => request.headers.authorization === "Bearer admin-test",
		);
		httpServer = createServer((request, response) => {
			void Promise.resolve(handler(request, response)).then((handled) => {
				if (!handled) response.writeHead(404).end();
			});
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("listen failed");
		httpBase = `http://127.0.0.1:${address.port}`;

		mcpServerUuid = randomUUID();
		await client.run(
			"insert into mcp_servers(id,tenant_id,name,status,current_revision,created_by) values ($1,$2,'legacy-mcp','enabled',1,$2)",
			mcpServerUuid,
			tenantId,
		);
		await client.run(
			`insert into mcp_server_revisions(mcp_server_id,tenant_id,revision,transport,endpoint,authentication,created_by)
			 values ($1,$2,1,'streamable_http','http://127.0.0.1/legacy','none',$2)`,
			mcpServerUuid,
			tenantId,
		);
		auditId = randomUUID();
		await client.run(
			`insert into mcp_call_audits(id,tenant_id,conversation_id,mcp_server_id,mcp_revision,tool_name,outcome,latency_ms,result_bytes,result_truncated,created_at,integration_id,orchestration_version_id)
			 values ($1,$2,$3,$4,1,'legacy_tool','success',1,0,false,now(),$5,$6)`,
			auditId,
			tenantId,
			conversationId,
			mcpServerUuid,
			integrationId,
			versionId,
		);

		baseline = await takeBaseline();
		appliedRouter = (await runMigrations(client)).applied;
	});

	afterAll(async () => {
		if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		if (client) await client.close();
		if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
		const admin = await adminClient();
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
		} finally {
			await admin.close();
		}
	});

	async function takeBaseline(): Promise<Record<string, readonly Record<string, unknown>[]>> {
		return {
			workItems: await client.run(
				"select id,state,key_id,task_id from orchestration_work_items where tenant_id=$1 order by id",
				tenantId,
			),
			conversations: await client.run(
				"select id,title,status,source,last_event_sequence from conversations where tenant_id=$1 order by id",
				tenantId,
			),
			integrations: await client.run(
				"select id,kind,enabled,name from orchestration_integrations where tenant_id=$1 order by id",
				tenantId,
			),
			versions: await client.run(
				"select id,source_draft_revision,runtime_spec_hash from orchestration_versions where tenant_id=$1 order by id",
				tenantId,
			),
			events: await client.run(
				"select id,sequence,event_type from conversation_events where tenant_id=$1 order by id",
				tenantId,
			),
			llmCalls: await client.run(
				"select turn_id,call_index,request_payload from orchestration_llm_calls where tenant_id=$1 order by turn_id,call_index",
				tenantId,
			),
			audits: await client.run(
				"select id,outcome,latency_ms from mcp_call_audits where tenant_id=$1 order by id",
				tenantId,
			),
		};
	}

	async function makeTask(keyId = principalKeyId, tenant = tenantId): Promise<string> {
		const taskId = randomUUID();
		await client.run("insert into router_tasks(id,tenant_id,key_id) values ($1,$2,$3)", taskId, tenant, keyId);
		return taskId;
	}

	async function nextEventSequence(taskId: string, tenant = tenantId): Promise<number> {
		const rows = await client.run(
			"select coalesce(max(sequence),0)+1 as next from router_task_events where tenant_id=$1 and task_id=$2",
			tenant,
			taskId,
		);
		return Number(rows[0]?.next);
	}

	async function makeOperation(
		taskId: string,
		sequence: number,
		state: string,
		tenant = tenantId,
		holds = false,
	): Promise<string> {
		const operationId = randomUUID();
		const eventSequence = await nextEventSequence(taskId, tenant);
		await client.run(
			`insert into router_task_events(id,tenant_id,task_id,sequence,user_input_for_operation_id,event_type,payload,public_visible)
			 values ($1,$2,$3,$4,$5,'user.message',$6::jsonb,false)`,
			randomUUID(),
			tenant,
			taskId,
			eventSequence,
			operationId,
			{ text: `input-${sequence}` },
		);
		await client.run(
			`insert into router_operations(id,tenant_id,task_id,operation_sequence,input_event_sequence,state,capability_snapshot,capability_snapshot_hash,holds_task_occupancy,claimed_at,worker_instance_id,queue_deadline)
			 values ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,$9,$10,now() + interval '1 hour')`,
			operationId,
			tenant,
			taskId,
			sequence,
			eventSequence,
			state,
			HASH,
			holds,
			holds ? new Date() : null,
			holds ? "worker-fixture" : null,
		);
		await client.run(
			"update router_task_events set operation_id=$1 where tenant_id=$2 and task_id=$3 and sequence=$4",
			operationId,
			tenant,
			taskId,
			eventSequence,
		);
		return operationId;
	}

	async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
		await expect(promise).rejects.toMatchObject({ code });
	}

	test("upgrade applies the Router migrations over a seeded 0001..0034 database and is idempotent", async () => {
		expect(appliedBaseline).toHaveLength(34);
		expect(appliedBaseline.at(-1)).toBe(LEGACY_LAST);
		expect(appliedRouter).toEqual([
			"0035_router_v1.sql", "0036_router_local_tool_events.sql", "0037_router_sandbox_execution.sql",
		]);
		expect((await runMigrations(client)).applied).toEqual([]);
		const versions = (await client.run("select version from _migrations order by version")).map((row) =>
			String(row.version),
		);
		expect(versions).toHaveLength(37);
	});

	test("Bash history requires protected local provenance while MCP history remains valid", async () => {
		const taskId = await makeTask();
		const operationId = await makeOperation(taskId, 1, "queued");
		const storeResult = async (visibility: boolean, payload: Record<string, string>) => client.run(
			`insert into router_task_events(id,tenant_id,task_id,operation_id,sequence,event_type,payload,public_visible)
			values ($1,$2,$3,$4,$5,'tool.result',$6::jsonb,$7)`,
			randomUUID(), tenantId, taskId, operationId, await nextEventSequence(taskId), payload, visibility,
		);
		await storeResult(false, { tool_name: "lookup", server_id: `mcp_${randomUUID()}` });
		await storeResult(false, { tool_name: "bash", provider: "linux-bwrap" });
		await expectCode(storeResult(true, { tool_name: "bash", provider: "linux-bwrap" }), "23514");
		await expectCode(storeResult(false, { tool_name: "bash", provider: "invalid" }), "23514");
	});

	test("real Chat, old Integration and Key-owned Run read paths survive the upgrade", async () => {
		expect(await takeBaseline()).toEqual(baseline);
		const chat = await repos.conversations.get(
			{
				tenantId: tenantId as TenantId,
				publishedAppId: appId as PublishedAppId,
				principalId: principalId as PrincipalId,
			},
			chatConversationId as ConversationId,
		);
		expect(chat?.title).toBe("legacy chat sample");
		const chatEvents = await repos.events.list(
			{
				tenantId: tenantId as TenantId,
				publishedAppId: appId as PublishedAppId,
				principalId: principalId as PrincipalId,
			},
			chatConversationId as ConversationId,
			{ limit: 10 },
		);
		expect(chatEvents.some((event) => event.eventType === "user.message")).toBe(true);
		await repos.events.append({
			tenantId: tenantId as TenantId,
			publishedAppId: appId as PublishedAppId,
			principalId: principalId as PrincipalId,
		}, {
			conversationId: chatConversationId as ConversationId,
			eventType: "turn/failed",
			payload: { error: "fixture" },
		});
		const failedChat = await control.listConversations({
			tenantId: tenantId as TenantId, limit: 10, origin: "chat", executionState: "failed",
		});
		expect(failedChat).toMatchObject({
			ok: true, data: { items: [{ id: `conv_${chatConversationId}`, status: "active", executionState: "failed" }] },
		});
		const adminList = await control.listConversations({ tenantId: tenantId as TenantId, limit: 20 });
		if (!adminList.ok) throw new Error("admin conversation list failed");
		expect(adminList.data.items.length).toBeGreaterThanOrEqual(2);
		expect(adminList.data.items.some((item) => item.origin === "chat")).toBe(true);
		expect(adminList.data.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ origin: "integration", runId: legacyRunId }),
			expect.objectContaining({ origin: "aaas_key", runId: keyRunId, executionState: "queued" }),
		]));
		const pendingKey = await control.listConversations({
			tenantId: tenantId as TenantId, limit: 10, origin: "aaas_key", executionState: "queued", search: keyRunId,
		});
		expect(pendingKey).toMatchObject({ ok: true, data: { items: [{ runId: keyRunId }] } });
		const failedKey = await control.listConversations({
			tenantId: tenantId as TenantId, limit: 10, origin: "aaas_key", executionState: "failed", search: keyRunId,
		});
		expect(failedKey).toMatchObject({ ok: true, data: { items: [] } });
		const adminDetail = await control.getConversationAdminDetail({
			tenantId: tenantId as TenantId,
			conversationId: chatConversationId as ConversationId,
		});
		expect(adminDetail.ok).toBe(true);

		const legacyIntegrationRecord = await store.getLegacyIntegration(
			String(
				(
					await client.run(
						"select id from orchestration_integrations where tenant_id=$1 and name='legacy-integration'",
						tenantId,
					)
				)[0]?.id,
			),
		);
		expect(legacyIntegrationRecord.name).toBe("legacy-integration");
		const response = await fetch(`${httpBase}/api/aaas/v1/runs/${legacyRunId}`, {
			headers: { Authorization: `Bearer ${legacyToken}` },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { run_id: string } };
		expect(body.data.run_id).toBe(legacyRunId);

		const restoredPrincipal = await keys.authenticate(`Bearer ${await keys.reveal(principalKeyId)}`);
		expect((await runs.run(restoredPrincipal, keyRunId)).run_id).toBe(keyRunId);
		expect(await runs.usage(restoredPrincipal)).toMatchObject({ key_id: principalKeyId, runs: 1 });
	});

	test("admin Router Usage consumes only tenant-owned Operation totals in the selected period", async () => {
		const taskId = await makeTask();
		const complete = await makeOperation(taskId, 1, "completed");
		const partial = await makeOperation(taskId, 2, "failed");
		const unknown = await makeOperation(taskId, 3, "canceled");
		const outside = await makeOperation(taskId, 4, "completed");
		const foreignKey = await new ApiKeyStore(client, otherTenantId, masterKey).create("foreign-usage");
		const foreignTask = await makeTask(foreignKey.record.keyId, otherTenantId);
		const foreign = await makeOperation(foreignTask, 1, "completed", otherTenantId);
		const from = new Date("2025-06-01T00:00:00.000Z");
		const to = new Date("2025-06-03T00:00:00.000Z");
		for (const [op, tokens, isComplete, at] of [
			[complete, 31, true, from], [partial, 7, false, from], [unknown, null, false, from],
			[outside, 100, true, to], [foreign, 1000, true, from],
		] as const) {
			await client.run("update router_operations set created_at=$2,usage=$3::jsonb,usage_complete=$4 where id=$1",
				op, at, tokens === null ? {} : { total_tokens: tokens }, isComplete);
		}
		await client.run("update router_tasks set accumulated_usage=$2::jsonb where id=$1", taskId, { total_tokens: 999 });
		await client.run(`insert into orchestration_llm_calls(tenant_id,router_operation_id,call_index,model_provider,model_id,request_payload)
			values ($1,$2,1,'test','test-model','{}'),($1,$2,2,'test','test-model','{}')`, tenantId, complete);
		const result = await control.getUsageSummary({ tenantId: tenantId as TenantId, from, to });
		if (!result.ok) throw new Error("admin usage summary failed");
		expect(result.data.router?.coverage).toMatchObject({
			runCount: 3, accurateTokens: 31, partialTokens: 7, completeCount: 1, partialCount: 1, noUsageCount: 1,
		});
		expect(result.data.router?.runs).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: complete, accurateTokens: 31, accurateLlmCallCount: null, cacheHitTokens: null }),
			expect.objectContaining({ id: partial, accurateTokens: null, partialTokens: 7 }),
			expect.objectContaining({ id: unknown, accurateTokens: null, tokenCoverage: "none" }),
		]));
		expect(result.data.totals.totalTokens).toBe(0);
	});

	test("legacy configuration, key and sensitive rule defaults are unchanged", async () => {
		const keyRows = await client.run(
			"select * from aaas_api_keys where tenant_id=$1 and id=$2",
			tenantId,
			principalKeyId,
		);
		expect(keyRows[0]).toMatchObject({
			router_capability_scope: "legacy",
			direct_capabilities: null,
			direct_capability_revision: 0,
		});
		const bindingRows = await client.run(
			"select credential_bindings from aaas_version_credential_bindings where tenant_id=$1 and orchestration_version_id=$2",
			tenantId,
			versionId,
		);
		expect(bindingRows[0]?.credential_bindings).toEqual([]);
		await expectCode(
			client.run("update mcp_server_revisions set sensitive_bindings='{}'::jsonb where tenant_id=$1", tenantId),
			"23514",
		);
		await client.run("update mcp_server_revisions set sensitive_bindings='[]'::jsonb where tenant_id=$1", tenantId);
	});

	test("database rejects cross-tenant references, duplicate sequences and duplicate History sequence", async () => {
		const taskId = await makeTask();
		const otherKey = randomUUID();
		await client.run(
			"insert into aaas_api_keys(id,tenant_id,name,secret_hash) values ($1,$2,'other-key',$3)",
			otherKey,
			otherTenantId,
			HASH,
		);
		await expectCode(makeTask(otherKey), "23503");
		const operationId = await makeOperation(taskId, 1, "queued");
		await expectCode(makeOperation(taskId, 1, "queued"), "23505");
		await expectCode(makeOperation(taskId, 2, "queued", otherTenantId), "23503");
		const acceptedSequence = await nextEventSequence(taskId);
		await client.run(
			`insert into router_task_events(id,tenant_id,task_id,sequence,operation_id,event_type,public_visible)
			 values ($1,$2,$3,$4,$5,'operation.accepted',true)`,
			randomUUID(),
			tenantId,
			taskId,
			acceptedSequence,
			operationId,
		);
		await expectCode(
			client.run(
				`insert into router_task_events(id,tenant_id,task_id,sequence,event_type)
				 values ($1,$2,$3,$4,'operation.queued')`,
				randomUUID(),
				tenantId,
				taskId,
				acceptedSequence,
			),
			"23505",
		);
		const otherTask = await makeTask();
		await expectCode(
			client.run(
				`insert into router_task_events(id,tenant_id,task_id,sequence,operation_id,event_type)
				 values ($1,$2,$3,$4,$5,'operation.accepted')`,
				randomUUID(),
				tenantId,
				otherTask,
				await nextEventSequence(otherTask),
				operationId,
			),
			"23503",
		);
		const publicRows = await client.run(
			"select sequence,event_type from router_task_public_events where task_id=$1",
			taskId,
		);
		expect(publicRows).toHaveLength(1);
		const secondOperation = await makeOperation(taskId, 2, "queued");
		const inputs = await client.run(
			`select o.operation_sequence as ordinal, e.payload->>'text' as text
			 from router_operations o
			 join router_task_events e on e.tenant_id=o.tenant_id and e.task_id=o.task_id and e.sequence=o.input_event_sequence
			 where o.tenant_id=$1 and o.task_id=$2 order by o.operation_sequence`,
			tenantId,
			taskId,
		);
		expect(inputs.map((row) => [Number(row.ordinal), row.text])).toEqual([
			[1, "input-1"],
			[2, "input-2"],
		]);
		const otherOperation = await makeOperation(otherTask, 1, "queued");
		const foreignSequence = Number(
			(await client.run("select input_event_sequence from router_operations where id=$1", otherOperation))[0]
				?.input_event_sequence,
		);
		await expectCode(
			client.run(
				"update router_operations set input_event_sequence=$1 where id=$2",
				foreignSequence,
				secondOperation,
			),
			"23503",
		);
	});

	test("idempotency scope and Task pointers are bound to tenant, key and task", async () => {
		const taskA = await makeTask();
		const taskB = await makeTask();
		const operationA = await makeOperation(taskA, 1, "queued");
		await expectCode(
			client.run("update router_tasks set latest_operation_id=$1 where id=$2", operationA, taskB),
			"23503",
		);
		await expectCode(
			client.run("update router_tasks set latest_completed_operation_id=$1 where id=$2", operationA, taskB),
			"23503",
		);
		const otherSameTenantKey = randomUUID();
		await client.run(
			"insert into aaas_api_keys(id,tenant_id,name,secret_hash) values ($1,$2,'same-tenant-other-key',$3)",
			otherSameTenantKey,
			tenantId,
			HASH,
		);
		const operationB = await makeOperation(taskB, 1, "queued");
		const operationA2 = await makeOperation(taskA, 2, "queued");
		const idem = (
			keyId: string,
			scope: string,
			key: string,
			taskId: string,
			operationId = operationA,
		): Promise<unknown> =>
			client.run(
				`insert into router_idempotency(tenant_id,key_id,idempotency_key,request_scope,scope_id,request_hash,canonicalization_version,digest_key_version,task_id,operation_id)
				 values ($1,$2,$3,$4,$5,$6,1,1,$7,$8)`,
				tenantId,
				keyId,
				key,
				scope,
				scope === "task.create" ? keyId : taskId,
				HASH,
				taskId,
				operationId,
			);
		await expectCode(idem(otherSameTenantKey, "task.create", "cross-key", taskA), "23503");
		await idem(principalKeyId, "task.create", "same-key", taskA);
		await expectCode(idem(principalKeyId, "task.create", "same-key", taskA), "23505");
		await idem(principalKeyId, "operation.input", "same-key", taskB, operationB);
		await idem(principalKeyId, "operation.input", "same-key", taskA, operationA2);
		await expectCode(idem(principalKeyId, "operation.input", "same-key", taskA, operationA2), "23505");
	});

	test("one Task allows one claimed/queued, running or cleanup occupancy", async () => {
		const taskId = await makeTask();
		const terminal = await makeOperation(taskId, 1, "completed", tenantId, true);
		await expectCode(makeOperation(taskId, 2, "running", tenantId, true), "23505");
		await expectCode(makeOperation(taskId, 3, "running", tenantId), "23514");
		await expectCode(
			client.run('update router_operations set progress=\'{"thinking":"secret"}\'::jsonb where id=$1', terminal),
			"23514",
		);
		await client.run("update router_operations set holds_task_occupancy=false where id=$1", terminal);
		const claimedQueued = await makeOperation(taskId, 2, "queued", tenantId, true);
		expect(claimedQueued).toBeTruthy();
		const queuedRows = await client.run(
			"select claimed_at,worker_instance_id,queue_deadline from router_operations where id=$1",
			claimedQueued,
		);
		expect(queuedRows[0]?.claimed_at).toBeTruthy();
		expect(queuedRows[0]?.worker_instance_id).toBe("worker-fixture");
		expect(queuedRows[0]?.queue_deadline).toBeTruthy();
		await expectCode(makeOperation(taskId, 3, "running", tenantId, true), "23505");
	});

	test("tracking attribution is mutually exclusive and pure Router calls need no legacy objects", async () => {
		await store.recordLlmTrace(conversationId, turnId, {
			kind: "request",
			callIndex: 1,
			model: { provider: "test", id: "test-model" },
			context: { origin: "replayed-after-migration" },
		} as unknown as LlmCallTrace);
		const legacy = await client.run(
			"select request_payload,conversation_id,turn_id,router_operation_id from orchestration_llm_calls where tenant_id=$1 and turn_id=$2 and call_index=1",
			tenantId,
			turnId,
		);
		expect(legacy[0]).toMatchObject({
			request_payload: { origin: "legacy-baseline" },
			conversation_id: conversationId,
			router_operation_id: null,
		});

		const taskId = await makeTask();
		const operationId = await makeOperation(taskId, 1, "completed", tenantId, true);
		await client.run(
			`insert into orchestration_llm_calls(tenant_id,router_operation_id,call_index,model_provider,model_id,request_payload)
			 values ($1,$2,1,'test','test-model','{"origin":"router"}'::jsonb)`,
			tenantId,
			operationId,
		);
		const routerCall = await client.run(
			"select conversation_id,turn_id,router_operation_id from orchestration_llm_calls where tenant_id=$1 and router_operation_id=$2",
			tenantId,
			operationId,
		);
		expect(routerCall[0]).toMatchObject({ conversation_id: null, turn_id: null, router_operation_id: operationId });
		await expectCode(
			client.run(
				`insert into orchestration_llm_calls(tenant_id,router_operation_id,call_index,model_provider,model_id,request_payload)
				 values ($1,$2,1,'test','test-model','{}'::jsonb)`,
				tenantId,
				operationId,
			),
			"23505",
		);
		await expectCode(
			client.run(
				`insert into orchestration_llm_calls(tenant_id,conversation_id,turn_id,router_operation_id,call_index,model_provider,model_id,request_payload)
				 values ($1,$2,$3,$4,9,'test','test-model','{}'::jsonb)`,
				tenantId,
				conversationId,
				turnId,
				operationId,
			),
			"23514",
		);

		await expectCode(
			client.run("update mcp_call_audits set router_operation_id=$1 where id=$2", operationId, auditId),
			"23514",
		);
		await client.run(
			`insert into mcp_call_audits(id,tenant_id,mcp_server_id,mcp_revision,tool_name,outcome,latency_ms,result_bytes,result_truncated,created_at,router_operation_id)
			 values ($1,$2,$3,1,'router_tool','success',1,0,false,now(),$4)`,
			randomUUID(),
			tenantId,
			mcpServerUuid,
			operationId,
		);
	});

	test("direct capability registration is explicit and revision-checked", async () => {
		await client.run(
			"update aaas_api_keys set router_capability_scope='router',direct_capabilities=$1::jsonb,direct_capability_revision=1 where tenant_id=$2 and id=$3",
			{ model: { provider: "test", id: "test-model" }, servers: [] },
			tenantId,
			principalKeyId,
		);
		const updated = await client.run(
			"select router_capability_scope,direct_capability_revision from aaas_api_keys where tenant_id=$1 and id=$2",
			tenantId,
			principalKeyId,
		);
		expect(updated[0]).toMatchObject({ router_capability_scope: "router", direct_capability_revision: 1 });
		await expectCode(
			client.run(
				"update aaas_api_keys set direct_capabilities=null,direct_capability_revision=1 where tenant_id=$1 and id=$2",
				tenantId,
				principalKeyId,
			),
			"23514",
		);
	});
});

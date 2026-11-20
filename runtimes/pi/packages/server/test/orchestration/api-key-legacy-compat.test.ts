/**
 * T042 / T043 / T044 acceptance for "AaaS 通用任务接口 V1".
 *
 * The new API Key identity owns an internal Integration carrier
 * (`orchestration_integrations.kind='internal_key_carrier'`). Two contracts
 * must hold at the same time:
 *
 *  - T043: the legacy `oi_` Integration Token contract behaves exactly as
 *    before (submit / query / cancel, `prompt` vs `input`, historical Run and
 *    idempotent replay, platform MCP secret).
 *  - T042: the carrier is invisible or rejected in EVERY legacy entry point,
 *    even when its id is known.
 *  - T044: the legacy OpenAPI document still exposes exactly the three legacy
 *    Integration Token paths; the API Key document is published separately.
 *
 * Legacy surfaces exercised from this test (T042 inventory):
 *   HTTP  : GET/POST /api/admin/v1/orchestration/integrations,
 *           POST .../integrations/{id}/migrate,
 *           POST .../integrations/{id}/debug-runs,
 *           PATCH .../integrations/{id} (enable/disable/rotate/rename),
 *           GET/PUT .../integrations/{id}/configuration,
 *           GET/POST .../integrations/{id}/configuration-grants,
 *           PATCH .../integrations/{id}/configuration-grants/{grant_id},
 *           GET /aaas/integrations/{id}/configuration,
 *           GET/PUT/POST /api/aaas/v1/integrations/{id}/(configuration|draft|publish),
 *           POST /api/aaas/v1/configuration/exchange,
 *           GET /api/admin/v1/orchestration/work-items,
 *           GET/POST /api/admin/v1/orchestration/work-items/{id}(/cancel|/retry),
 *           POST /api/orchestration/v1/events,
 *           POST /api/orchestration/v1/work-items/{id}/cancel,
 *           POST /api/aaas/v1/integrations/{id}/runs,
 *           GET  /api/aaas/v1/runs/{id}, POST /api/aaas/v1/runs/{id}/cancel,
 *           GET  /api/aaas-docs/openapi.json, GET /api/aaas-docs/v1/openapi.json
 *   Store : listIntegrations, getIntegration, getLegacyIntegration, updateAccess,
 *           renameIntegration, workItem, run, cancel, retry, listWorkItems, authenticate
 *   Proj. : ControlService.listConversations / getConversationAdminDetail /
 *           listConversationSummaries / getConversationSessionUsage / getUsageSummary,
 *           conversation-events.summarizeOrchestrationUsage,
 *           conversations.listByTenant / getByTenant
 *
 * Legacy surfaces that do NOT exist in the current code and therefore cannot be
 * exercised (reported, not silently skipped):
 *   - "删除接入" (delete integration): `src/orchestration/http.ts` has no DELETE
 *     handler for integrations, so there is no legacy delete route to reject a
 *     carrier. The closest reachable equivalents, `store.updateAccess` /
 *     `renameIntegration` / `getLegacyIntegration`, are covered.
 *   - `store.getIntegration` deliberately RETURNS the carrier: it is the new-Key
 *     path's own accessor (`ApiKeyRunService.submit`), not a legacy surface.
 *     The legacy-only accessor `store.getLegacyIntegration` rejects it, and the
 *     test asserts both facts.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { aaasApiKeyOpenApi, aaasOpenApi } from "../../src/orchestration/api-documentation.ts";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { createTaskBoundary, McpRunGuard } from "../../src/orchestration/api-key-boundary.ts";
import type { ApiKeyPrincipal } from "../../src/orchestration/api-key-contracts.ts";
import { createApiKeyHttp } from "../../src/orchestration/api-key-http.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { settingsSchema } from "../../src/orchestration/contracts.ts";
import { createBoundaryExecutionSource } from "../../src/orchestration/execution-source.ts";
import { credentialHash, WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { startOrchestrationDispatcher } from "../../src/orchestration/dispatcher.ts";
import { orchestrationExecutionConfigResolver } from "../../src/orchestration/execution-configuration.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { type ClaimedAssignment, type IntegrationRecord, OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import type { ConversationId, PrincipalId, PublishedAppId, TenantId } from "../../src/publishing/domain/ids.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import type { ConversationRecord } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const SCHEMA = `aaas_legacy_${process.pid}_${Date.now().toString(36)}`;
const PG_URL =
	process.env.PI_ORCHESTRATION_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

async function probe(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}
const pgUp = await probe();

interface HttpResponse {
	readonly status: number;
	readonly body: {
		readonly data?: unknown;
		readonly error?: { readonly code: string; readonly message: string };
		readonly requestId?: string;
	};
	/** The raw parsed JSON body, used by the OpenAPI documents which are not enveloped. */
	readonly raw: unknown;
}

interface RunData {
	readonly run_id: string;
	readonly status: string;
	readonly duplicate: boolean;
}

describe.skipIf(!pgUp)("legacy oi_ contract and API Key carrier isolation on isolated Postgres", () => {
	let client: PostgresClient;
	let store: OrchestrationStore;
	let service: OrchestrationService;
	let control: ControlService;
	let keys: ApiKeyStore;
	let apiKeyRuns: ApiKeyRunService;
	let server: Server;
	let base: string;
	let legacy: IntegrationRecord;
	let legacyToken: string;
	let carrierPrincipal: ApiKeyPrincipal;
	let carrierIntegrationId: string;
	let carrierRunId: string;
	let carrierConversationId: string;
	let carrierKeyId: string;
	let legacyRunId: string;
	let legacyConversationId: string;
	const tenantId = randomUUID();
	const appId = randomUUID();
	const publishedVersionId = randomUUID();
	const configurationId = randomUUID();
	const orchestrationVersionId = randomUUID();
	const masterKey = new Uint8Array(32).fill(19);
	const ADMIN = "Bearer admin-test";

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run("insert into tenants(id,name,status) values ($1,'legacy-compat','active')", tenantId);
		const agentId = randomUUID();
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'test',1,$3::jsonb,$2)",
			agentId,
			tenantId,
			{ prompt: "Analyze", model: { provider: "fake", modelId: "test" }, tools: [] },
		);
		await client.run(
			"insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by) values ($1,$2,$3,$4,'test','active','anonymous',$2)",
			appId,
			tenantId,
			agentId,
			`pub_${appId}`,
		);
		const published = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: `pav_${publishedVersionId}`,
			agent: { systemPrompt: "Analyze", model: { provider: "fake", modelId: "test" } },
			capabilities: {},
		});
		if (!published.ok) throw new Error(published.errors.join("\n"));
		await client.run(
			`insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by)
			values ($1,$2,$3,1,1,'{}',$4::jsonb,$5,'ready',$2)`,
			publishedVersionId,
			tenantId,
			appId,
			published.spec,
			sha256Hex(canonicalJson(published.spec)),
		);
		await client.run("update published_apps set current_version_id=$1 where id=$2", publishedVersionId, appId);

		// Platform configuration used by the new API Key carriers.
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);
		const platform = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: `orv_${orchestrationVersionId}`,
			agent: { systemPrompt: "platform", model: { provider: "test", modelId: "test-model" } },
			capabilities: { mcpServers: [] },
			contextPolicy: {},
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		});
		if (!platform.ok) throw new Error(`invalid platform fixture: ${platform.errors.join("; ")}`);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,1,$5::jsonb,$6)`,
			orchestrationVersionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			platform.spec,
			sha256Hex(canonicalJson(platform.spec)),
		);

		store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey));
		const created = await store.createIntegration(
			appId,
			publishedVersionId,
			"legacy-token-integration",
			settingsSchema.parse({ allowedModels: ["test"], bindings: [] }),
		);
		legacyToken = created.token;
		legacy = await store.getIntegration(created.id);

		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		await keys.setPlatformConfiguration(configurationId, orchestrationVersionId, []);
		apiKeyRuns = new ApiKeyRunService({
			client,
			tenantId,
			store,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos: createPublishingRepositories(client),
		});

		const repos = createPublishingRepositories(client);
		const conversations = new ConversationService({
			repositories: repos,
			resolveExecutionConfiguration: orchestrationExecutionConfigResolver(store, repos),
			turnExecutor: async () => ({ ok: true, outputText: "legacy report" }),
		});
		control = new ControlService({
			repositories: repos,
			catalog: { tools: [], knowledgeBases: [], models: [{ provider: "fake", modelId: "test" }] },
			embedBaseUrl: "https://embed.test",
		});
		vi.spyOn(control, "listLlmModels").mockResolvedValue({
			ok: true,
			data: {
				items: [
					{
						id: "test",
						name: "test",
						provider: "fake",
						api: "openai-completions",
						reasoning: false,
						parameterCapabilities: { reasoning: { supported: false, toggle: false, efforts: [] } },
					},
				],
			},
		});
		service = new OrchestrationService(store, control, repos, conversations);

		// A real API Key plus its real internal carrier.
		const key = await keys.create("legacy-compat-key");
		carrierPrincipal = await keys.authenticate(`Bearer ${key.token}`);
		carrierKeyId = carrierPrincipal.keyId;
		const carrierRun = await apiKeyRuns.submit(carrierPrincipal, "carrier-idem-1", {
			prompt: "carrier run",
			mcp_servers: [],
		});
		carrierPrincipal = await keys.authenticate(`Bearer ${key.token}`);
		carrierIntegrationId = carrierPrincipal.carrierIntegrationId!;
		carrierRunId = carrierRun.run_id;
		const [carrierRow] = await client.run(
			"select conversation_id from orchestration_work_items where id=$1",
			carrierRunId,
		);
		carrierConversationId = String(carrierRow?.conversation_id);

		const orchestrationHttp = createOrchestrationHttp(service, (request) => request.headers.authorization === ADMIN);
		const apiKeyHttp = createApiKeyHttp({
			keys,
			runs: apiKeyRuns,
			isAdmin: (request) => request.headers.authorization === ADMIN,
		});
		server = createServer((request, response) => {
			void Promise.resolve()
				.then(async () => (await apiKeyHttp(request, response)) || (await orchestrationHttp(request, response)))
				.then((handled) => {
					if (!handled && !response.headersSent) response.writeHead(404).end();
				});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen failed");
		base = `http://127.0.0.1:${address.port}`;
	}, 30000);

	afterAll(async () => {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (client) {
			await client.run(`drop schema if exists ${SCHEMA} cascade`);
			await client.close();
		}
	});

	async function call(
		path: string,
		method: string,
		body: unknown,
		authorization: string,
		extraHeaders: Record<string, string> = {},
	): Promise<HttpResponse> {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { Authorization: authorization, "Content-Type": "application/json", ...extraHeaders },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		const raw: unknown = text === "" ? undefined : JSON.parse(text);
		return {
			status: response.status,
			body: (raw ?? {}) as HttpResponse["body"],
			raw,
		};
	}
	const aaas = (path: string, method: string, body?: unknown, key?: string) =>
		call(`/api/aaas/v1${path}`, method, body, `Bearer ${legacyToken}`, key ? { "Idempotency-Key": key } : {});
	const legacyCall = (path: string, method: string, body?: unknown) =>
		call(`/api/orchestration/v1${path}`, method, body, `Bearer ${legacyToken}`);
	const adminCall = (path: string, method: string, body?: unknown) =>
		call(`/api/admin/v1/orchestration${path}`, method, body, ADMIN);

	/** Claim the requested work item, releasing anything else that is still queued. */
	async function claimUntil(workItemId: string): Promise<ClaimedAssignment> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const claim = await store.claim();
			if (!claim) throw new Error(`no claimable assignment for ${workItemId}`);
			if (claim.workItemId === workItemId) return claim;
			if (claim.integrationId === carrierIntegrationId) await apiKeyRuns.cancel(carrierPrincipal, claim.workItemId);
			else await store.cancel(claim.workItemId);
		}
		throw new Error(`could not claim ${workItemId}`);
	}

	async function ownerScopeOf(workItemId: string): Promise<{
		readonly scope: { tenantId: TenantId; publishedAppId: PublishedAppId; principalId: PrincipalId };
		readonly record: ConversationRecord;
	}> {
		const [row] = await client.run(
			"select principal_id,conversation_id from orchestration_work_items where id=$1",
			workItemId,
		);
		const conversationId = String(row?.conversation_id);
		const [conversation] = await client.run("select published_app_id from conversations where id=$1", conversationId);
		const scope = {
			tenantId: tenantId as TenantId,
			publishedAppId: String(conversation?.published_app_id) as PublishedAppId,
			principalId: String(row?.principal_id) as PrincipalId,
		};
		const repos = createPublishingRepositories(client);
		const record = await repos.conversations.get(scope, conversationId as ConversationId);
		if (!record) throw new Error(`conversation ${conversationId} is missing`);
		return { scope, record };
	}

	// ---------------------------------------------------------------------
	// A. Legacy `oi_` full-path regression (T043)
	// ---------------------------------------------------------------------

	test("T043 legacy oi_ Run is submitted, queried and cancelled through the unchanged routes", async () => {
		const key = randomUUID();
		const body = { prompt: "分析设备超时", external_ref: { type: "ticket", id: "TK-LEGACY-1" } };
		const submitted = await aaas(`/integrations/${legacy.id}/runs`, "POST", body, key);
		expect(submitted.status).toBe(202);
		expect(submitted.body.requestId).toEqual(expect.any(String));
		expect(submitted.body.data).toEqual({
			run_id: expect.any(String),
			status: "queued",
			duplicate: false,
		});
		const runId = (submitted.body.data as RunData).run_id;
		legacyRunId = runId;

		// The legacy Run id IS the work item id.
		const workItem = await store.workItem(runId);
		expect(workItem).toMatchObject({
			id: runId,
			integrationId: legacy.id,
			origin: "aaas",
			requestContract: "legacy_prompt",
		});
		expect(workItem.assignments).toHaveLength(1);

		const queried = await aaas(`/runs/${runId}`, "GET");
		expect(queried.status).toBe(200);
		expect(queried.body.data).toMatchObject({
			run_id: runId,
			integration_id: legacy.id,
			external_ref: { type: "ticket", id: "TK-LEGACY-1" },
			metadata: null,
			agent_version: `pav_${publishedVersionId}`,
			configuration_revision: 1,
			status: "queued",
			result: null,
			error: null,
			created_at: expect.any(String),
			started_at: null,
			completed_at: null,
		});
		expect(Object.keys(queried.body.data as Record<string, unknown>).sort()).toEqual([
			"agent_version",
			"completed_at",
			"configuration_revision",
			"created_at",
			"error",
			"external_ref",
			"integration_id",
			"metadata",
			"result",
			"run_id",
			"started_at",
			"status",
		]);

		const cancelled = await aaas(`/runs/${runId}/cancel`, "POST", {});
		expect(cancelled.status).toBe(200);
		expect((cancelled.body.data as RunData).status).toBe("cancelled");
		const again = await aaas(`/runs/${runId}/cancel`, "POST", {});
		expect((again.body.data as RunData).status).toBe("cancelled");

		// The pre-AaaS legacy event entry point is unchanged as well.
		const eventId = randomUUID();
		const accepted = await legacyCall("/events", "POST", {
			eventId,
			alarmId: "alarm-legacy",
			input: "设备超时",
			credentials: {},
			credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
		});
		expect(accepted.status).toBe(202);
		const workItemId = (accepted.body.data as { workItemId: string }).workItemId;
		expect(workItemId).toEqual(expect.any(String));
		const [legacyWorkItem] = await client.run(
			"select conversation_id from orchestration_work_items where id=$1",
			workItemId,
		);
		legacyConversationId = String(legacyWorkItem?.conversation_id);
		const legacyCancelled = await legacyCall(`/work-items/${workItemId}/cancel`, "POST");
		expect(legacyCancelled.status).toBe(200);
		expect(legacyCancelled.body.data).toEqual({ cancelled: true });
		expect((await store.workItem(workItemId)).state).toBe("cancelled");
	});

	test("T043 legacy prompt and input keep their original meaning and task prompt resolution", async () => {
		const promptText = "  分析设备超时\n按固定格式返回\n";
		const promptRun = await aaas(`/integrations/${legacy.id}/runs`, "POST", { prompt: promptText }, randomUUID());
		expect(promptRun.status).toBe(202);
		const promptRunId = (promptRun.body.data as RunData).run_id;
		const [promptRow] = await client.run(
			"select request_contract,task_prompt,origin,key_id from orchestration_work_items where id=$1",
			promptRunId,
		);
		expect(promptRow).toMatchObject({
			request_contract: "legacy_prompt",
			task_prompt: promptText,
			origin: "aaas",
			key_id: null,
		});
		const [promptEvent] = await client.run(
			"select input from orchestration_events where work_item_id=$1",
			promptRunId,
		);
		expect(promptEvent?.input).toBe(promptText);

		const inputPayload = { ticket: "TK-LEGACY-2", nested: { value: 1 } };
		const inputRun = await aaas(`/integrations/${legacy.id}/runs`, "POST", { input: inputPayload }, randomUUID());
		expect(inputRun.status).toBe(202);
		const inputRunId = (inputRun.body.data as RunData).run_id;
		const [inputRow] = await client.run(
			"select request_contract,task_prompt,origin,key_id from orchestration_work_items where id=$1",
			inputRunId,
		);
		expect(inputRow).toMatchObject({
			request_contract: "input_v1",
			task_prompt: null,
			origin: "aaas",
			key_id: null,
		});
		const [inputEvent] = await client.run("select input from orchestration_events where work_item_id=$1", inputRunId);
		expect(inputEvent?.input).toBe(canonicalJson(inputPayload));

		// `prompt` and `input` remain mutually exclusive.
		expect(
			(await aaas(`/integrations/${legacy.id}/runs`, "POST", { prompt: "x", input: {} }, randomUUID())).status,
		).toBe(400);
		expect((await aaas(`/integrations/${legacy.id}/runs`, "POST", {}, randomUUID())).status).toBe(400);

		// Task prompt resolution (src/orchestration/execution-configuration.ts).
		const resolver = orchestrationExecutionConfigResolver(store, createPublishingRepositories(client));
		const promptClaim = await claimUntil(promptRunId);
		const promptContext = await ownerScopeOf(promptRunId);
		const promptScope = { ...promptContext.scope, principalId: promptContext.scope.principalId };
		const promptResolved = await resolver(promptScope, promptContext.record, promptClaim.turnId as never);
		expect(promptResolved).toBeDefined();
		expect(promptResolved?.audit.requestContract).toBe("legacy_prompt");
		expect((promptResolved?.runtimeSpec as { agent: { systemPrompt: string } }).agent.systemPrompt).toBe(promptText);
		expect(promptResolved?.text).toBe("执行当前系统提示词指定的任务。");
		expect(await store.taskPrompt(promptClaim.conversationId, promptClaim.turnId)).toBe(promptText);

		const inputClaim = await claimUntil(inputRunId);
		const inputContext = await ownerScopeOf(inputRunId);
		const inputResolved = await resolver(inputContext.scope, inputContext.record, inputClaim.turnId as never);
		expect(inputResolved).toBeDefined();
		expect(inputResolved?.audit.requestContract).toBe("input_v1");
		// `input` keeps the configured system prompt and is delivered as the task message.
		expect((inputResolved?.runtimeSpec as { agent: { systemPrompt: string } }).agent.systemPrompt).toBe("Analyze");
		expect(inputResolved?.text).toBeUndefined();
		expect(await store.taskPrompt(inputClaim.conversationId, inputClaim.turnId)).toBeNull();

		// The historical `legacy_input` contract is still accepted by the resolver.
		await client.run("update orchestration_work_items set request_contract='legacy_input' where id=$1", inputRunId);
		const legacyInputResolved = await resolver(inputContext.scope, inputContext.record, inputClaim.turnId as never);
		expect(legacyInputResolved).toBeDefined();
		expect(legacyInputResolved?.audit.requestContract).toBe("legacy_input");
		expect((legacyInputResolved?.runtimeSpec as { agent: { systemPrompt: string } }).agent.systemPrompt).toBe(
			"Analyze",
		);

		await store.cancel(promptRunId);
		await store.cancel(inputRunId);
	});

	test("T043 legacy idempotent replay returns the same work item and a changed payload conflicts", async () => {
		const key = randomUUID();
		const body = { prompt: "重放测试", external_ref: { type: "ticket", id: "TK-REPLAY" } };
		const first = await aaas(`/integrations/${legacy.id}/runs`, "POST", body, key);
		expect(first.status).toBe(202);
		const runId = (first.body.data as RunData).run_id;
		expect((first.body.data as RunData).duplicate).toBe(false);

		const replay = await aaas(`/integrations/${legacy.id}/runs`, "POST", body, key);
		expect(replay.status).toBe(202);
		expect(replay.body.data).toEqual({ run_id: runId, status: "queued", duplicate: true });

		const conflict = await aaas(`/integrations/${legacy.id}/runs`, "POST", { ...body, prompt: "changed" }, key);
		expect(conflict.status).toBe(409);
		expect(conflict.body.error?.code).toBe("EVENT_CONFLICT");

		const [count] = await client.run(
			"select count(*)::int as n from orchestration_work_items where integration_id=$1 and alarm_id=$2",
			legacy.id,
			"TK-REPLAY",
		);
		expect(Number(count?.n)).toBe(1);

		// The historical request_hash / request_hash_version columns are unchanged.
		const columns = await client.run(
			`select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns
			 where table_schema=$1 and (
			   (table_name='orchestration_events' and column_name in ('request_hash','request_hash_version'))
			   or (table_name='orchestration_work_items' and column_name='request_hash_version'))
			 order by table_name,column_name`,
			SCHEMA,
		);
		expect(columns).toEqual([
			{
				table_name: "orchestration_events",
				column_name: "request_hash",
				data_type: "text",
				is_nullable: "NO",
				column_default: null,
			},
			{
				table_name: "orchestration_events",
				column_name: "request_hash_version",
				data_type: "integer",
				is_nullable: "NO",
				column_default: "1",
			},
			{
				table_name: "orchestration_work_items",
				column_name: "request_hash_version",
				data_type: "integer",
				is_nullable: "NO",
				column_default: "1",
			},
		]);
		const [event] = await client.run(
			"select request_hash,request_hash_version from orchestration_events where work_item_id=$1",
			runId,
		);
		expect(String(event?.request_hash)).toMatch(/^[0-9a-f]{64}$/);
		expect(Number(event?.request_hash_version)).toBe(2);
		const [workItem] = await client.run(
			"select request_hash_version from orchestration_work_items where id=$1",
			runId,
		);
		expect(Number(workItem?.request_hash_version)).toBe(2);

		// Historical version-1 rows still replay through the legacy hash branch.
		const eventId = randomUUID();
		const historical = await store.accept(
			legacy,
			{
				eventId,
				alarmId: "alarm-v1",
				input: "历史请求",
				credentials: {},
				credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
			},
			{
				origin: "aaas",
				requestHash: "current-hash-value",
				legacyRequestHash: "historical-hash-value",
				requestContract: "legacy_prompt",
			},
		);
		await client.run(
			"update orchestration_events set request_hash='historical-hash-value',request_hash_version=1 where event_id=$1",
			eventId,
		);
		await expect(
			store.accept(
				legacy,
				{
					eventId,
					alarmId: "alarm-v1",
					input: "历史请求",
					credentials: {},
					credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
				},
				{ origin: "aaas", requestHash: "a-different-hash", requestContract: "legacy_prompt" },
			),
		).rejects.toMatchObject({ code: "EVENT_CONFLICT" });
		const replayed = await store.accept(
			legacy,
			{
				eventId,
				alarmId: "alarm-v1",
				input: "历史请求",
				credentials: {},
				credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
			},
			{
				origin: "aaas",
				requestHash: "a-different-hash",
				legacyRequestHash: "historical-hash-value",
				requestContract: "legacy_prompt",
			},
		);
		expect(replayed).toEqual({ workItemId: historical.workItemId, duplicate: true });

		await store.cancel(runId);
		await store.cancel(historical.workItemId);
	});

	test("T043 a legacy Run still reads the MCP connection credential from the platform secret store", async () => {
		const legacyRun = await aaas(`/integrations/${legacy.id}/runs`, "POST", { prompt: "MCP 凭据回归" }, randomUUID());
		expect(legacyRun.status).toBe(202);
		const legacyRunId = (legacyRun.body.data as RunData).run_id;
		const claim = await claimUntil(legacyRunId);

		// A legacy Run carries no Key: `store.credentials` reports keyId=null, so the
		// production task boundary is not created at all.
		const legacyCredentials = await store.credentials(claim.conversationId, claim.turnId);
		expect(legacyCredentials.keyId).toBeNull();

		const [carrierRow] = await client.run("select key_id from orchestration_work_items where id=$1", carrierRunId);
		expect(String(carrierRow?.key_id)).toBe(carrierKeyId);

		const mcpSecretsGet = vi.fn(async () => ({ ciphertext: "sealed" }));
		const connect = vi.fn(async () => ({
			callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
			close: async () => {},
		}));
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: {
				mcpServers: {
					get: async () => ({ status: "enabled", currentRevision: 1, name: "s" }),
					getRevision: async () => ({ revision: 1 }),
					recordCallAudit: async () => {},
				},
				mcpSecrets: { get: mcpSecretsGet },
			} as never,
			secretBox: { open: () => "PLATFORM_SECRET" } as never,
			connect: connect as never,
			// Production wiring (src/orchestration/compose.ts): the boundary is built
			// from the Run credentials; a legacy Run has keyId=null and therefore no
			// task-only boundary.
			executionSource: async (scope) => {
				if (scope.turnId === undefined || scope.conversationId === undefined) return undefined;
				const conversationId = scope.conversationId;
				const credentials = await store.credentials(conversationId, scope.turnId);
				return createBoundaryExecutionSource({
					boundary: createTaskBoundary({
						keyId: credentials.keyId,
						values: credentials.values,
						maxBytes: scope.limits.toolResultMaxBytes,
						guard,
						conversationId,
					}),
					owner: { kind: "conversation", conversationId },
				});
			},
		});
		const serverId = `mcp_${randomUUID()}`;
		const spec = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: "orv_test",
			agent: { systemPrompt: "p", model: { provider: "test", modelId: "m" } },
			capabilities: {
				mcpServers: [
					{
						mcpServerId: serverId,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://mcp.example.com/v1",
						authentication: "bearer",
						tools: [
							{
								name: "lookup",
								description: null,
								inputSchema: { type: "object", properties: {} },
								inputSchemaHash: "a".repeat(64),
							},
						],
					},
				],
			},
		});
		if (!spec.ok) throw new Error(`invalid mcp fixture: ${spec.errors.join("; ")}`);
		const scope = {
			tenantId: tenantId as TenantId,
			publishedAppId: null,
			publishedAppVersionId: "orv_test",
			executionSource: { kind: "orchestration" as const, ownerId: legacy.id, versionId: "orv_test" },
			principalId: claim.principalId as PrincipalId,
			conversationId: claim.conversationId as ConversationId,
			turnId: claim.turnId,
			limits: {
				maxTurns: 10,
				maxContextTokens: 1000,
				toolResultMaxBytes: 65_536,
				turnTimeoutMs: 1000,
				maxConcurrentTurnsPerConversation: 1,
			},
		};
		const tools = await factory(spec.spec, scope as never);
		await tools[0]!.execute("call-legacy", {}, undefined, undefined, {} as never);
		expect(mcpSecretsGet).toHaveBeenCalled();
		expect(connect).toHaveBeenCalledWith(expect.objectContaining({ bearerToken: "PLATFORM_SECRET" }));

		await store.cancel(legacyRunId);
	});

	// ---------------------------------------------------------------------
	// B. Carrier isolation from every legacy entry point (T042)
	// ---------------------------------------------------------------------

	test("T042 the carrier exists but never appears in a legacy listing", async () => {
		const [carrierRow] = await client.run(
			"select kind,name from orchestration_integrations where id=$1 and tenant_id=$2",
			carrierIntegrationId,
			tenantId,
		);
		expect(carrierRow?.kind).toBe("internal_key_carrier");
		const [mapping] = await client.run(
			"select key_id,carrier_integration_id from aaas_key_carriers where tenant_id=$1 and key_id=$2",
			tenantId,
			carrierKeyId,
		);
		expect(String(mapping?.carrier_integration_id)).toBe(carrierIntegrationId);

		const listed = await store.listIntegrations();
		expect(listed.map((integration) => integration.id)).toContain(legacy.id);
		expect(listed.map((integration) => integration.id)).not.toContain(carrierIntegrationId);

		const adminListed = await adminCall("/integrations", "GET");
		expect(adminListed.status).toBe(200);
		const adminIds = (adminListed.body.data as readonly { id: string }[]).map((integration) => integration.id);
		expect(adminIds).toContain(legacy.id);
		expect(adminIds).not.toContain(carrierIntegrationId);

		const workItems = await adminCall("/work-items", "GET");
		expect(workItems.status).toBe(200);
		const workItemIds = (workItems.body.data as readonly { id: string }[]).map((item) => item.id);
		expect(workItemIds).not.toContain(carrierRunId);
		// Positive control: legacy work items are listed, so the exclusion is meaningful.
		expect(workItemIds.length).toBeGreaterThan(0);
		expect(workItemIds).toContain(legacyRunId);

		const carrierScoped = await adminCall(`/work-items?integrationId=${carrierIntegrationId}`, "GET");
		expect(carrierScoped.status).toBe(200);
		expect(carrierScoped.body.data).toEqual([]);

		const storeScoped = await store.listWorkItems(carrierIntegrationId);
		expect(storeScoped.map((item) => item.id)).not.toContain(carrierRunId);
		const allLegacy = await store.listWorkItems();
		expect(allLegacy.map((item) => item.id)).not.toContain(carrierRunId);
		expect(allLegacy.map((item) => item.id)).toContain(legacyRunId);

		// The new-Key path reuses the legacy contract column instead of restructuring it.
		const [carrierWorkItem] = await client.run(
			"select request_contract,key_id,task_id from orchestration_work_items where id=$1",
			carrierRunId,
		);
		expect(carrierWorkItem?.request_contract).toBe("legacy_prompt");
		expect(String(carrierWorkItem?.key_id)).toBe(carrierKeyId);
	});

	test("T042 a direct lookup by the known carrier id is rejected by every legacy store surface", async () => {
		await expect(store.getLegacyIntegration(carrierIntegrationId)).rejects.toMatchObject({ status: 404 });
		await expect(store.updateAccess(carrierIntegrationId, "enable")).rejects.toMatchObject({ status: 404 });
		await expect(store.updateAccess(carrierIntegrationId, "rotate")).rejects.toMatchObject({ status: 404 });
		await expect(store.renameIntegration(carrierIntegrationId, "renamed-carrier")).rejects.toMatchObject({
			status: 404,
		});
		await expect(store.workItem(carrierRunId)).rejects.toMatchObject({ status: 404 });
		await expect(store.workItem(carrierRunId, carrierIntegrationId)).rejects.toMatchObject({ status: 404 });
		await expect(store.run(carrierRunId, carrierIntegrationId)).rejects.toMatchObject({ status: 404 });
		await expect(store.cancel(carrierRunId)).rejects.toMatchObject({ status: 404 });
		await expect(store.retry(carrierRunId)).rejects.toMatchObject({ status: 404 });

		// The carrier cannot log in through the legacy `oi_` contract, even with a
		// matching secret hash: the kind assertion runs before the hash check.
		const knownSecret = "A".repeat(43);
		await client.run(
			"update orchestration_integrations set secret_hash=$3 where tenant_id=$1 and id=$2",
			tenantId,
			carrierIntegrationId,
			credentialHash(knownSecret),
		);
		await expect(store.authenticate(`Bearer oi_${carrierIntegrationId}.${knownSecret}`)).rejects.toMatchObject({
			status: 401,
		});
		expect((await store.getIntegration(carrierIntegrationId)).kind).toBe("internal_key_carrier");
	});

	test("T042 every legacy HTTP admin and external route rejects the carrier id", async () => {
		const listed = await adminCall("/integrations", "GET");
		expect((listed.body.data as readonly { id: string }[]).map((item) => item.id)).not.toContain(
			carrierIntegrationId,
		);

		// create: a new integration is always a legacy one and the carrier stays hidden.
		const created = await adminCall("/integrations", "POST", {
			name: "admin-created",
			settings: { allowedModels: ["test"], bindings: [] },
			configuration: {
				systemPrompt: "Analyze",
				modelId: "test",
				parameters: {},
			},
		});
		expect(created.status).toBe(201);
		const createdId = (created.body.data as { id: string }).id;
		expect(createdId).toEqual(expect.any(String));
		const [createdRow] = await client.run("select kind from orchestration_integrations where id=$1", createdId);
		expect(createdRow?.kind).toBe("legacy");
		const afterCreate = await adminCall("/integrations", "GET");
		const afterCreateIds = (afterCreate.body.data as readonly { id: string }[]).map((item) => item.id);
		expect(afterCreateIds).toContain(createdId);
		expect(afterCreateIds).not.toContain(carrierIntegrationId);

		// migrate: the carrier is never migrated and gains no configuration.
		const configurationsBefore = await client.run(
			"select count(*)::int as n from orchestration_configurations where tenant_id=$1",
			tenantId,
		);
		const migrated = await adminCall(`/integrations/${carrierIntegrationId}/migrate`, "POST", {
			expected_revision: 1,
			expected_active_version: `pav_${orchestrationVersionId}`,
		});
		// A known carrier id is indistinguishable from a missing legacy Integration.
		expect(migrated.status).toBe(404);
		expect(migrated.body.error?.code).toBe("NOT_FOUND");
		const [carrierAfterMigrate] = await client.run(
			"select configuration_id,orchestration_version_id,published_app_id from orchestration_integrations where id=$1",
			carrierIntegrationId,
		);
		expect(String(carrierAfterMigrate?.configuration_id)).toBe(configurationId);
		expect(String(carrierAfterMigrate?.orchestration_version_id)).toBe(orchestrationVersionId);
		expect(carrierAfterMigrate?.published_app_id).toBeNull();
		const configurationsAfter = await client.run(
			"select count(*)::int as n from orchestration_configurations where tenant_id=$1",
			tenantId,
		);
		expect(Number(configurationsAfter[0]?.n)).toBe(Number(configurationsBefore[0]?.n));

		// debug-runs / patch / configuration: all rejected by the legacy-only lookup.
		const debugRun = await adminCall(`/integrations/${carrierIntegrationId}/debug-runs`, "POST", {
			requestId: randomUUID(),
			prompt: "carrier debug",
			credentials: {},
		});
		expect(debugRun.status).toBe(404);
		for (const action of ["enable", "disable", "rotate"]) {
			const patched = await adminCall(`/integrations/${carrierIntegrationId}`, "PATCH", { action });
			expect(patched.status).toBe(404);
		}
		const renamed = await adminCall(`/integrations/${carrierIntegrationId}`, "PATCH", {
			action: "rename",
			name: "renamed",
		});
		expect(renamed.status).toBe(404);
		expect((await adminCall(`/integrations/${carrierIntegrationId}/configuration`, "GET")).status).toBe(404);
		expect(
			(
				await adminCall(`/integrations/${carrierIntegrationId}/configuration`, "PUT", {
					expectedRevision: 1,
					systemPrompt: "x",
					modelId: "test",
					parameters: {},
				})
			).status,
		).toBe(404);

		// work-item surfaces.
		expect((await adminCall(`/work-items/${carrierRunId}`, "GET")).status).toBe(404);
		expect((await adminCall(`/work-items/${carrierRunId}/cancel`, "POST", {})).status).toBe(404);
		expect((await adminCall(`/work-items/${carrierRunId}/retry`, "POST", {})).status).toBe(404);

		// Configuration-grant surfaces (src/orchestration/configuration-http.ts).
		expect((await adminCall(`/integrations/${carrierIntegrationId}/configuration-grants`, "GET")).status).toBe(404);
		expect(
			(
				await adminCall(`/integrations/${carrierIntegrationId}/configuration-grants`, "POST", {
					name: "carrier-grant",
					permissions: ["config.view"],
					editable_fields: [],
					allowed_origins: ["https://carrier.test"],
				})
			).status,
		).toBe(404);
		expect(
			(
				await adminCall(`/integrations/${carrierIntegrationId}/configuration-grants/${randomUUID()}`, "PATCH", {
					expected_revision: 1,
					enabled: false,
				})
			).status,
		).toBe(404);
		const grantsBefore = await client.run(
			"select count(*)::int as n from orchestration_configuration_grants where tenant_id=$1",
			tenantId,
		);
		expect(Number(grantsBefore[0]?.n)).toBe(0);

		// The external configuration page and configuration contract reject the carrier.
		expect(
			(await call(`/aaas/integrations/${carrierIntegrationId}/configuration`, "GET", undefined, ADMIN)).status,
		).toBe(404);
		expect(
			(await call(`/api/aaas/v1/integrations/${carrierIntegrationId}/configuration`, "GET", undefined, ADMIN))
				.status,
		).toBe(404);
		expect(
			(
				await call(
					`/api/aaas/v1/integrations/${carrierIntegrationId}/draft`,
					"PUT",
					{
						expected_draft_revision: 1,
						changes: { systemPrompt: "x" },
					},
					ADMIN,
				)
			).status,
		).toBe(404);
		expect(
			(
				await call(
					`/api/aaas/v1/integrations/${carrierIntegrationId}/publish`,
					"POST",
					{ expected_draft_revision: 1, expected_active_version: "pav_x" },
					ADMIN,
				)
			).status,
		).toBe(404);
		expect(
			(
				await call(
					"/api/aaas/v1/configuration/exchange",
					"POST",
					{ integration_id: carrierIntegrationId, origin: "https://carrier.test" },
					`Bearer oc_${randomUUID()}.${"C".repeat(43)}`,
				)
			).status,
		).toBe(404);

		// The legacy external contract cannot address the carrier either.
		const carrierToken = `Bearer oi_${carrierIntegrationId}.${"B".repeat(43)}`;
		const externalEvent = await call(
			"/api/orchestration/v1/events",
			"POST",
			{
				eventId: randomUUID(),
				alarmId: "alarm-carrier",
				input: "x",
				credentials: {},
				credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
			},
			carrierToken,
		);
		expect(externalEvent.status).toBe(401);
		const carrierRun = await call(
			`/api/aaas/v1/integrations/${carrierIntegrationId}/runs`,
			"POST",
			{ prompt: "x" },
			`Bearer ${legacyToken}`,
			{ "Idempotency-Key": randomUUID() },
		);
		expect(carrierRun.status).toBe(404);
	});

	test("T042 admin projections retain Key-owned history without merging it into Integration usage", async () => {
		// FR-012 deliberately exposes the Key-owned Run to administrators.
		const tenant = tenantId as TenantId;
		const id = carrierConversationId as ConversationId;
		const conversations = await control.listConversations({ tenantId: tenant, limit: 50 });
		expect(conversations).toMatchObject({ ok: true, data: { items: expect.arrayContaining([
			expect.objectContaining({ id: `conv_${carrierConversationId}`, origin: "aaas_key", keyId: carrierKeyId, runId: carrierRunId }),
			expect.objectContaining({ id: `conv_${legacyConversationId}`, origin: "integration" }),
		]) } });
		const integrationOnly = await control.listConversations({ tenantId: tenant, limit: 50, origin: "integration" });
		expect(integrationOnly.ok).toBe(true);
		if (integrationOnly.ok) {
			const ids = integrationOnly.data.items.map((item) => item.id);
			expect(ids).toContain(`conv_${legacyConversationId}`);
			expect(ids).not.toContain(`conv_${carrierConversationId}`);
		}
		expect(await control.getConversationAdminDetail({ tenantId: tenant, conversationId: id })).toMatchObject({
			ok: true, data: { conversation: { origin: "aaas_key", keyId: carrierKeyId } },
		});
		expect((await control.listConversationSummaries({ tenantId: tenant, conversationId: id })).ok).toBe(true);
		expect((await control.getConversationSessionUsage({ tenantId: tenant, conversationId: id })).ok).toBe(true);
		const usage = await control.getUsageSummary({
			tenantId: tenant, from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000),
		});
		expect(usage).toMatchObject({ ok: true, data: { orchestration: {
			byIntegration: expect.arrayContaining([
				expect.objectContaining({ source: "aaas_key", integrationId: carrierIntegrationId }),
				expect.objectContaining({ source: "legacy", integrationId: legacy.id }),
			]),
			recentRuns: expect.arrayContaining([
				expect.objectContaining({ runId: carrierRunId, integrationId: carrierIntegrationId }),
				expect.objectContaining({ runId: legacyRunId, integrationId: legacy.id }),
			]),
		} } });
	});

	// ---------------------------------------------------------------------
	// C. Contract baseline (T044)
	// ---------------------------------------------------------------------

	test("T044 the legacy OpenAPI document still exposes exactly the three legacy paths", async () => {
		const document = await call("/api/aaas-docs/openapi.json", "GET", undefined, ADMIN);
		expect(document.status).toBe(200);
		expect(document.raw).toEqual(aaasOpenApi);
		expect(Object.keys(aaasOpenApi.paths)).toEqual([
			"/api/aaas/v1/integrations/{integration_id}/runs",
			"/api/aaas/v1/runs/{run_id}",
			"/api/aaas/v1/runs/{run_id}/cancel",
		]);
		expect(aaasOpenApi.components.securitySchemes.IntegrationToken).toEqual({
			type: "http",
			scheme: "bearer",
			description: "平台单独提供的 Integration Token",
		});
		expect(aaasOpenApi.security).toEqual([{ IntegrationToken: [] }]);
		expect(Object.keys(aaasOpenApi.components.securitySchemes)).toEqual(["IntegrationToken"]);
		// The published contract still documents both legacy input semantics.
		const createRun = aaasOpenApi.components.schemas.CreateRun;
		expect(createRun.oneOf).toEqual([
			{ required: ["prompt"], not: { required: ["input"] } },
			{ required: ["input"], not: { required: ["prompt"] } },
		]);
		expect(Object.keys(createRun.properties).sort()).toEqual([
			"credentials",
			"external_ref",
			"input",
			"metadata",
			"prompt",
		]);
	});

	test("rollback compatibility serves legacy HTTP while leaving Key assignments untouched", async () => {
		const running = await apiKeyRuns.submit(carrierPrincipal, "rollback-running", {
			prompt: "running",
			mcp_servers: [],
		});
		const claimed = await claimUntil(running.run_id);
		const queued = await apiKeyRuns.submit(carrierPrincipal, "rollback-queued", {
			prompt: "queued",
			mcp_servers: [],
		});
		const rollbackHttp = createOrchestrationHttp(service, (request) => request.headers.authorization === ADMIN);
		const rollbackServer = createServer((request, response) => {
			void Promise.resolve(rollbackHttp(request, response)).then((handled) => {
				if (!handled && !response.headersSent) response.writeHead(404).end();
			});
		});
		await new Promise<void>((resolve) => rollbackServer.listen(0, "127.0.0.1", resolve));
		const address = rollbackServer.address();
		if (!address || typeof address === "string") throw new Error("rollback HTTP listen failed");
		const endpoint = `http://127.0.0.1:${address.port}`;
		const request = (path: string, method: string, auth: string, body?: unknown) =>
			fetch(`${endpoint}${path}`, {
				method,
				headers: { authorization: auth, "content-type": "application/json", "idempotency-key": "rollback-legacy" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const execute = vi.spyOn(service, "execute");
		let dispatcher: Awaited<ReturnType<typeof startOrchestrationDispatcher>> | undefined;
		try {
			const list = await request("/api/admin/v1/orchestration/integrations", "GET", ADMIN);
			expect(list.status).toBe(200);
			expect(await list.text()).not.toContain(carrierIntegrationId);
			const change = await request(
				`/api/admin/v1/orchestration/integrations/${carrierIntegrationId}`,
				"PATCH",
				ADMIN,
				{ action: "disable" },
			);
			expect(change.status).toBe(404);
			const carrierAuth = await request(
				`/api/aaas/v1/integrations/${carrierIntegrationId}/runs`,
				"POST",
				`Bearer oi_${carrierIntegrationId}.${"A".repeat(43)}`,
				{ prompt: "x" },
			);
			expect(carrierAuth.status).toBe(401);
			const disabledKeyApi = await request("/api/aaas/v1/runs", "POST", "Bearer ak_invalid", { prompt: "x" });
			expect(disabledKeyApi.status).toBe(401);
			const submitted = await request(
				`/api/aaas/v1/integrations/${legacy.id}/runs`,
				"POST",
				`Bearer ${legacyToken}`,
				{ prompt: "rollback legacy" },
			);
			expect(submitted.status).toBe(202);
			const legacyData = (await submitted.json()) as { data: RunData };
			dispatcher = await startOrchestrationDispatcher(service, () => {}, { legacyOnly: true });
			await expect
				.poll(async () => (await store.run(legacyData.data.run_id, legacy.id)).status, { timeout: 8000 })
				.toBe("completed");
			const queried = await request(`/api/aaas/v1/runs/${legacyData.data.run_id}`, "GET", `Bearer ${legacyToken}`);
			expect(queried.status).toBe(200);
			const cancelled = await request(
				`/api/aaas/v1/runs/${legacyData.data.run_id}/cancel`,
				"POST",
				`Bearer ${legacyToken}`,
				{},
			);
			expect(cancelled.status).toBe(200);
			const [runningState] = await client.run("select state from orchestration_assignments where id=$1", claimed.id);
			const [queuedState] = await client.run(
				"select state from orchestration_work_items where id=$1",
				queued.run_id,
			);
			expect(runningState?.state).toBe("running");
			expect(queuedState?.state).toBe("queued");
			expect(
				execute.mock.calls.some(([a]) => a.workItemId === queued.run_id || a.workItemId === running.run_id),
			).toBe(false);
		} finally {
			await dispatcher?.close();
			execute.mockRestore();
			await new Promise<void>((resolve) => rollbackServer.close(() => resolve()));
		}
	}, 30000);

	test("independent configuration draft and version lifecycle keeps default and accepted snapshots frozen", async () => {
		const [before] = await client.run(
			"select count(*)::int as n from orchestration_integrations where tenant_id=$1",
			tenantId,
		);
		const draft = { systemPrompt: "", modelId: "test", parameters: {}, mcpServers: [], skills: [] };
		const created = await adminCall("/configurations", "POST", { name: "aaas-independent", draft });
		expect(created.status).toBe(201);
		const configuration = created.body.data as { id: string; draftRevision: number };
		const [after] = await client.run(
			"select count(*)::int as n from orchestration_integrations where tenant_id=$1",
			tenantId,
		);
		expect(after?.n).toBe(before?.n);
		expect(
			(
				await call(
					`/api/admin/v1/orchestration/configurations/${configuration.id}`,
					"GET",
					undefined,
					"Bearer invalid",
				)
			).status,
		).toBe(401);
		const foreignTenant = randomUUID();
		const foreignConfig = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'foreign-config','active')", foreignTenant);
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,draft) values ($1,$2,'private',$3::jsonb)",
			foreignConfig,
			foreignTenant,
			draft,
		);
		expect((await adminCall(`/configurations/${foreignConfig}`, "GET")).status).toBe(404);
		const publish = await adminCall(`/configurations/${configuration.id}/versions`, "POST", { expectedRevision: 1 });
		expect(publish.status).toBe(201);
		const version1 = (publish.body.data as { id: string }).id;
		expect((await keys.platformConfigurationView())?.orchestration_version_id).toBe(orchestrationVersionId);
		await keys.setPlatformConfiguration(configuration.id, version1, []);
		const key = await keys.create("snapshot-config");
		const principal = await keys.authenticate(`Bearer ${key.token}`);
		const first = await apiKeyRuns.submit(principal, "config-snapshot", { prompt: "dynamic", mcp_servers: [] });
		const saved = await adminCall(`/configurations/${configuration.id}/draft`, "PUT", {
			expectedRevision: 1,
			draft: { ...draft, contextPolicy: { maxContextTokens: 12000 } },
		});
		expect(saved.status).toBe(200);
		expect(
			(await adminCall(`/configurations/${configuration.id}/draft`, "PUT", { expectedRevision: 1, draft })).status,
		).toBe(409);
		const second = await adminCall(`/configurations/${configuration.id}/versions`, "POST", { expectedRevision: 2 });
		expect(second.status).toBe(201);
		const version2 = (second.body.data as { id: string }).id;
		expect(version2).not.toBe(version1);
		expect((await keys.platformConfigurationView())?.orchestration_version_id).toBe(version1);
		await keys.setPlatformConfiguration(configuration.id, version2, []);
		const [work] = await client.run(
			"select capability_snapshot from orchestration_work_items where id=$1",
			first.run_id,
		);
		expect(work?.capability_snapshot).toMatchObject({ orchestrationVersionId: version1 });
		expect(
			await apiKeyRuns.submit(principal, "config-snapshot", { prompt: "dynamic", mcp_servers: [] }),
		).toMatchObject({ run_id: first.run_id, duplicate: true });
		const detail = await adminCall(`/configurations/${configuration.id}/versions/${version1}`, "GET");
		expect(detail.status).toBe(200);
		expect((detail.body.data as { snapshot: { contextPolicy?: unknown } }).snapshot.contextPolicy).toBeUndefined();
		const concurrent = await Promise.all([
			adminCall(`/configurations/${configuration.id}/draft`, "PUT", { expectedRevision: 2, draft }),
			adminCall(`/configurations/${configuration.id}/draft`, "PUT", { expectedRevision: 2, draft }),
		]);
		expect(concurrent.map((result) => result.status).sort()).toEqual([200, 409]);
		await expect(
			client.run("update orchestration_versions set snapshot='{}'::jsonb where id=$1", version1),
		).rejects.toThrow();
		await keys.setPlatformConfiguration(configurationId, orchestrationVersionId);
	});

	test("applyCurrentConfiguration saves and activates in one step while keeping accepted snapshots frozen", async () => {
		const draft = { systemPrompt: "", modelId: "test", parameters: {}, mcpServers: [], skills: [] };
		const applied = await adminCall("/configurations/current", "PUT", {
			configuration_id: null,
			name: "gateway-style",
			draft,
			credential_bindings: [],
		});
		expect(applied.status).toBe(200);
		const first = applied.body.data as { configurationId: string; orchestrationVersionId: string; revision: number };
		expect(first.revision).toBe(1);
		// Saving a non-platform-default configuration moves only its own active pointer.
		const choice = (await keys.configurationChoices()).find((c) => c.configuration_id === first.configurationId);
		expect(choice?.orchestration_version_id).toBe(first.orchestrationVersionId);
		expect((await keys.versionBindings(first.orchestrationVersionId))).toEqual([]);

		// A Key following this configuration resolves to its active version.
		const key = await keys.create("apply-snapshot", null, first.configurationId);
		const principal = await keys.authenticate(`Bearer ${key.token}`);
		const before = await apiKeyRuns.submit(principal, "apply-before", { prompt: "x", mcp_servers: [] });
		const [beforeWork] = await client.run(
			"select capability_snapshot from orchestration_work_items where id=$1",
			before.run_id,
		);
		expect(beforeWork?.capability_snapshot).toMatchObject({ orchestrationVersionId: first.orchestrationVersionId });

		const secondApply = await adminCall("/configurations/current", "PUT", {
			configuration_id: first.configurationId,
			name: "gateway-style",
			draft: { ...draft, systemPrompt: "changed" },
			credential_bindings: [],
		});
		expect(secondApply.status).toBe(200);
		const next = secondApply.body.data as { orchestrationVersionId: string; revision: number };
		expect(next.revision).toBe(2);
		expect(next.orchestrationVersionId).not.toBe(first.orchestrationVersionId);
		const conflict = await adminCall("/configurations/current", "PUT", {
			configuration_id: first.configurationId,
			name: "gateway-style",
			draft,
			expected_revision: 1,
			credential_bindings: [],
		});
		expect(conflict.status).toBe(409);
		const nextChoice = (await keys.configurationChoices()).find((c) => c.configuration_id === first.configurationId);
		expect(nextChoice?.orchestration_version_id).toBe(next.orchestrationVersionId);
		// Platform default is untouched by saving a named configuration.
		expect((await keys.platformConfigurationView())?.configuration_id).not.toBe(first.configurationId);
		// Accepted Run keeps its frozen snapshot from the old version.
		const [work] = await client.run(
			"select capability_snapshot from orchestration_work_items where id=$1",
			before.run_id,
		);
		expect(work?.capability_snapshot).toMatchObject({ orchestrationVersionId: first.orchestrationVersionId });
		await expect(
			client.run("update orchestration_versions set snapshot='{}'::jsonb where id=$1", first.orchestrationVersionId),
		).rejects.toThrow();
	});

	test("T044 the API Key contract is published separately and leaves the legacy document untouched", async () => {
		const keyDocument = await call("/api/aaas-docs/v1/openapi.json", "GET", undefined, ADMIN);
		expect(keyDocument.status).toBe(200);
		expect(keyDocument.raw).toEqual(aaasApiKeyOpenApi);
		expect(Object.keys(aaasApiKeyOpenApi.components.securitySchemes)).toEqual(["ApiKey", "AdminBearer"]);
		expect(aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys"].get.security).toEqual([{ AdminBearer: [] }]);
		expect(aaasApiKeyOpenApi.security).toEqual([{ ApiKey: [] }]);

		// The legacy document is unchanged by the new one.
		const legacyDocument = await call("/api/aaas-docs/openapi.json", "GET", undefined, ADMIN);
		expect(legacyDocument.raw).toEqual(aaasOpenApi);
		expect(Object.keys(aaasOpenApi.paths)).toHaveLength(3);
		expect(aaasOpenApi).not.toEqual(aaasApiKeyOpenApi);
		expect(JSON.stringify(aaasOpenApi)).not.toContain("ApiKey");
		expect(JSON.stringify(aaasApiKeyOpenApi)).not.toContain("IntegrationToken");
	});
});

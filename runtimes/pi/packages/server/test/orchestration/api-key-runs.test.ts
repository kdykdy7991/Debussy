/**
 * Phase 4 (US1) acceptance: unified Run submit, idempotent replay, ownership
 * isolation, credential validation, capability intersection and terminal states.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const SCHEMA = `aaas_runs_${process.pid}_${Date.now().toString(36)}`;
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

describe.skipIf(!pgUp)("unified Run acceptance on isolated Postgres", () => {
	let client: PostgresClient;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	const tenantId = randomUUID();
	const configurationId = randomUUID();
	const versionId = randomUUID();
	const masterKey = new Uint8Array(32).fill(21);
	const availableServers: { mcpServerId: string; status: string; currentRevision: number }[] = [];

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run(`insert into tenants(id,name,status) values ($1,'runs-test','active')`, tenantId);
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);
		const { canonicalJson, sha256Hex } = await import("../../src/publishing/runtime-spec/hash.ts");
		const { parseRuntimeSpec } = await import("../../src/publishing/runtime-spec/schema.ts");
		const draft = {
			schemaVersion: 1,
			publishedAppVersionId: `orv_${versionId}`,
			agent: {
				systemPrompt: "platform",
				model: { provider: "test", modelId: "test-model" },
			},
			capabilities: { mcpServers: [] },
			contextPolicy: {},
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		};
		const normalized = parseRuntimeSpec(draft);
		if (!normalized.ok) throw new Error(`invalid fixture spec: ${normalized.errors.join("; ")}`);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,1,$5::jsonb,$6)`,
			versionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			normalized.spec,
			sha256Hex(canonicalJson(normalized.spec)),
		);
		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		await keys.setPlatformConfiguration(configurationId, versionId, []);
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store: new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey)),
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos: {
				mcpServers: {
					list: async () => availableServers,
					get: async () => undefined,
				},
			} as unknown as ConstructorParameters<typeof ApiKeyRunService>[0]["repos"],
		});
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	async function principalFor(name: string) {
		const created = await keys.create(name);
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		return { created, principal };
	}

	test("version binding freezes each Run and replay survives switching", async () => {
		const second = randomUUID();
		await client.run(`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
		 select $1,tenant_id,configuration_id,snapshot,1234,runtime_spec,runtime_spec_hash from orchestration_versions where tenant_id=$2 and id=$3`, second, tenantId, versionId);
		const { principal } = await principalFor("version-switch");
		const body = { prompt: "version test", mcp_servers: [] };
		const first = await runs.submit(principal, "version-1", body);
		await keys.setKeyVersion(principal.keyId, second);
		await expect(runs.submit(principal, "version-unregistered", body)).rejects.toMatchObject({ code: "CONFIGURATION_UNAVAILABLE" });
		await keys.setVersionBindings(second, []);
		const next = await runs.submit(principal, "version-2", body);
		expect((await runs.submit(principal, "version-1", body)).run_id).toBe(first.run_id);
		await keys.setKeyVersion(principal.keyId, null);
		const last = await runs.submit(principal, "version-3", body);
		const rows = await client.run("select id,orchestration_version_id,capability_snapshot from orchestration_work_items where id=any($1::uuid[])", [first.run_id, next.run_id, last.run_id] as unknown as string);
		const versions = Object.fromEntries(rows.map((row) => [String(row.id), String(row.orchestration_version_id)]));
		expect(versions).toEqual({ [first.run_id]: versionId, [next.run_id]: second, [last.run_id]: versionId });
		await expect(keys.setVersionBindings(second, [{ mcpServerId: `mcp_${randomUUID()}`, toolName: "x", parameter: "x", credentialId: "x" }])).rejects.toThrow();
		await expect(keys.setKeyVersion(principal.keyId, randomUUID())).rejects.toMatchObject({ code: "INVALID_VERSION" });
		const otherTenant = randomUUID();
		const otherConfig = randomUUID();
		const otherVersion = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'other','active')", otherTenant);
		await client.run("insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'other','{}'::jsonb,1)", otherConfig, otherTenant);
		await client.run(`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash) select $1,$2,$3,snapshot,1,runtime_spec,runtime_spec_hash from orchestration_versions where tenant_id=$4 and id=$5`, otherVersion, otherTenant, otherConfig, tenantId, versionId);
		await expect(keys.setKeyVersion(principal.keyId, otherVersion)).rejects.toMatchObject({ code: "INVALID_VERSION" });
	});

	test("submit creates one Run; same request replays; changed content returns 409", async () => {
		const { principal } = await principalFor("run-a");
		const body = { prompt: "complete task", task_id: "biz-1", mcp_servers: [] };
		const first = await runs.submit(principal, "idem-1", body);
		expect(first.duplicate).toBe(false);
		expect(first.status).toBe("queued");

		const replay = await runs.submit(principal, "idem-1", body);
		expect(replay.duplicate).toBe(true);
		expect(replay.run_id).toBe(first.run_id);

		await expect(runs.submit(principal, "idem-1", { ...body, prompt: "different" })).rejects.toMatchObject({
			status: 409,
		});
		const count = await client.run(
			"select count(*)::int as n from orchestration_work_items where tenant_id=$1 and key_id=$2",
			tenantId,
			principal.keyId,
		);
		expect(Number(count[0]?.n)).toBe(1);
	});

	test("acceptance audit is written once for a new Run and never for rejected requests", async () => {
		const { created, principal } = await principalFor("audit-acceptance");
		const prompt = "audit-only-sensitive-prompt";
		const body = { prompt, mcp_servers: [] };
		const accepted = await runs.submit(principal, "audit-key", body);
		const replay = await runs.submit(principal, "audit-key", body);
		expect(replay).toMatchObject({ run_id: accepted.run_id, duplicate: true });
		await expect(runs.submit(principal, "audit-key", { ...body, prompt: "changed" })).rejects.toMatchObject({
			status: 409,
		});
		await expect(runs.submit(principal, "audit-invalid", { prompt: "", mcp_servers: [] })).rejects.toMatchObject({
			status: 400,
		});
		const rows = await client.run(
			"select actor_type,actor_id,action,resource_type,resource_id,request_id,metadata from audit_events where tenant_id=$1 and actor_id=$2",
			tenantId,
			principal.keyId,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actor_type: "aaas_api_key",
			actor_id: principal.keyId,
			action: "aaas.run.accepted",
			resource_type: "aaas_run",
			resource_id: accepted.run_id,
			metadata: { carrier_integration_id: (await keys.authenticate(`Bearer ${created.token}`)).carrierIntegrationId },
		});
		expect(JSON.stringify(rows)).not.toContain(prompt);
		expect(JSON.stringify(rows)).not.toContain(created.token);
	});

	test("an audit insert failure rolls back the Run and idempotency record", async () => {
		const { principal } = await principalFor("audit-rollback");
		await client.run(
			"alter table audit_events add constraint test_reject_acceptance check (action <> 'aaas.run.accepted') not valid",
		);
		try {
			await expect(
				runs.submit(principal, "audit-rollback", { prompt: "rollback", mcp_servers: [] }),
			).rejects.toThrow();
			const [counts] = await client.run(
				`select (select count(*)::int from orchestration_work_items where tenant_id=$1 and key_id=$2) as runs,
				 (select count(*)::int from aaas_key_idempotency where tenant_id=$1 and key_id=$2) as records,
				 (select count(*)::int from audit_events where tenant_id=$1 and actor_id=($2::uuid)::text) as audits`,
				tenantId,
				principal.keyId,
			);
			expect(counts).toMatchObject({ runs: 0, records: 0, audits: 0 });
		} finally {
			await client.run("alter table audit_events drop constraint test_reject_acceptance");
		}
	});

	test("task_id is only a business reference; different idempotency keys create different Runs", async () => {
		const { principal } = await principalFor("run-b");
		const a = await runs.submit(principal, "idem-a", { prompt: "x", task_id: "same", mcp_servers: [] });
		const b = await runs.submit(principal, "idem-b", { prompt: "x", task_id: "same", mcp_servers: [] });
		expect(b.run_id).not.toBe(a.run_id);
	});

	test("unknown credential values in prompt are rejected without creating a Run", async () => {
		const { principal } = await principalFor("run-c");
		const serverId = `mcp_${randomUUID()}`;
		await expect(
			runs.submit(principal, "idem-c", {
				prompt: "use this secret-value-xyz in the task",
				mcp_servers: [],
				credentials: {
					servers: { [serverId]: { connection: { credential_id: "connection", value: "secret-value-xyz" } } },
				},
			}),
		).rejects.toMatchObject({ status: 400, code: "CREDENTIAL_IN_INPUT" });
		const count = await client.run(
			"select count(*)::int as n from orchestration_work_items where tenant_id=$1 and key_id=$2",
			tenantId,
			principal.keyId,
		);
		expect(Number(count[0]?.n)).toBe(0);
	});

	test("unauthorised MCP selection is rejected; empty array enables none", async () => {
		const { principal } = await principalFor("run-d");
		await expect(
			runs.submit(principal, "idem-d", { prompt: "x", mcp_servers: [`mcp_${randomUUID()}`] }),
		).rejects.toMatchObject({ status: 400 });
		const accepted = await runs.submit(principal, "idem-d2", { prompt: "x", mcp_servers: [] });
		const [snapshot] = await client.run(
			"select capability_snapshot from orchestration_work_items where id=$1",
			accepted.run_id,
		);
		expect((snapshot?.capability_snapshot as { servers: unknown[] }).servers).toEqual([]);
	});

	test("cross-Key query and cancel are both 404 and do not reveal existence", async () => {
		const owner = await principalFor("run-owner");
		const other = await principalFor("run-other");
		const created = await runs.submit(owner.principal, "idem-owner", { prompt: "x", mcp_servers: [] });
		const otherRun = await runs.submit(other.principal, "idem-other", { prompt: "y", mcp_servers: [] });
		await expect(runs.run(other.principal, created.run_id)).rejects.toMatchObject({ status: 404 });
		await expect(runs.cancel(other.principal, created.run_id)).rejects.toMatchObject({ status: 404 });
		await expect(runs.run(owner.principal, otherRun.run_id)).rejects.toMatchObject({ status: 404 });
		await expect(runs.cancel(owner.principal, otherRun.run_id)).rejects.toMatchObject({ status: 404 });
		const outcomes = await Promise.allSettled([
			runs.run(other.principal, created.run_id),
			runs.run(other.principal, randomUUID()),
			runs.cancel(other.principal, created.run_id),
			runs.cancel(other.principal, randomUUID()),
		]);
		const errors = outcomes.map((outcome) => {
			if (outcome.status !== "rejected") throw new Error("unexpected access");
			const error = outcome.reason as { status: number; code: string; message: string };
			return { status: error.status, code: error.code, message: error.message };
		});
		expect(errors).toEqual([errors[0], errors[0], errors[0], errors[0]]);
		expect((await runs.run(owner.principal, created.run_id)).run_id).toBe(created.run_id);
	});

	test("cancel reaches terminal state and replay keeps the original Run", async () => {
		const { principal } = await principalFor("run-e");
		const body = { prompt: "cancel me", mcp_servers: [] };
		const created = await runs.submit(principal, "idem-e", body);
		const cancelled = await runs.cancel(principal, created.run_id);
		expect(cancelled.status).toBe("cancelled");
		const again = await runs.cancel(principal, created.run_id);
		expect(again.status).toBe("cancelled");
		const replay = await runs.submit(principal, "idem-e", body);
		expect(replay.run_id).toBe(created.run_id);
		expect(replay.status).toBe("cancelled");
	});

	test("usage is scoped to the owning Key and reports unknown usage as null", async () => {
		const { principal } = await principalFor("run-f");
		await runs.submit(principal, "idem-f", { prompt: "x", mcp_servers: [] });
		const usage = await runs.usage(principal);
		expect(usage.key_id).toBe(principal.keyId);
		expect(usage.runs).toBe(1);
		expect(usage.usage).toBeNull();
		const other = await principalFor("run-g");
		expect((await runs.usage(other.principal)).runs).toBe(0);
	});

	/**
	 * A Run whose `turn/end` carries a complete `llmUsage` must report the real
	 * provider tokens. `partial` is a sibling of `total` inside `llmUsage`; reading
	 * it from `total` never matches and used to report every Key as "unknown".
	 */
	test("usage reports the real provider tokens of a Run with a complete llmUsage turn", async () => {
		const { principal } = await principalFor("run-usage");
		const created = await runs.submit(principal, "idem-usage", { prompt: "x", mcp_servers: [] });
		await appendTurnEnd(created.run_id, 1, {
			input: 400,
			output: 100,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 600,
		});
		const usage = await runs.usage(principal);
		expect(usage.runs).toBe(1);
		expect(usage.usage).toEqual({
			status: "covered",
			covered_runs: 1,
			missing_runs: 0,
			total_tokens: 600,
			input_tokens: 400,
			output_tokens: 100,
		});
	});

	test("usage distinguishes reported zero from an entirely unreported partial turn", async () => {
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		const { principal } = await principalFor("run-usage-zero");
		const created = await runs.submit(principal, "idem-usage-zero", { prompt: "x", mcp_servers: [] });
		await appendTerminal(created.run_id, 1, "turn/end", zero, [true]);
		expect((await runs.usage(principal)).usage).toEqual({
			status: "covered",
			covered_runs: 1,
			missing_runs: 0,
			total_tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
		});

		const unknown = await principalFor("run-usage-unreported");
		const unknownRun = await runs.submit(unknown.principal, "idem-usage-unreported", {
			prompt: "x",
			mcp_servers: [],
		});
		await appendTerminal(unknownRun.run_id, 1, "turn/end", zero, [false]);
		expect((await runs.usage(unknown.principal)).usage).toBeNull();
	});

	test("a reported zero among unreported calls remains partial with known zero consumption", async () => {
		const { principal } = await principalFor("run-usage-mixed-zero");
		const created = await runs.submit(principal, "idem-usage-mixed-zero", { prompt: "x", mcp_servers: [] });
		await appendTerminal(
			created.run_id,
			1,
			"turn/end",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			[true, false],
		);
		expect((await runs.usage(principal)).usage).toEqual({
			status: "partial",
			covered_runs: 0,
			missing_runs: 1,
			total_tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
		});
	});

	/** `covered_runs` counts RUNS: several turns of one Run still count as one Run. */
	test("usage counts a Run once even when it produced several turns", async () => {
		const { principal } = await principalFor("run-usage-multi");
		const created = await runs.submit(principal, "idem-usage-multi", { prompt: "x", mcp_servers: [] });
		await appendTurnEnd(created.run_id, 1, {
			input: 400,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 500,
		});
		await appendTurnEnd(created.run_id, 2, { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 250 });
		const usage = await runs.usage(principal);
		expect(usage.runs).toBe(1);
		expect(usage.usage).toEqual({
			status: "covered",
			covered_runs: 1,
			missing_runs: 0,
			total_tokens: 750,
			input_tokens: 600,
			output_tokens: 150,
		});
	});

	/** An incomplete/cancelled turn still contributes its confirmed tokens to the Key. */
	test("usage reports confirmed tokens of a cancelled run without marking it covered", async () => {
		const { principal } = await principalFor("run-usage-cancelled");
		const created = await runs.submit(principal, "idem-usage-cancelled", { prompt: "x", mcp_servers: [] });
		await appendTerminal(created.run_id, 1, "turn/interrupted", {
			input: 30,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 33,
		});
		const usage = await runs.usage(principal);
		expect(usage.runs).toBe(1);
		expect(usage.usage).toEqual({
			status: "partial",
			covered_runs: 0,
			missing_runs: 1,
			total_tokens: 33,
			input_tokens: 30,
			output_tokens: 3,
		});
	});

	/** A Run whose turn only carries the legacy single-call usage stays "unknown". */
	test("usage stays null for a Run that only has legacy single-call usage", async () => {
		const { principal } = await principalFor("run-usage-legacy");
		const created = await runs.submit(principal, "idem-usage-legacy", { prompt: "x", mcp_servers: [] });
		await appendTurnEnd(created.run_id, 1, null);
		const usage = await runs.usage(principal);
		expect(usage.usage).toBeNull();
	});

	async function conversationOf(runId: string): Promise<string> {
		const [row] = await client.run("select conversation_id from orchestration_work_items where id=$1", runId);
		return String(row?.conversation_id);
	}

	/**
	 * Orchestration conversations carry `source='orchestration'`: no published app,
	 * but an integration and an owner principal (see migration 0027).
	 */
	async function appendTurnEnd(
		runId: string,
		sequence: number,
		total: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null,
	): Promise<void> {
		await appendTerminal(runId, sequence, "turn/end", total);
	}

	async function appendTerminal(
		runId: string,
		sequence: number,
		eventType: "turn/end" | "turn/interrupted",
		total: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null,
		reported?: boolean[],
	): Promise<void> {
		const conversationId = await conversationOf(runId);
		const [conversation] = await client.run(
			"select integration_id, owner_principal_id from conversations where id=$1",
			conversationId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload,source,integration_id,owner_principal_id)
			 values ($1,$2,null,$3,$4,$5,$6,$7::jsonb,'orchestration',$8,$9)`,
			randomUUID(),
			tenantId,
			conversationId,
			sequence,
			eventType,
			randomUUID(),
			total === null
				? { usage: { input: 999, output: 99, cacheRead: 0, cacheWrite: 0, totalTokens: 1098 } }
				: {
						llmUsage: {
							calls: reported?.map((usageReported) => ({ model: "Qwen", ...total, usageReported })) ?? [
								{ model: "Qwen", ...total, cacheReadReported: true },
							],
							total: { ...total, cacheReadReported: true, cacheReadReportedCallCount: 1 },
							callCount: reported?.length ?? 1,
							partial: reported?.includes(false) ?? false,
						},
					},
			conversation?.integration_id ?? null,
			conversation?.owner_principal_id ?? null,
		);
	}

	test("multi-Server/Tool credentials are accepted and the Run settings satisfy settingsSchema", async () => {
		const mcpServerId = randomUUID();
		const serverId = `mcp_${mcpServerId}`;
		const multiVersionId = randomUUID();
		const { canonicalJson, sha256Hex } = await import("../../src/publishing/runtime-spec/hash.ts");
		const { parseRuntimeSpec } = await import("../../src/publishing/runtime-spec/schema.ts");
		const draft = {
			schemaVersion: 1,
			publishedAppVersionId: `orv_${multiVersionId}`,
			agent: { systemPrompt: "platform", model: { provider: "test", modelId: "test-model" } },
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
								inputSchema: {
									type: "object",
									properties: { account: { type: "string" } },
									required: ["account"],
								},
								inputSchemaHash: "a".repeat(64),
							},
							{ name: "lookup_more", description: null, inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] }, inputSchemaHash: "a".repeat(64) },
						],
					},
				],
			},
			contextPolicy: {},
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		};
		const normalized = parseRuntimeSpec(draft);
		if (!normalized.ok) throw new Error(`invalid fixture spec: ${normalized.errors.join("; ")}`);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,2,$5::jsonb,$6)`,
			multiVersionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			normalized.spec,
			sha256Hex(canonicalJson(normalized.spec)),
		);
		await keys.setPlatformConfiguration(configurationId, multiVersionId, [
			{ mcpServerId: serverId, toolName: "lookup", parameter: "account", credentialId: "account_token" },
			{ mcpServerId: serverId, toolName: "lookup_more", parameter: "token", credentialId: "other_token" },
		]);
		expect(await keys.versionBindings(versionId)).toEqual([]);
		expect(await keys.versionBindings(multiVersionId)).toMatchObject([{ credentialId: "account_token" }, { credentialId: "other_token" }]);
		await expect(keys.setVersionBindings(multiVersionId, [])).rejects.toMatchObject({ code: "BINDING_IMMUTABLE" });
		availableServers.push({ mcpServerId, status: "enabled", currentRevision: 1 });

		const { principal } = await principalFor("run-multi");
		await keys.setKeyVersion(principal.keyId, versionId);
		await expect(runs.submit(principal, "idem-multi-old-version", { prompt: "x", mcp_servers: [serverId] })).rejects.toMatchObject({ code: "INVALID_MCP_SELECTION" });
		await keys.setKeyVersion(principal.keyId, multiVersionId);
		await expect(
			runs.submit(principal, "idem-multi-missing", { prompt: "x", mcp_servers: [serverId] }),
		).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });

		const created = await runs.submit(principal, "idem-multi", {
			prompt: "x",
			mcp_servers: [serverId],
			credentials: {
				servers: { [serverId]: { connection: { credential_id: "connection", value: "conn-secret-123" } } },
				tools: { [serverId]: { lookup: { account_token: "acct-secret-456" }, lookup_more: { other_token: "other-secret-456" } } },
			},
		});
		const audit = await client.run(
			"select * from audit_events where tenant_id=$1 and resource_id=$2",
			tenantId,
			created.run_id,
		);
		expect(audit).toHaveLength(1);
		expect(JSON.stringify(audit)).not.toContain("conn-secret-123");
		expect(JSON.stringify(audit)).not.toContain("acct-secret-456");
		expect(created.duplicate).toBe(false);
		const [row] = await client.run(
			"select settings,capability_snapshot from orchestration_work_items where id=$1",
			created.run_id,
		);
		const { settingsSchema } = await import("../../src/orchestration/contracts.ts");
		const settings = settingsSchema.parse(row?.settings);
		expect(settings.allowedModels).toEqual(["test-model"]);
		expect(settings.bindings).toHaveLength(2);
		expect(settings.bindings[0]?.credential).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
		const snapshot = row?.capability_snapshot as { servers: readonly { serverId: string }[] };
		expect(snapshot.servers).toHaveLength(1);
		expect(snapshot.servers[0]?.serverId).toBe(serverId);
		const sharedBody = { prompt: "shared tools", mcp_servers: [serverId], credentials: { servers: { [serverId]: { connection_credential: "connect-shared", tool_credential: "tool-shared" } } } };
		const shared = await runs.submit(principal, "idem-shared", sharedBody);
		const [sharedRow] = await client.run("select settings from orchestration_work_items where id=$1", shared.run_id);
		expect(settingsSchema.parse(sharedRow?.settings).bindings.map((binding) => binding.toolName)).toEqual(["lookup", "lookup_more"]);
		expect((await runs.submit(principal, "idem-shared", sharedBody))).toMatchObject({ run_id: shared.run_id, duplicate: true });
		await expect(runs.submit(principal, "idem-shared-missing", { ...sharedBody, credentials: { servers: { [serverId]: { connection_credential: "connect-shared" } } } })).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
		await expect(runs.submit(principal, "idem-shared-mixed", { ...sharedBody, credentials: { ...sharedBody.credentials, tools: {} } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		const metadata = await runs.mcpServers(principal);
		expect(metadata[0]?.credential_requirements).toEqual({ connection_credential: true, tool_credential: true });
	});

	test("T024: invalid platform mappings and extra credentials are rejected before any Run", async () => {
		const mcpServerId = randomUUID();
		const serverId = `mcp_${mcpServerId}`;
		const t024VersionId = randomUUID();
		const { canonicalJson, sha256Hex } = await import("../../src/publishing/runtime-spec/hash.ts");
		const { parseRuntimeSpec } = await import("../../src/publishing/runtime-spec/schema.ts");
		const draft = {
			schemaVersion: 1,
			publishedAppVersionId: `orv_${t024VersionId}`,
			agent: { systemPrompt: "platform", model: { provider: "test", modelId: "test-model" } },
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
								inputSchema: {
									type: "object",
									properties: { account: { type: "string" } },
									required: ["account"],
								},
								inputSchemaHash: "b".repeat(64),
							},
						],
					},
				],
			},
			contextPolicy: {},
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		};
		const normalized = parseRuntimeSpec(draft);
		if (!normalized.ok) throw new Error(`invalid fixture spec: ${normalized.errors.join("; ")}`);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,3,$5::jsonb,$6)`,
			t024VersionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			normalized.spec,
			sha256Hex(canonicalJson(normalized.spec)),
		);
		const valid = { mcpServerId: serverId, toolName: "lookup", parameter: "account", credentialId: "account_token" };
		for (const invalid of [
			{ ...valid, toolName: "missing-tool" },
			{ ...valid, parameter: "missing_parameter" },
			{ ...valid, mcpServerId: `mcp_${randomUUID()}` },
		])
			await expect(keys.setPlatformConfiguration(configurationId, t024VersionId, [invalid])).rejects.toMatchObject({
				code: "INVALID_BINDING",
			});
		await expect(keys.setPlatformConfiguration(configurationId, t024VersionId, [valid, valid])).rejects.toMatchObject(
			{
				code: "INVALID_BINDING",
			},
		);
		await keys.setPlatformConfiguration(configurationId, t024VersionId, [valid]);
		availableServers.push({ mcpServerId, status: "enabled", currentRevision: 1 });
		const { principal } = await principalFor("run-t024");
		const base = {
			prompt: "x",
			mcp_servers: [serverId],
			credentials: {
				servers: { [serverId]: { connection: { credential_id: "connection", value: "conn-secret" } } },
				tools: { [serverId]: { lookup: { account_token: "account-secret" } } },
			},
		};
		const runsBefore = await client.run(
			"select count(*)::int as n from orchestration_work_items where tenant_id=$1",
			tenantId,
		);
		await expect(
			runs.submit(principal, "t024-extra-tool", {
				...base,
				credentials: {
					...base.credentials,
					tools: { [serverId]: { lookup: { account_token: "account-secret" }, other: { x: "other-secret" } } },
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
		await expect(
			runs.submit(principal, "t024-extra-credential", {
				...base,
				credentials: {
					...base.credentials,
					tools: { [serverId]: { lookup: { account_token: "account-secret", extra_token: "extra-secret" } } },
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
		const runsAfter = await client.run(
			"select count(*)::int as n from orchestration_work_items where tenant_id=$1",
			tenantId,
		);
		expect(runsAfter[0]?.n).toBe(runsBefore[0]?.n);
		const created = await runs.submit(principal, "t024-ok", base);
		expect(created.status).toBe("queued");
		// Restore the shared platform configuration used by the base fixtures.
		await keys.setPlatformConfiguration(configurationId, versionId);
	});
});

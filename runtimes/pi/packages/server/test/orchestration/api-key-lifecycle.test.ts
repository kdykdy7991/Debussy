/**
 * T047 / T048 / T049 acceptance: the independent API Key lifecycle end to end.
 *
 * Plaintext shown once, disable/enable/revoke, rotation that keeps the logical Key
 * ID and its historical Run/Usage attribution, sequential and concurrent idempotency,
 * an authorisation change that does not rewrite an accepted replay, and per-Key usage.
 *
 * Requires the isolated test database; the whole file is skipped (NOT RUN) when it
 * is unreachable.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { createApiKeyHttp } from "../../src/orchestration/api-key-http.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const SCHEMA = `aaas_lifecycle_${process.pid}_${Date.now().toString(36)}`;
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

/** The platform MCP registry seam used by `ApiKeyRunService.effectiveCapabilities`. */
interface RegistryServer {
	readonly mcpServerId: string;
	readonly name: string;
	readonly status: "enabled" | "disabled";
	readonly currentRevision: number;
}

const serverAlpha = `mcp_${randomUUID()}`;

describe.skipIf(!pgUp)("API Key lifecycle on isolated Postgres", () => {
	let client: PostgresClient;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	let server: Server;
	let base: string;
	const tenantId = randomUUID();
	const configurationId = randomUUID();
	const versionId = randomUUID();
	const masterKey = new Uint8Array(32).fill(41);
	const registry: readonly RegistryServer[] = [
		{ mcpServerId: serverAlpha.slice(4), name: "Alpha Server", status: "enabled", currentRevision: 1 },
	];

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run(`insert into tenants(id,name,status) values ($1,'aaas-lifecycle-test','active')`, tenantId);
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);
		const draft = {
			schemaVersion: 1,
			publishedAppVersionId: `orv_${versionId}`,
			agent: { systemPrompt: "platform", model: { provider: "test", modelId: "test-model" } },
			capabilities: {
				mcpServers: [
					{
						mcpServerId: serverAlpha,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://mcp.example.com/alpha",
						authentication: "bearer",
						tools: [
							{
								name: "lookup",
								description: "Look up one account",
								inputSchema: {
									type: "object",
									properties: { account: { type: "string" }, query: { type: "string" } },
									required: ["account", "query"],
								},
								inputSchemaHash: "a".repeat(64),
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
			 values ($1,$2,$3,$4::jsonb,1,$5::jsonb,$6)`,
			versionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			normalized.spec,
			sha256Hex(canonicalJson(normalized.spec)),
		);
		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		await keys.setPlatformConfiguration(configurationId, versionId, [
			{ mcpServerId: serverAlpha, toolName: "lookup", parameter: "account", credentialId: "account_token" },
		]);
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store: new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey)),
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos: {
				mcpServers: {
					list: async () => registry,
					get: async (_scope: unknown, mcpServerId: string) =>
						registry.find((entry) => entry.mcpServerId === mcpServerId),
				},
			} as unknown as ConstructorParameters<typeof ApiKeyRunService>[0]["repos"],
		});
		const handler = createApiKeyHttp({ keys, runs, isAdmin: () => true });
		server = createServer((request, response) => {
			void Promise.resolve(handler(request, response)).then((handled: boolean) => {
				if (!handled && !response.headersSent) {
					response.writeHead(599);
					response.end("unclaimed");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no listen address");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	async function call(
		method: string,
		path: string,
		options: { authorization?: string; body?: unknown; idempotencyKey?: string } = {},
	): Promise<{ status: number; text: string; data: unknown }> {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: {
				...(options.authorization === undefined ? {} : { authorization: options.authorization }),
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
				...(options.idempotencyKey === undefined ? {} : { "idempotency-key": options.idempotencyKey }),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		});
		const text = await response.text();
		let data: unknown = text;
		if (text !== "") {
			try {
				data = JSON.parse(text) as unknown;
			} catch {
				// Marker body from the "not claimed" branch is plain text.
			}
		}
		return { status: response.status, text, data };
	}

	async function countWorkItems(keyId: string): Promise<number> {
		const rows = await client.run(
			"select count(*)::int as n from orchestration_work_items where tenant_id=$1 and key_id=$2",
			tenantId,
			keyId,
		);
		return Number(rows[0]?.n);
	}

	test("Key issuance precedes platform configuration; first concurrent Runs share one carrier", async () => {
		await client.run("delete from aaas_platform_configuration where tenant_id=$1", tenantId);
		const created = await keys.create("independent-key");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		expect(principal.carrierIntegrationId).toBeNull();
		await expect(runs.submit(principal, "before-config", { prompt: "hello", mcp_servers: [] })).rejects.toMatchObject(
			{ code: "CONFIGURATION_UNAVAILABLE" },
		);
		expect(await countWorkItems(created.record.keyId)).toBe(0);
		await keys.setPlatformConfiguration(configurationId, versionId, [
			{ mcpServerId: serverAlpha, toolName: "lookup", parameter: "account", credentialId: "account_token" },
		]);
		await expect(
			runs.submit(principal, "missing-credentials", { prompt: "one", mcp_servers: [serverAlpha] }),
		).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
		expect(
			await client.run(
				"select 1 from aaas_key_carriers where tenant_id=$1 and key_id=$2",
				tenantId,
				created.record.keyId,
			),
		).toHaveLength(0);
		const [first, second] = await Promise.all([
			runs.submit(principal, "first", { prompt: "one", mcp_servers: [] }),
			runs.submit(principal, "second", { prompt: "two", mcp_servers: [] }),
		]);
		expect(first.run_id).not.toBe(second.run_id);
		const carriers = await client.run(
			"select carrier_integration_id from aaas_key_carriers where tenant_id=$1 and key_id=$2",
			tenantId,
			created.record.keyId,
		);
		expect(carriers).toHaveLength(1);
		expect((await keys.authenticate(`Bearer ${created.token}`)).carrierIntegrationId).toBe(
			String(carriers[0]?.carrier_integration_id),
		);
		await client.run("update aaas_platform_configuration set enabled=false where tenant_id=$1", tenantId);
		try {
			expect((await runs.submit(principal, "first", { prompt: "one", mcp_servers: [] })).run_id).toBe(first.run_id);
		} finally {
			await client.run("update aaas_platform_configuration set enabled=true where tenant_id=$1", tenantId);
		}
		await runs.cancel(principal, first.run_id);
		await runs.cancel(principal, second.run_id);
	});

	test("the plaintext secret is shown once and never exposed again", async () => {
		const created = await keys.create("plaintext-once");
		expect(created.token).toMatch(/^ak_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
		const secret = created.token.split(".")[1] ?? "";
		expect(secret).not.toBe("");

		const listed = await keys.list();
		const entry = listed.find((key) => key.keyId === created.record.keyId);
		expect(entry).toBeDefined();
		expect(Object.keys(entry ?? {})).toEqual([
			"keyId", "name", "status", "createdAt", "updatedAt", "orchestrationVersionId", "orchestrationConfigurationId",
			"configurationMode", "routerCapabilityScope", "directCapabilityRevision",
		]);
		expect(entry).toMatchObject({ orchestrationVersionId: null, orchestrationConfigurationId: null, configurationMode: "platform" });
		expect(JSON.stringify(listed)).not.toContain(created.token);
		expect(JSON.stringify(listed)).not.toContain(secret);

		const principal = await keys.authenticate(`Bearer ${created.token}`);
		expect(principal.keyId).toBe(created.record.keyId);
		expect(principal.secretHash).toMatch(/^[0-9a-f]{64}$/);
		expect(principal.secretHash).not.toBe(secret);
		expect(principal.secretHash).not.toBe(created.token);
		expect(JSON.stringify(principal)).not.toContain(secret);

		const rows = await client.run(
			"select secret_hash from aaas_api_keys where tenant_id=$1 and id=$2",
			tenantId,
			created.record.keyId,
		);
		const stored = String(rows[0]?.secret_hash);
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
		expect(stored).not.toBe(secret);
		expect(stored).not.toBe(created.token);
	});

	test("a disabled Key is rejected on every protected endpoint and can be enabled again", async () => {
		const created = await keys.create("disable-cycle");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const run = await runs.submit(principal, "idem-before-disable", { prompt: "before disable", mcp_servers: [] });

		await keys.updateAccess(created.record.keyId, "disable");
		await expect(keys.authenticate(`Bearer ${created.token}`)).rejects.toMatchObject({ status: 401 });

		const rejected = await Promise.all([
			call("POST", "/api/aaas/v1/runs", {
				authorization: `Bearer ${created.token}`,
				idempotencyKey: "idem-while-disabled",
				body: { prompt: "while disabled", mcp_servers: [] },
			}),
			call("GET", `/api/aaas/v1/runs/${run.run_id}`, { authorization: `Bearer ${created.token}` }),
			call("POST", `/api/aaas/v1/runs/${run.run_id}/cancel`, { authorization: `Bearer ${created.token}` }),
			call("GET", "/api/aaas/v1/mcp-servers", { authorization: `Bearer ${created.token}` }),
		]);
		for (const result of rejected) {
			expect(result.status).toBe(401);
			expect((result.data as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
			// No protected data is returned.
			expect(result.text).not.toContain(run.run_id);
		}
		// The rejected cancel did not change the Run.
		expect((await runs.run(principal, run.run_id)).status).toBe("queued");

		await keys.updateAccess(created.record.keyId, "enable");
		await expect(keys.authenticate(`Bearer ${created.token}`)).resolves.toMatchObject({
			keyId: created.record.keyId,
		});
		const restored = await call("GET", `/api/aaas/v1/runs/${run.run_id}`, {
			authorization: `Bearer ${created.token}`,
		});
		expect(restored.status).toBe(200);
	});

	test("a revoked Key is terminal and can never authenticate again", async () => {
		const created = await keys.create("revoke-terminal");
		await keys.updateAccess(created.record.keyId, "revoke");
		await expect(keys.authenticate(`Bearer ${created.token}`)).rejects.toMatchObject({ status: 401 });
		await expect(keys.updateAccess(created.record.keyId, "enable")).rejects.toMatchObject({
			status: 409,
			code: "KEY_REVOKED",
		});
		await expect(keys.updateAccess(created.record.keyId, "rotate")).rejects.toMatchObject({
			status: 409,
			code: "KEY_REVOKED",
		});
		await expect(keys.updateAccess(created.record.keyId, "disable")).rejects.toMatchObject({
			status: 409,
			code: "KEY_REVOKED",
		});
		const rejected = await call("GET", "/api/aaas/v1/mcp-servers", {
			authorization: `Bearer ${created.token}`,
		});
		expect(rejected.status).toBe(401);
		expect((await keys.list()).find((key) => key.keyId === created.record.keyId)?.status).toBe("revoked");
	});

	test("rotation issues a new secret, invalidates the old one and keeps the Key ID, Runs and Usage", async () => {
		const created = await keys.create("rotation");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const run = await runs.submit(principal, "idem-before-rotation", {
			prompt: "before rotation",
			mcp_servers: [],
		});
		const before = await runs.usage(principal);
		expect(before.key_id).toBe(created.record.keyId);
		expect(before.runs).toBe(1);

		const rotated = await keys.updateAccess(created.record.keyId, "rotate");
		expect(rotated.token).toBeDefined();
		expect(rotated.token).not.toBe(created.token);
		// The logical Key ID is unchanged.
		expect(rotated.token?.startsWith(`ak_${created.record.keyId}.`)).toBe(true);
		await expect(keys.authenticate(`Bearer ${created.token}`)).rejects.toMatchObject({ status: 401 });
		const rotatedPrincipal = await keys.authenticate(`Bearer ${rotated.token ?? ""}`);
		expect(rotatedPrincipal.keyId).toBe(created.record.keyId);

		// The historical Run and its usage stay attributed to the same logical Key ID.
		const after = await runs.usage(rotatedPrincipal);
		expect(after.key_id).toBe(created.record.keyId);
		expect(after.runs).toBe(1);
		expect(after.by_status).toEqual({ queued: 1 });
		expect((await runs.run(rotatedPrincipal, run.run_id)).run_id).toBe(run.run_id);
		const workRows = await client.run("select key_id from orchestration_work_items where id=$1", run.run_id);
		expect(String(workRows[0]?.key_id)).toBe(created.record.keyId);
		const keyRows = await client.run(
			"select id,status from aaas_api_keys where tenant_id=$1 and id=$2",
			tenantId,
			created.record.keyId,
		);
		expect(String(keyRows[0]?.id)).toBe(created.record.keyId);
		expect(String(keyRows[0]?.status)).toBe("enabled");
	});

	test("rotation preserves idempotent replay and isolation between Keys", async () => {
		const owner = await keys.create("rotation-replay");
		const other = await keys.create("rotation-replay-other");
		const stalePrincipal = await keys.authenticate(`Bearer ${owner.token}`);
		const body = { prompt: "rotation replay", task_id: "rotation-task", mcp_servers: [] };
		const idempotencyKey = "rotation-replay-key";
		const submit = async (token: string, request: typeof body) =>
			runs.submit(await keys.authenticate(`Bearer ${token}`), idempotencyKey, request);

		const firstRun = await submit(owner.token, body);
		expect(firstRun.duplicate).toBe(false);

		const rotated = await keys.updateAccess(owner.record.keyId, "rotate");
		expect(rotated.token).toBeDefined();
		const newToken = rotated.token!;
		expect((await keys.authenticate(`Bearer ${newToken}`)).keyId).toBe(owner.record.keyId);
		const replay = await submit(newToken, body);
		expect(replay).toMatchObject({ run_id: firstRun.run_id, duplicate: true });
		await expect(submit(owner.token, body)).rejects.toMatchObject({ status: 401 });
		await expect(runs.submit(stalePrincipal, idempotencyKey, body)).rejects.toMatchObject({ status: 401 });

		await expect(submit(newToken, { ...body, prompt: "different" })).rejects.toMatchObject({
			status: 409,
			code: "EVENT_CONFLICT",
		});
		const otherRun = await submit(other.token, body);
		expect(otherRun).toMatchObject({ duplicate: false });
		expect(otherRun.run_id).not.toBe(firstRun.run_id);
		const otherReplay = await submit(other.token, body);
		expect(otherReplay).toMatchObject({ run_id: otherRun.run_id, duplicate: true });
		expect(await countWorkItems(owner.record.keyId)).toBe(1);
		expect(await countWorkItems(other.record.keyId)).toBe(1);
	});

	test("the same idempotency key and body create exactly one Run; a changed body is a conflict", async () => {
		const created = await keys.create("idempotent-sequential");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const body = { prompt: "do the work", task_id: "biz-1", mcp_servers: [] };
		const first = await runs.submit(principal, "idem-sequential", body);
		expect(first.duplicate).toBe(false);
		expect(first.status).toBe("queued");

		const second = await runs.submit(principal, "idem-sequential", body);
		expect(second.duplicate).toBe(true);
		expect(second.run_id).toBe(first.run_id);
		expect(await countWorkItems(created.record.keyId)).toBe(1);

		await expect(runs.submit(principal, "idem-sequential", { ...body, prompt: "different" })).rejects.toMatchObject({
			status: 409,
			code: "EVENT_CONFLICT",
		});
		expect(await countWorkItems(created.record.keyId)).toBe(1);
	});

	test("two Keys are independent under the same idempotency key, and the same task_id is not a key", async () => {
		const first = await keys.create("idem-key-a");
		const firstPrincipal = await keys.authenticate(`Bearer ${first.token}`);
		const second = await keys.create("idem-key-b");
		const secondPrincipal = await keys.authenticate(`Bearer ${second.token}`);
		const body = { prompt: "same body", task_id: "shared-task", mcp_servers: [] };

		const firstRun = await runs.submit(firstPrincipal, "shared-idempotency-key", body);
		const secondRun = await runs.submit(secondPrincipal, "shared-idempotency-key", body);
		expect(firstRun.duplicate).toBe(false);
		expect(secondRun.duplicate).toBe(false);
		expect(secondRun.run_id).not.toBe(firstRun.run_id);
		expect(await countWorkItems(first.record.keyId)).toBe(1);
		expect(await countWorkItems(second.record.keyId)).toBe(1);

		const third = await runs.submit(firstPrincipal, "task-idempotency-1", body);
		const fourth = await runs.submit(firstPrincipal, "task-idempotency-2", body);
		expect(third.duplicate).toBe(false);
		expect(fourth.duplicate).toBe(false);
		expect(fourth.run_id).not.toBe(third.run_id);
		expect(await countWorkItems(first.record.keyId)).toBe(3);
	});

	test("concurrent submissions of one idempotency key create exactly one Run", async () => {
		const created = await keys.create("concurrent-idempotency");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const body = { prompt: "concurrent work", task_id: "concurrency-1", mcp_servers: [] };
		const results = await Promise.all([
			runs.submit(principal, "idem-concurrent", body),
			runs.submit(principal, "idem-concurrent", body),
			runs.submit(principal, "idem-concurrent", body),
			runs.submit(principal, "idem-concurrent", body),
			runs.submit(principal, "idem-concurrent", body),
		]);
		const runIds = new Set(results.map((result) => result.run_id));
		expect(runIds.size).toBe(1);
		expect(results.filter((result) => result.duplicate === false)).toHaveLength(1);
		expect(await countWorkItems(created.record.keyId)).toBe(1);
	});

	test("a platform configuration change does not alter an accepted replay or its snapshot", async () => {
		const created = await keys.create("configuration-replay");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const body = {
			prompt: "configuration replay",
			mcp_servers: [serverAlpha],
			credentials: {
				servers: { [serverAlpha]: { connection: { credential_id: "connection", value: "conn-secret-123" } } },
				tools: { [serverAlpha]: { lookup: { account_token: "acct-secret-456" } } },
			},
		};
		const first = await runs.submit(principal, "configuration-replay", body);
		const [before] = await client.run(
			"select capability_snapshot,capability_snapshot_hash from orchestration_work_items where tenant_id=$1 and id=$2",
			tenantId,
			first.run_id,
		);
		const otherVersion = randomUUID();
		await client.run(`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash) select $1,tenant_id,configuration_id,snapshot,777,runtime_spec,runtime_spec_hash from orchestration_versions where tenant_id=$2 and id=$3`, otherVersion, tenantId, versionId);
		try {
			await keys.setPlatformConfiguration(configurationId, otherVersion, []);
			const replay = await runs.submit(principal, "configuration-replay", body);
			expect(replay).toMatchObject({ run_id: first.run_id, duplicate: true });
			const [after] = await client.run(
				"select capability_snapshot,capability_snapshot_hash from orchestration_work_items where tenant_id=$1 and id=$2",
				tenantId,
				first.run_id,
			);
			expect(after).toEqual(before);
			await expect(runs.submit(principal, "configuration-new", body)).rejects.toMatchObject({
				status: 400,
				code: "INVALID_CREDENTIAL",
			});
			expect(await countWorkItems(created.record.keyId)).toBe(1);
		} finally {
			await keys.setPlatformConfiguration(configurationId, versionId, [
				{ mcpServerId: serverAlpha, toolName: "lookup", parameter: "account", credentialId: "account_token" },
			]);
		}
	});

	test("an unavailable historical digest key fails closed after authentication without creating a Run", async () => {
		const created = await keys.create("missing-digest-version");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const body = { prompt: "digest version replay", mcp_servers: [] };
		const first = await runs.submit(principal, "missing-digest-version", body);
		const missingHistory = new ApiKeyRunService({
			client,
			tenantId,
			keys,
			store: new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey)),
			idempotency: new IdempotencyKeyring({ masterKey, currentVersion: 2 }),
			repos: {} as ConstructorParameters<typeof ApiKeyRunService>[0]["repos"],
		});
		await expect(missingHistory.submit(principal, "missing-digest-version", body)).rejects.toMatchObject({
			status: 500,
			code: "IDEMPOTENCY_KEY_UNAVAILABLE",
		});
		await keys.updateAccess(created.record.keyId, "disable");
		await expect(missingHistory.submit(principal, "missing-digest-version", body)).rejects.toMatchObject({
			status: 401,
		});
		expect(await countWorkItems(created.record.keyId)).toBe(1);
		const [record] = await client.run(
			"select work_item_id,digest_key_version from aaas_key_idempotency where tenant_id=$1 and key_id=$2 and idempotency_key=$3",
			tenantId,
			created.record.keyId,
			"missing-digest-version",
		);
		expect(record).toMatchObject({ work_item_id: first.run_id, digest_key_version: 1 });
	});

	test("disabled carrier rejects new Runs, holds queued work, and resumes after restoration", async () => {
		const store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey));
		for (let pending = await store.claim(); pending; pending = await store.claim()) {
			await store.complete(pending.id, "cleared fixture", null);
		}
		const created = await keys.create("carrier-state");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const queued = await runs.submit(principal, "carrier-queued", { prompt: "queued", mcp_servers: [] });
		const carrierId = (await keys.authenticate(`Bearer ${created.token}`)).carrierIntegrationId;
		expect(carrierId).not.toBeNull();
		await client.run(
			"update orchestration_integrations set enabled=false where tenant_id=$1 and id=$2",
			tenantId,
			carrierId,
		);
		try {
			// This is an internal carrier failure, not a change to the Key's identity.
			expect((await keys.authenticate(`Bearer ${created.token}`)).keyId).toBe(principal.keyId);
			await expect(
				runs.submit(principal, "carrier-disabled", { prompt: "new", mcp_servers: [] }),
			).rejects.toMatchObject({
				status: 403,
				code: "DISABLED",
			});
			expect(await countWorkItems(principal.keyId)).toBe(1);
			expect(await store.claim()).toBeUndefined();
			expect((await runs.run(principal, queued.run_id)).status).toBe("queued");

			await client.run(
				"update orchestration_integrations set enabled=true where tenant_id=$1 and id=$2",
				tenantId,
				carrierId,
			);
			const claimed = await store.claim();
			expect(claimed?.workItemId).toBe(queued.run_id);
			await store.complete(claimed!.id, "carrier restored", null);
			expect(await runs.run(principal, queued.run_id)).toMatchObject({
				status: "completed",
				result: "carrier restored",
			});
		} finally {
			await client.run(
				"update orchestration_integrations set enabled=true where tenant_id=$1 and id=$2",
				tenantId,
				carrierId,
			);
		}
	});

	test("usage counts only the owning Key's Runs and reports unknown provider usage as null", async () => {
		const owner = await keys.create("usage-owner");
		const ownerPrincipal = await keys.authenticate(`Bearer ${owner.token}`);
		await runs.submit(ownerPrincipal, "usage-1", { prompt: "first", mcp_servers: [] });
		await runs.submit(ownerPrincipal, "usage-2", { prompt: "second", mcp_servers: [] });
		const usage = await runs.usage(ownerPrincipal);
		expect(usage.key_id).toBe(owner.record.keyId);
		expect(usage.runs).toBe(2);
		expect(usage.by_status).toEqual({ queued: 2 });
		// No provider usage was recorded: unknown, never a fabricated zero.
		expect(usage.usage).toBeNull();

		const other = await keys.create("usage-other");
		const otherPrincipal = await keys.authenticate(`Bearer ${other.token}`);
		const otherUsage = await runs.usage(otherPrincipal);
		expect(otherUsage.key_id).toBe(other.record.keyId);
		expect(otherUsage.runs).toBe(0);
		expect(otherUsage.by_status).toEqual({});
		expect(otherUsage.usage).toBeNull();
	});
});

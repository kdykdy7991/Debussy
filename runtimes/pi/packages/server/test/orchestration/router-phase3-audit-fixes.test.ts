/**
 * Router V1 phase three audit fixes: legacy /runs scope gate, exact tool
 * projection, migration source consistency and the two MCP HTTP contracts.
 * Runs only against an isolated PostgreSQL database; otherwise NOT RUN.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { createApiKeyHttp } from "../../src/orchestration/api-key-http.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { createRouterAdmin } from "../../src/orchestration/router-admin.ts";
import { RouterRuntime } from "../../src/orchestration/router-runtime.ts";
import { createPiRuntimeAdapter } from "../../src/runtime/pi-runtime-adapter.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import {
	buildRouterCapabilitySnapshot,
	resolveEffectiveCapabilities,
	saveDirectCapabilities,
} from "../../src/orchestration/router-capability.ts";
import { migrateRouterKeys, resolveMigrationSourceVersion } from "../../src/orchestration/router-key-migration.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { newMcpServerId, newMcpToolId, type TenantId } from "../../src/publishing/domain/ids.ts";
import { createControlHttpHandler } from "../../src/publishing/control/http.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const ADMIN_URL = process.env.PI_ROUTER_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const DATABASE = `router_fix_${process.pid}_${Date.now().toString(36)}`;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../src/persistence/postgres/migrations/", import.meta.url));
const masterKey = new Uint8Array(32).fill(31);
const tenantId = randomUUID();
const ADMIN_TOKEN = "control-admin-token-0123456789abcdef0123456789abcdef";
const schemaA = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
const schemaB = { type: "object", properties: { query: { type: "string" }, authToken: { type: "string" } }, required: ["query"] };
const hashA = sha256Hex(canonicalJson(schemaA));
const hashB = sha256Hex(canonicalJson(schemaB));

function databaseUrl(): string {
	const url = new URL(ADMIN_URL);
	url.pathname = `/${DATABASE}`;
	return url.toString();
}
async function probe(): Promise<boolean> {
	const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
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

function call(options: {
	base: string;
	method: string;
	path: string;
	token?: string;
	body?: unknown;
	extra?: Record<string, string>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
	const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, options.base);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: {
					host: url.host,
					"content-type": "application/json",
					...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
					...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
					...options.extra,
				},
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					try {
						resolve({
							status: response.statusCode ?? 0,
							body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
						});
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe.skipIf(!pgUp)("Router V1 phase three audit fixes", () => {
	let client: PostgresClient;
	let repos: ReturnType<typeof createPublishingRepositories>;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	let baselineDir: string;
	let keyServer: Server;
	let keyBase: string;
	let controlServer: Server;
	let controlBase: string;
	let routerToken: string;
	let dualToken: string;
	let abServerId: string;
	let migrationServerId: string;
	let platformOldVersionId: string;
	let platformActiveVersionId: string;
	let legacyVersionId: string;
	let migrationKeyId: string;
	let migrationToken: string;
	let unsupportedKeyId: string;
	let unregisteredKeyId: string;

	beforeAll(async () => {
		const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
			await admin.run(`create database ${DATABASE}`);
		} finally {
			await admin.close();
		}
		client = new PostgresClient({ url: databaseUrl(), connectTimeoutSeconds: 5 });
		baselineDir = mkdtempSync(join(tmpdir(), "router-fix-baseline-"));
		for (const file of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort())
			symlinkSync(join(MIGRATIONS_DIR, file), join(baselineDir, file));
		await runMigrations(client, { migrationsDir: baselineDir });
		repos = createPublishingRepositories(client);
		await client.run("insert into tenants(id,name,status) values ($1,'audit-fix','active')", tenantId);
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'legacy',1,$3::jsonb,$2)",
			randomUUID(),
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		const baseSpec = (versionId: string) => {
			const parsed = parseRuntimeSpec({
				schemaVersion: 1,
				publishedAppVersionId: `orv_${versionId}`,
				agent: { systemPrompt: "x", model: { provider: "test", modelId: "test-model" } },
				capabilities: { mcpServers: [] },
			});
			if (!parsed.ok) throw new Error("fixture spec invalid");
			return parsed.spec;
		};
		const writeVersion = async (
			versionId: string,
			configurationId: string,
			spec: unknown,
			draftRevision = 1,
		): Promise<void> => {
			const hash = sha256Hex(canonicalJson(spec));
			await client.run(
				`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
				 values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)`,
				versionId,
				tenantId,
				configurationId,
				{ modelId: "test-model" },
				draftRevision,
				spec as object,
				hash,
			);
		};
		const platformConfigId = randomUUID();
		platformOldVersionId = randomUUID();
		platformActiveVersionId = randomUUID();
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,enabled,draft,draft_revision) values ($1,$2,'platform',true,$3::jsonb,1)",
			platformConfigId,
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		await writeVersion(platformOldVersionId, platformConfigId, baseSpec(platformOldVersionId));
		const abId = newMcpServerId();
		abServerId = `mcp_${abId}`;
		const aRule = { mcpServerId: abServerId, toolName: "A", parameter: "query", credentialId: "tool_credential" };
		const bRule = { mcpServerId: abServerId, toolName: "B", parameter: "authToken", credentialId: "tool_credential" };
		await repos.mcpServers.create({
			server: {
				mcpServerId: abId,
				tenantId: tenantId as TenantId,
				name: "ab-server",
				status: "enabled",
				currentRevision: 1,
				lastTestOk: null,
				lastTestLatencyMs: null,
				lastTestAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			revision: {
				mcpServerId: abId,
				tenantId: tenantId as TenantId,
				revision: 1,
				transport: "streamable_http",
				endpoint: "https://ab.example.test/mcp",
				authentication: "api_key",
				sensitiveBindings: [aRule, bRule],
				createdAt: new Date(),
			},
			tools: [
				{
					mcpToolId: newMcpToolId(),
					tenantId: tenantId as TenantId,
					mcpServerId: abId,
					mcpRevision: 1,
					name: "A",
					description: "tool A",
					inputSchema: schemaA,
					inputSchemaHash: hashA,
					sensitiveBindings: [aRule],
					createdAt: new Date(),
				},
				{
					mcpToolId: newMcpToolId(),
					tenantId: tenantId as TenantId,
					mcpServerId: abId,
					mcpRevision: 1,
					name: "B",
					description: "tool B",
					inputSchema: schemaB,
					inputSchemaHash: hashB,
					sensitiveBindings: [bRule],
					createdAt: new Date(),
				},
			],
		});
		const migId = newMcpServerId();
		migrationServerId = `mcp_${migId}`;
		await repos.mcpServers.create({
			server: {
				mcpServerId: migId,
				tenantId: tenantId as TenantId,
				name: "migration-server",
				status: "enabled",
				currentRevision: 1,
				lastTestOk: null,
				lastTestLatencyMs: null,
				lastTestAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			revision: {
				mcpServerId: migId,
				tenantId: tenantId as TenantId,
				revision: 1,
				transport: "streamable_http",
				endpoint: "https://migration.example.test/mcp",
				authentication: "none",
				sensitiveBindings: null,
				createdAt: new Date(),
			},
			tools: [
				{
					mcpToolId: newMcpToolId(),
					tenantId: tenantId as TenantId,
					mcpServerId: migId,
					mcpRevision: 1,
					name: "lookup",
					description: "lookup",
					inputSchema: schemaA,
					inputSchemaHash: hashA,
					sensitiveBindings: null,
					createdAt: new Date(),
				},
			],
		});
		await repos.mcpServers.addRevision({
			scope: { tenantId: tenantId as TenantId },
			mcpServerId: migId,
			revision: {
				mcpServerId: migId,
				tenantId: tenantId as TenantId,
				transport: "streamable_http",
				endpoint: "https://migration.example.test/mcp",
				authentication: "none",
				// Same schema/auth as the source Revision but rules are NOT registered.
				sensitiveBindings: null,
				createdAt: new Date(),
			},
			tools: [
				{
					mcpToolId: newMcpToolId(),
					tenantId: tenantId as TenantId,
					mcpServerId: migId,
					name: "lookup",
					description: "lookup",
					inputSchema: schemaA,
					inputSchemaHash: hashA,
					sensitiveBindings: null,
					createdAt: new Date(),
				},
			],
		});
		const activeBase = baseSpec(platformActiveVersionId);
		await writeVersion(platformActiveVersionId, platformConfigId, {
			...activeBase,
			agent: { ...activeBase.agent, model: { ...activeBase.agent.model, params: { temperature: 0.3 } } },
			capabilities: {
				...activeBase.capabilities,
				mcpServers: [
					{
						mcpServerId: migrationServerId,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://migration.example.test/mcp",
						authentication: "none",
						tools: [{ name: "lookup", description: "lookup", inputSchema: schemaA, inputSchemaHash: hashA }],
					},
				],
			},
		}, 2);
		await client.run(
			"update orchestration_configurations set active_version_id=$2 where tenant_id=$1 and id=$3",
			tenantId,
			platformActiveVersionId,
			platformConfigId,
		);
		await client.run(
			"insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings) values ($1,$2,'[]'::jsonb)",
			tenantId,
			platformOldVersionId,
		);
		await client.run(
			"insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings) values ($1,$2,'[]'::jsonb)",
			tenantId,
			platformActiveVersionId,
		);
		const legacyConfigId = randomUUID();
		legacyVersionId = randomUUID();
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,enabled,draft,draft_revision) values ($1,$2,'legacy-key',true,$3::jsonb,1)",
			legacyConfigId,
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		await writeVersion(legacyVersionId, legacyConfigId, baseSpec(legacyVersionId));
		await client.run(
			"insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings) values ($1,$2,'[]'::jsonb)",
			tenantId,
			legacyVersionId,
		);
		await client.run(
			`insert into aaas_platform_configuration(tenant_id,configuration_id,orchestration_version_id,credential_bindings)
			 values ($1,$2,$3,'[]'::jsonb)`,
			tenantId,
			platformConfigId,
			platformOldVersionId,
		);
		keys = new ApiKeyStore(client, tenantId, masterKey);
		const store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(new Uint8Array(32).fill(17)));
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos,
		});
		const router = await keys.create("router-only");
		routerToken = router.token;
		await saveDirectCapabilities({
			client,
			repos,
			tenantId,
			keyId: router.record.keyId,
			expectedRevision: 0,
			scope: "router",
			capabilities: {
				model: { provider: "test", model_id: "test-model", parameters: {} },
				mcp_servers: [{ server_id: abServerId, revision: 1, authentication: "api_key", tool_allowlist: ["A"] }],
				skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});
		const dual = await keys.create("dual", legacyVersionId);
		dualToken = dual.token;
		await client.run("update aaas_api_keys set router_capability_scope='dual' where tenant_id=$1 and id=$2", tenantId, dual.record.keyId);
		const migrationKey = await keys.create("migrate-platform");
		migrationKeyId = migrationKey.record.keyId;
		migrationToken = migrationKey.token;
		const unsupportedConfigId = randomUUID();
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,enabled,draft,draft_revision) values ($1,$2,'unsupported',true,$3::jsonb,1)",
			unsupportedConfigId,
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		const unsupportedVersionId = randomUUID();
		const unsupportedBase = baseSpec(unsupportedVersionId);
		await writeVersion(unsupportedVersionId, unsupportedConfigId, {
			...unsupportedBase,
			agent: {
				...unsupportedBase.agent,
				model: { ...unsupportedBase.agent.model, params: { unsupportedKnob: 7 } },
			},
		});
		await client.run(
			"insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings) values ($1,$2,'[]'::jsonb)",
			tenantId,
			unsupportedVersionId,
		);
		const unsupported = await keys.create("unsupported-params", unsupportedVersionId);
		unsupportedKeyId = unsupported.record.keyId;
		const unregisteredConfigId = randomUUID();
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,enabled,draft,draft_revision) values ($1,$2,'unregistered',true,$3::jsonb,1)",
			unregisteredConfigId,
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		const unregisteredVersionId = randomUUID();
		await writeVersion(unregisteredVersionId, unregisteredConfigId, baseSpec(unregisteredVersionId));
		// Deliberately no aaas_version_credential_bindings row: rules are unregistered.
		const unregistered = await keys.create("unregistered-rules", unregisteredVersionId);
		unregisteredKeyId = unregistered.record.keyId;

		const runtime = new RouterRuntime({ client, repos, tenantId, keys, masterKey, idempotency: new IdempotencyKeyring({ masterKey }),
			adapter: createPiRuntimeAdapter({ createSession: async () => { throw new Error("worker disabled in this fixture"); } }) });
		const service = new ControlService({
			repositories: repos,
			catalog: { tools: [], models: [{ provider: "test", modelId: "test-model" }], knowledgeBases: [] },
			embedBaseUrl: "http://localhost",
			mcpSecretBox: new McpSecretBox(masterKey),
		});
		const orchestration = createOrchestrationHttp(new OrchestrationService(store, service, repos, undefined as never),
			(request) => request.headers.authorization === `Bearer ${ADMIN_TOKEN}`);
		const keyHandler = createApiKeyHttp({ keys, runs, isAdmin: (request) => request.headers.authorization === `Bearer ${ADMIN_TOKEN}`,
			routerAdmin: createRouterAdmin({ client, repos, tenantId, router: runtime, listModels: async () => [{ provider: "test", id: "test-model" }] }) });
		keyServer = createServer((request, response) => {
			void Promise.resolve(keyHandler(request, response)).then(async (handled: boolean) => {
				if (!handled && !(await orchestration(request, response))) {
					response.statusCode = 404;
					response.end();
				}
			});
		});
		await new Promise<void>((resolve) => keyServer.listen(0, "127.0.0.1", resolve));
		keyBase = `http://127.0.0.1:${(keyServer.address() as { port: number }).port}`;
		const controlHandler = createControlHttpHandler({
			service,
			repositories: repos,
			adminToken: ADMIN_TOKEN,
			tenantId: tenantId as TenantId,
			source: { async collect() { return { name: "x", config: {} as never, warnings: [] }; } },
		});
		controlServer = createServer((request, response) => {
			void controlHandler(request, response);
		});
		await new Promise<void>((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
		controlBase = `http://127.0.0.1:${(controlServer.address() as { port: number }).port}`;
	});

	afterAll(async () => {
		for (const server of [keyServer, controlServer]) if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (client) await client.close();
		rmSync(baselineDir, { recursive: true, force: true });
		const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
		} finally {
			await admin.close();
		}
	});

	test("legacy /runs rejects a new Run for Router-only Key but keeps replay and history", async () => {
		const dual = await keys.authenticate(`Bearer ${dualToken}`);
		const legacyBody = { prompt: "before" };
		const accepted = await runs.submit(dual, "idem-before-router", legacyBody);
		expect(accepted.duplicate).toBe(false);
		const path = `/api/admin/v1/aaas/keys/${dual.keyId}/router`;
		const configured = await call({ base: keyBase, method: "PUT", path, token: ADMIN_TOKEN, body: { expected_revision: 0, capabilities: {
			model: { provider: "test", model_id: "test-model", parameters: {} }, mcp_servers: [], skills: [],
			execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
		} } });
		expect(configured).toMatchObject({ status: 200, body: { data: { scope: "dual", capabilityRevision: 1 } } });
		const initial = await call({ base: keyBase, method: "GET", path, token: ADMIN_TOKEN });
		const settings = initial.body.data as { scope: string; capabilityRevision: number; capabilities: unknown };
		expect(settings.scope).toBe("dual");
		const badConfirm = await call({ base: keyBase, method: "PATCH", path, token: ADMIN_TOKEN, body: { action: "cutover", expected_revision: settings.capabilityRevision } });
		expect(badConfirm.status).toBe(400);
		const cutover = await call({ base: keyBase, method: "PATCH", path, token: ADMIN_TOKEN, body: { action: "cutover", expected_revision: settings.capabilityRevision, migration_confirmed: true } });
		expect(cutover).toMatchObject({ status: 200, body: { data: { scope: "router", capabilityRevision: settings.capabilityRevision + 1 } } });
		const stale = await call({ base: keyBase, method: "PUT", path, token: ADMIN_TOKEN, body: { expected_revision: settings.capabilityRevision, capabilities: settings.capabilities } });
		expect(stale).toMatchObject({ status: 409, body: { error: { code: "CAPABILITY_REVISION_CONFLICT" } } });
		const routerized = await keys.authenticate(`Bearer ${dualToken}`);
		const replay = await runs.submit(routerized, "idem-before-router", legacyBody);
		expect(replay).toMatchObject({ run_id: accepted.run_id, duplicate: true });
		const history = await runs.run(routerized, accepted.run_id);
		expect(history.run_id).toBe(accepted.run_id);
		const rejected = await call({
			base: keyBase,
			method: "POST",
			path: "/api/aaas/v1/runs",
			token: dualToken,
			body: legacyBody,
			extra: { "idempotency-key": "idem-after-router" },
		});
		expect(rejected.status).toBe(410);
		expect((rejected.body.error as { code: string }).code).toBe("LEGACY_RUN_CREATION_RETIRED");
		expect(await call({
			base: keyBase,
			method: "POST",
			path: "/api/aaas/v1/runs",
			token: dualToken,
			body: legacyBody,
			extra: { "idempotency-key": "idem-before-router" },
		})).toMatchObject({ status: 410, body: { error: { code: "LEGACY_RUN_CREATION_RETIRED" } } });
		await expect(runs.submit(routerized, "idem-after-router", legacyBody)).rejects.toMatchObject({
			status: 403,
			code: "CAPABILITY_SCOPE_REQUIRED",
		});
		const [created] = await client.run(
			"select 1 from aaas_key_idempotency where tenant_id=$1 and key_id=$2 and idempotency_key='idem-after-router'",
			tenantId,
			dual.keyId,
		);
		expect(created).toBeUndefined();
		// Cross-Key isolation is unchanged: a different Key cannot replay or read it.
		const router = await keys.authenticate(`Bearer ${routerToken}`);
		await expect(runs.submit(router, "idem-before-router", legacyBody)).rejects.toThrowError();
		await expect(runs.run(router, accepted.run_id)).rejects.toThrowError();
		const usage = await call({ base: keyBase, method: "GET", path: "/api/aaas/v1/usage", token: dualToken });
		expect(usage.status).toBe(200);
		const rollback = await call({ base: keyBase, method: "PATCH", path, token: ADMIN_TOKEN, body: { action: "rollback", expected_revision: settings.capabilityRevision + 1 } });
		expect(rollback).toMatchObject({ status: 200, body: { data: { scope: "dual" } } });
		expect((await runs.submit(dual, "idem-after-rollback", legacyBody)).duplicate).toBe(false);
		const actions = await client.run("select action from audit_events where tenant_id=$1 and resource_id=$2 and action like 'aaas.key.router-%' order by created_at", tenantId, dual.keyId);
		expect(actions.map((row) => row.action)).toContain("aaas.key.router-cutover");
		expect(actions.map((row) => row.action)).toContain("aaas.key.router-rollback");
	});

	test("exact allowlist projects only authorized tool and its rules", async () => {
		const principal = await keys.authenticate(`Bearer ${routerToken}`);
		const effective = await resolveEffectiveCapabilities({ client, repos, tenantId, principal, scope: "router" });
		expect(effective.servers).toHaveLength(1);
		expect(effective.servers[0].tools.map((tool) => tool.name)).toEqual(["A"]);
		expect(effective.servers[0].sensitiveBindings.map((binding) => binding.toolName)).toEqual(["A"]);
		const { snapshot, digest } = buildRouterCapabilitySnapshot({ keyId: principal.keyId, effective });
		expect(snapshot.servers[0].toolAllowlist).toEqual(["A"]);
		expect(snapshot.servers[0].tools).toHaveLength(1);
		expect(snapshot.servers[0].sensitiveBindings.map((binding) => binding.toolName)).toEqual(["A"]);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("platform migration uses the active version and commits the allocated Revision when publication wins the next number", async () => {
		const source = await resolveMigrationSourceVersion({
			client,
			tenantId,
			key: { id: migrationKeyId, versionId: null, configurationId: null, scope: "legacy", directCapabilities: null, revision: 0 },
		});
		expect(source).toEqual({ mode: "platform", versionId: platformActiveVersionId, reason: null });
		const preview = await migrateRouterKeys({
			client,
			repos,
			tenantId,
			dryRun: true,
			keyIds: [migrationKeyId, unsupportedKeyId, unregisteredKeyId],
		});
		expect(preview.keys.find((entry) => entry.key_id === migrationKeyId)?.source_version_id).toBe(platformActiveVersionId);
		expect(preview.keys.find((entry) => entry.key_id === unsupportedKeyId)?.status).toBe("pending");
		expect(preview.keys.find((entry) => entry.key_id === unregisteredKeyId)?.status).toBe("pending");
		expect(preview.revisions).toEqual([{ server_id: migrationServerId, revision: 3, created: true }]);
		const [beforePointer] = await client.run("select current_revision from mcp_servers where tenant_id=$1 and id=$2", tenantId, migrationServerId.slice(4));
		const applied = await migrateRouterKeys({
			client,
			repos: {
				...repos,
				mcpServers: {
					...repos.mcpServers,
					async addRevision(input) {
						// Commit a normal publication after migration's catalog read and before its allocation.
						const published = await repos.mcpServers.addRevision({
							...input,
							expectedRevision: 2,
							advanceCurrentRevision: true,
							revision: { ...input.revision, sensitiveBindings: null },
							tools: input.tools.map((tool) => ({ ...tool, mcpToolId: newMcpToolId(), sensitiveBindings: null })),
						});
						expect(published?.revision).toBe(3);
						return repos.mcpServers.addRevision(input);
					},
				},
			},
			tenantId,
			dryRun: false,
			keyIds: [migrationKeyId, unsupportedKeyId, unregisteredKeyId],
		});
		expect(applied.keys.find((entry) => entry.key_id === migrationKeyId)?.status).toBe("migrated");
		expect(applied.revisions).toEqual([{ server_id: migrationServerId, revision: 4, created: true }]);
		expect(applied.keys.find((entry) => entry.key_id === unsupportedKeyId)?.status).toBe("pending");
		expect(applied.keys.find((entry) => entry.key_id === unregisteredKeyId)?.status).toBe("pending");
		const [unregisteredRow] = await client.run(
			"select direct_capabilities from aaas_api_keys where tenant_id=$1 and id=$2",
			tenantId,
			unregisteredKeyId,
		);
		expect(unregisteredRow.direct_capabilities).toBeNull();
		const [afterPointer] = await client.run("select current_revision from mcp_servers where tenant_id=$1 and id=$2", tenantId, migrationServerId.slice(4));
		expect(beforePointer.current_revision).toBe(2);
		expect(afterPointer.current_revision).toBe(3);
		const [row] = await client.run("select direct_capabilities from aaas_api_keys where tenant_id=$1 and id=$2", tenantId, migrationKeyId);
		const direct = row.direct_capabilities as { model: { parameters: Record<string, unknown> }; mcp_servers: { revision: number; tool_allowlist: string[] }[] };
		expect(direct.model.parameters).toEqual({ temperature: 0.3 });
		expect(direct.mcp_servers[0].revision).toBe(4);
		expect(direct.mcp_servers[0].tool_allowlist).toEqual(["lookup"]);
		const frozen = await repos.mcpServers.getRevision({ tenantId: tenantId as TenantId }, migrationServerId.slice(4) as never, 4);
		expect(frozen?.sensitiveBindings).toEqual([]);
		const frozenTools = await repos.mcpServers.listTools({ tenantId: tenantId as TenantId }, migrationServerId.slice(4) as never, 4);
		expect(frozenTools[0].sensitiveBindings).toEqual([]);
		// A candidate with NULL rules is never reused as an explicit empty rule set.
		const unregistered = await repos.mcpServers.getRevision({ tenantId: tenantId as TenantId }, migrationServerId.slice(4) as never, 2);
		expect(unregistered?.sensitiveBindings).toBeNull();
		const migratedPrincipal = await keys.authenticate(`Bearer ${migrationToken}`);
		const migratedEffective = await resolveEffectiveCapabilities({
			client,
			repos,
			tenantId,
			principal: migratedPrincipal,
			scope: "router",
		});
		expect(migratedEffective.servers[0].revision).toBe(4);
		expect(migratedEffective.servers[0].tools.map((tool) => tool.name)).toEqual(["lookup"]);
		const again = await migrateRouterKeys({ client, repos, tenantId, dryRun: false, keyIds: [migrationKeyId] });
		expect(again.keys[0].status).toBe("skipped");
		expect(again.revisions).toHaveLength(0);
		const published = await repos.mcpServers.addRevision({
			scope: { tenantId: tenantId as TenantId },
			mcpServerId: migrationServerId.slice(4) as never,
			expectedRevision: 3,
			revision: {
				mcpServerId: migrationServerId.slice(4) as never,
				tenantId: tenantId as TenantId,
				transport: "streamable_http",
				endpoint: "https://migration.example.test/mcp",
				authentication: "none",
				sensitiveBindings: [],
				createdAt: new Date(),
			},
			tools: [
				{
					mcpToolId: newMcpToolId(),
					tenantId: tenantId as TenantId,
					mcpServerId: migrationServerId.slice(4) as never,
					name: "lookup",
					description: "lookup",
					inputSchema: schemaA,
					inputSchemaHash: hashA,
					sensitiveBindings: [],
					createdAt: new Date(),
				},
			],
		});
		expect(published?.revision).toBe(5);
		const [finalPointer] = await client.run("select current_revision from mcp_servers where tenant_id=$1 and id=$2", tenantId, migrationServerId.slice(4));
		expect(finalPointer.current_revision).toBe(5);
		const [afterPublish] = await client.run("select direct_capabilities from aaas_api_keys where tenant_id=$1 and id=$2", tenantId, migrationKeyId);
		expect((afterPublish.direct_capabilities as { mcp_servers: { revision: number }[] }).mcp_servers[0].revision).toBe(4);
	});

	test("HTTP: Router detail includes only tool credentials", async () => {
		const response = await call({
			base: keyBase,
			method: "GET",
			path: `/api/aaas/v1/mcp-servers/${abServerId}`,
			token: routerToken,
			extra: { "x-router-capability-scope": "router" },
		});
		expect(response.status).toBe(200);
		const data = response.body.data as { required_credentials: { credential_id: string; scope: string }[] };
		expect(data.required_credentials).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ credential_id: "tool_credential", scope: "tool" }),
			]),
		);
	});

	test("HTTP: admin sensitive rules accept mixed IDs and reject cross-server rules", async () => {
		const valid = await call({
			base: controlBase,
			method: "POST",
			path: `/api/control/v1/mcp-servers/${abServerId.slice(4)}/sensitive-rules`,
			token: ADMIN_TOKEN,
			body: { rules: [{ mcpServerId: abServerId, toolNames: ["A"], parameter: "query", credentialId: "tool_credential" }] },
		});
		expect(valid.status, JSON.stringify(valid.body)).toBe(200);
		const read = await call({ base: controlBase, method: "GET", path: `/api/control/v1/mcp-servers/${abServerId}/sensitive-rules`, token: ADMIN_TOKEN });
		expect(read).toMatchObject({ status: 200, body: { data: { sensitive_bindings: [{ toolName: "A", parameter: "query" }] } } });
		const otherServerId = `mcp_${randomUUID()}`;
		const invalid = await call({
			base: controlBase,
			method: "POST",
			path: `/api/control/v1/mcp-servers/${abServerId.slice(4)}/sensitive-rules`,
			token: ADMIN_TOKEN,
			body: { rules: [{ mcpServerId: otherServerId, toolNames: ["A"], parameter: "authToken", credentialId: "tool_credential" }] },
		});
		expect(invalid.status).toBe(422);
	});

	test("retired legacy configuration stays readable and Router provisioning stays available", async () => {
		await client.run("update aaas_api_keys set status='revoked' where tenant_id=$1 and router_capability_scope in ('legacy','dual')", tenantId);
		const basePath = "/api/admin/v1/aaas/keys";
		const status = await call({ base: keyBase, method: "GET", path: `${basePath}/legacy-configuration-status`, token: ADMIN_TOKEN });
		expect(status).toMatchObject({ status: 200, body: { data: { writable: false } } });
		const prior = await call({ base: keyBase, method: "GET", path: `${basePath}/platform-configuration`, token: ADMIN_TOKEN });
		expect(prior).toMatchObject({ status: 200, body: { data: { enabled: true } } });
		const write = await call({ base: keyBase, method: "PUT", path: `${basePath}/platform-configuration`, token: ADMIN_TOKEN, body: {} });
		expect(write).toMatchObject({ status: 409, body: { error: { code: "LEGACY_CONFIGURATION_RETIRED" } } });
		const save = await call({ base: keyBase, method: "PUT", path: "/api/admin/v1/orchestration/configurations/current", token: ADMIN_TOKEN,
			body: { configuration_id: null, name: "retired", draft: { systemPrompt: "fixture", modelId: "test-model", parameters: {} }, credential_bindings: [] } });
		expect(save).toMatchObject({ status: 409, body: { error: { code: "LEGACY_CONFIGURATION_RETIRED" } } });
		const created = await call({ base: keyBase, method: "POST", path: basePath, token: ADMIN_TOKEN, body: { name: "Router provisioning", router_only: true } });
		expect(created).toMatchObject({ status: 201, body: { data: { routerCapabilityScope: "router", directCapabilityRevision: 0 } } });
		const keyId = (created.body.data as { keyId: string }).keyId;
		const settingsPath = `${basePath}/${keyId}/router`;
		const scoped = await call({ base: keyBase, method: "GET", path: settingsPath, token: ADMIN_TOKEN });
		expect(scoped).toMatchObject({ status: 200, body: { data: { scope: "router", capabilityRevision: 0, capabilities: null, canRollback: false } } });
		expect(JSON.stringify(scoped.body)).not.toContain("token");

		const capabilities = {
			model: { provider: "test", model_id: "test-model", parameters: {} },
			mcp_servers: [],
			skills: [],
			execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
		};
		const put = (expectedRevision: number, next: unknown) =>
			call({
				base: keyBase, method: "PUT", path: settingsPath, token: ADMIN_TOKEN,
				body: { expected_revision: expectedRevision, capabilities: next },
			});
		const blocked = await put(0, {
			...capabilities,
			mcp_servers: [{ server_id: migrationServerId, revision: 1, authentication: "none", tool_allowlist: ["lookup"] }],
		});
		expect(blocked).toMatchObject({
			status: 403,
			body: { error: { code: "CAPABILITY_UNAVAILABLE", message: expect.stringContaining("migration-server」v1") } },
		});
		expect(blocked.body.error).toMatchObject({ message: expect.stringContaining("请在 MCP 管理发布规则") });
		expect(await call({ base: keyBase, method: "GET", path: settingsPath, token: ADMIN_TOKEN }))
			.toMatchObject({ status: 200, body: { data: { capabilityRevision: 0, capabilities: null } } });
		expect(await put(0, capabilities))
			.toMatchObject({ status: 200, body: { data: { scope: "router", capabilityRevision: 1 } } });
		const withReviewedTool = {
			...capabilities,
			mcp_servers: [{ server_id: abServerId, revision: 1, authentication: "api_key", tool_allowlist: ["A"] }],
		};
		expect(await put(1, withReviewedTool))
			.toMatchObject({ status: 200, body: { data: { scope: "router", capabilityRevision: 2 } } });
		expect(await call({ base: keyBase, method: "GET", path: settingsPath, token: ADMIN_TOKEN }))
			.toMatchObject({ status: 200, body: { data: { capabilityRevision: 2, capabilities: withReviewedTool } } });
	});
});

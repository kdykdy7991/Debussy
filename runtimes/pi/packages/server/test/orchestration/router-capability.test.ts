/**
 * Router V1 phase three: Key direct capabilities, MCP Revision sensitive rules,
 * snapshot construction and legacy Key migration. Database cases run only on an
 * isolated PostgreSQL database; without one they are reported as NOT RUN.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import {
	buildRouterCapabilitySnapshot,
	expandSensitiveRules,
	inheritSensitiveBindings,
	publishMcpSensitiveRules,
	resolveCapabilityScope,
	resolveEffectiveCapabilities,
	saveDirectCapabilities,
	validateSensitiveBindings,
	verifyRouterCapabilitySnapshot,
} from "../../src/orchestration/router-capability.ts";
import {
	migrateRouterKeys,
	resolveMigrationSourceVersion,
	toSensitiveRuleBatches,
	validateAuthTokenSample,
} from "../../src/orchestration/router-key-migration.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { newMcpServerId, newMcpToolId } from "../../src/publishing/domain/ids.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const ADMIN_URL = process.env.PI_ROUTER_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const DATABASE = `router_cap_${process.pid}_${Date.now().toString(36)}`;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../src/persistence/postgres/migrations/", import.meta.url));
const masterKey = new Uint8Array(32).fill(23);
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const configurationId = randomUUID();
const versionId = randomUUID();
const endpoint = "https://mcp.example.test/mcp";
const schema = { type: "object", properties: { query: { type: "string" }, authToken: { type: "string" } }, required: ["query"] };
const schemaHash = sha256Hex(canonicalJson(schema));
const authBinding = {
	mcpServerId: "",
	toolName: "findTicket",
	parameter: "authToken",
	credentialId: "tool_credential",
};

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

describe("Router V1 phase three pure rules", () => {
	test("scope resolution keeps four discovery behaviours and never falls back on explicit Router", () => {
		expect(resolveCapabilityScope("router", undefined)).toBe("router");
		expect(resolveCapabilityScope("dual", "router")).toBe("router");
		expect(resolveCapabilityScope("dual", undefined)).toBe("legacy");
		expect(resolveCapabilityScope("legacy", undefined)).toBe("legacy");
		expect(() => resolveCapabilityScope("router", "legacy")).toThrowError(/显式选择/);
		expect(() => resolveCapabilityScope("legacy", "router")).toThrowError(/CAPABILITY_UNAVAILABLE|未登记/);
	});

	test("batch rules expand to exact tools and reject duplicate mappings", () => {
		const expanded = expandSensitiveRules("mcp_00000000-0000-4000-8000-000000000001", [
			{
				mcpServerId: "mcp_00000000-0000-4000-8000-000000000001",
				toolNames: ["a", "b"],
				parameter: "authToken",
				credentialId: "tool_credential",
			},
		]);
		expect(expanded.map((binding) => binding.toolName)).toEqual(["a", "b"]);
		expect(() =>
			expandSensitiveRules("mcp_00000000-0000-4000-8000-000000000001", [
				{
					mcpServerId: "mcp_00000000-0000-4000-8000-000000000001",
					toolNames: ["a", "a"],
					parameter: "authToken",
					credentialId: "tool_credential",
				},
			]),
		).toThrowError(/重复/);
	});

	test("NULL rules are unregistered, [] is reviewed empty, dangling/conflicting rules are rejected", () => {
		const tools = [{ name: "findTicket", inputSchema: schema }];
		const valid = [{ ...authBinding, mcpServerId: "mcp_00000000-0000-4000-8000-000000000001" }];
		expect(() => validateSensitiveBindings(valid[0].mcpServerId, tools, null)).toThrowError(/未登记|缺失/);
		expect(validateSensitiveBindings(valid[0].mcpServerId, tools, [])).toEqual([]);
		expect(validateSensitiveBindings(valid[0].mcpServerId, tools, valid)).toHaveLength(1);
		expect(() =>
			validateSensitiveBindings(valid[0].mcpServerId, tools, [{ ...valid[0], toolName: "missing" }]),
		).toThrowError(/不存在/);
		expect(() =>
			validateSensitiveBindings(valid[0].mcpServerId, tools, [{ ...valid[0], parameter: "missing" }]),
		).toThrowError(/顶层字符串/);
		expect(() => validateSensitiveBindings(valid[0].mcpServerId, tools, [...valid, ...valid])).toThrowError(/重复/);
	});

	test("schema sync only inherits rules for unchanged tools", () => {
		const previous = [
			{ name: "same", inputSchema: schema, inputSchemaHash: schemaHash, description: "d", sensitiveBindings: [] },
			{ name: "changed", inputSchema: schema, inputSchemaHash: schemaHash, description: "d", sensitiveBindings: [] },
		] as never as Parameters<typeof inheritSensitiveBindings>[0];
		const next = [
			{ name: "same", inputSchema: schema, inputSchemaHash: schemaHash, description: "d" },
			{ name: "changed", inputSchema: schema, inputSchemaHash: "b".repeat(64), description: "d" },
			{ name: "new", inputSchema: schema, inputSchemaHash: schemaHash, description: "d" },
		] as never as Parameters<typeof inheritSensitiveBindings>[1];
		const result = inheritSensitiveBindings(previous, next);
		expect(result[0].sensitiveBindings).toEqual([]);
		expect(result[1].sensitiveBindings).toBeNull();
		expect(result[2].sensitiveBindings).toBeNull();
	});

	test("smart-ticket sample validates 39 authToken mappings", () => {
		const toolNames = Array.from({ length: 39 }, (_, index) => `tool_${index}`);
		const bindings = toolNames.map((toolName) => ({ toolName, parameter: "authToken", credentialId: "tool_credential" }));
		expect(validateAuthTokenSample(bindings, toolNames)).toEqual({ ok: true, count: 39 });
		expect(validateAuthTokenSample(bindings.slice(0, 38), toolNames)).toEqual({ ok: false, count: 38 });
	});

	test("legacy bindings group into one batch rule and keep exact tool names", () => {
		const batches = toSensitiveRuleBatches("mcp_a", [
			{ mcpServerId: "mcp_a", toolName: "t1", parameter: "authToken", credentialId: "tool_credential" },
			{ mcpServerId: "mcp_a", toolName: "t2", parameter: "authToken", credentialId: "tool_credential" },
			{ mcpServerId: "mcp_b", toolName: "t3", parameter: "authToken", credentialId: "tool_credential" },
		]);
		expect(batches).toHaveLength(1);
		expect(batches[0].toolNames).toEqual(["t1", "t2"]);
	});
});

describe.skipIf(!pgUp)("Router V1 phase three isolated database", () => {
	let client: PostgresClient;
	let repos: ReturnType<typeof createPublishingRepositories>;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	let baselineDir: string;
	let serverId: string;
	let otherServerId: string;
	let routerKeyId: string;
	let dualKeyId: string;
	let legacyKeyId: string;
	let routerToken: string;
	let dualToken: string;
	let legacyToken: string;
	let migratedKeyId: string;

	beforeAll(async () => {
		const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
			await admin.run(`create database ${DATABASE}`);
		} finally {
			await admin.close();
		}
		client = new PostgresClient({ url: databaseUrl(), connectTimeoutSeconds: 5 });
		baselineDir = mkdtempSync(join(tmpdir(), "router-cap-baseline-"));
		const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
		for (const file of files) symlinkSync(join(MIGRATIONS_DIR, file), join(baselineDir, file));
		await runMigrations(client, { migrationsDir: baselineDir });
		repos = createPublishingRepositories(client);
		for (const id of [tenantId, otherTenantId])
			await client.run("insert into tenants(id,name,status) values ($1,$2,'active')", id, `tenant-${id.slice(0, 4)}`);
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'legacy',1,$3::jsonb,$2)",
			randomUUID(),
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,enabled,draft,draft_revision) values ($1,$2,'cfg',true,$3::jsonb,1)",
			configurationId,
			tenantId,
			{ prompt: "x", model: { provider: "test", modelId: "test-model" }, tools: [] },
		);
		const runtimeSpec = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: `orv_${versionId}`,
			agent: { systemPrompt: "x", model: { provider: "test", modelId: "test-model" } },
			capabilities: { mcpServers: [] },
		});
		if (!runtimeSpec.ok) throw new Error("fixture RuntimeSpec invalid");
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,1,$5::jsonb,$6)`,
			versionId,
			tenantId,
			configurationId,
			{ modelId: "test-model" },
			runtimeSpec.spec,
			sha256Hex(canonicalJson(runtimeSpec.spec)),
		);
		await client.run(
			"update orchestration_configurations set active_version_id=$2 where tenant_id=$1 and id=$3",
			tenantId,
			versionId,
			configurationId,
		);
		await client.run(
			"insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings) values ($1,$2,'[]'::jsonb)",
			tenantId,
			versionId,
		);
		await client.run(
			"insert into aaas_platform_configuration(tenant_id,configuration_id,orchestration_version_id,credential_bindings) values ($1,$2,$3,'[]'::jsonb)",
			tenantId,
			configurationId,
			versionId,
		);
		keys = new ApiKeyStore(client, tenantId, masterKey);
		const store = new OrchestrationStore(
			client,
			tenantId,
			new WorkCredentialBox(new Uint8Array(32).fill(17)),
		);
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos,
		});
		const createServer = async (name: string, withRules: boolean): Promise<string> => {
			const id = newMcpServerId();
			const binding = { ...authBinding, mcpServerId: `mcp_${id}` };
			await repos.mcpServers.create({
				server: {
					mcpServerId: id,
					tenantId: tenantId as never,
					name,
					status: "enabled",
					currentRevision: 1,
					lastTestOk: null,
					lastTestLatencyMs: null,
					lastTestAt: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				revision: {
					mcpServerId: id,
					tenantId: tenantId as never,
					revision: 1,
					transport: "streamable_http",
					endpoint,
					authentication: "api_key",
					sensitiveBindings: withRules ? [binding] : null,
					createdAt: new Date(),
				},
				tools: [
					{
						mcpToolId: newMcpToolId(),
						tenantId: tenantId as never,
						mcpServerId: id,
						mcpRevision: 1,
						name: "findTicket",
						description: "Find a ticket",
						inputSchema: schema,
						inputSchemaHash: schemaHash,
						sensitiveBindings: withRules ? [binding] : null,
						createdAt: new Date(),
					},
				],
			});
			return `mcp_${id}`;
		};
		serverId = await createServer("with-rules", true);
		otherServerId = await createServer("without-rules", false);
		const routerKey = await keys.create("router-only");
		routerKeyId = routerKey.record.keyId;
		routerToken = routerKey.token;
		const dualKey = await keys.create("dual");
		dualKeyId = dualKey.record.keyId;
		dualToken = dualKey.token;
		await client.run("update aaas_api_keys set router_capability_scope='dual' where tenant_id=$1 and id=$2", tenantId, dualKeyId);
		const legacyKey = await keys.create("legacy");
		legacyKeyId = legacyKey.record.keyId;
		legacyToken = legacyKey.token;
		const migrated = await keys.create("migrate-me", versionId);
		migratedKeyId = migrated.record.keyId;
		const capabilities = {
			model: { provider: "test", model_id: "test-model", parameters: {} },
			mcp_servers: [{ server_id: serverId, revision: 1, authentication: "api_key", tool_allowlist: ["findTicket"] }],
			skills: [],
			execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
		};
		await saveDirectCapabilities({ client, repos, tenantId, keyId: routerKeyId, expectedRevision: 0, scope: "router", capabilities });
		await saveDirectCapabilities({ client, repos, tenantId, keyId: dualKeyId, expectedRevision: 0, scope: "dual", capabilities });
	});

	afterAll(async () => {
		if (client) await client.close();
		rmSync(baselineDir, { recursive: true, force: true });
		const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
		} finally {
			await admin.close();
		}
	});

	test("CAS, cross-tenant references and audit are enforced on capability save", async () => {
		await expect(
			saveDirectCapabilities({
				client,
				repos,
				tenantId,
				keyId: routerKeyId,
				expectedRevision: 0,
				scope: "router",
				capabilities: { model: { provider: "t", model_id: "m", parameters: {} }, mcp_servers: [], skills: [], execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 } },
			}),
		).rejects.toThrowError(/CAS|修订/);
		await expect(
			saveDirectCapabilities({
				client,
				repos,
				tenantId: otherTenantId,
				keyId: routerKeyId,
				expectedRevision: 0,
				scope: "router",
				capabilities: { model: { provider: "t", model_id: "m", parameters: {} }, mcp_servers: [], skills: [], execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 } },
			}),
		).rejects.toThrowError();
		const [audit] = await client.run(
			"select 1 from audit_events where tenant_id=$1 and action='aaas.key.direct-capability.updated' and resource_id=$2",
			tenantId,
			routerKeyId,
		);
		expect(audit).toBeDefined();
	});

	test("four MCP discovery behaviours share the same resolver", async () => {
		const routerPrincipal = await keys.authenticate(`Bearer ${routerToken}`);
		const dualPrincipal = await keys.authenticate(`Bearer ${dualToken}`);
		const legacyPrincipal = await keys.authenticate(`Bearer ${legacyToken}`);
		expect(await runs.mcpServers(routerPrincipal)).toHaveLength(1);
		expect(await runs.mcpServers(routerPrincipal, "router")).toHaveLength(1);
		expect(await runs.mcpServers(dualPrincipal, "router")).toHaveLength(1);
		expect(await runs.mcpServers(dualPrincipal)).toHaveLength(0);
		expect(await runs.mcpServers(legacyPrincipal)).toHaveLength(0);
		await expect(runs.mcpServers(routerPrincipal, "legacy")).rejects.toThrowError(/显式选择/);
		await expect(runs.mcpServers(legacyPrincipal, "router")).rejects.toThrowError();
		const detail = await runs.mcpServer(dualPrincipal, serverId, "router");
		expect(detail.tools[0].input_schema.properties).not.toHaveProperty("authToken");
		expect(detail.required_credentials).toEqual([expect.objectContaining({ credential_id: "tool_credential", parameter: "authToken" })]);
		await expect(runs.mcpServer(dualPrincipal, serverId)).rejects.toThrowError(/不存在|不可访问/);
		await expect(runs.mcpServer(dualPrincipal, otherServerId, "router")).rejects.toThrowError();
	});

	test("snapshot is deterministic, verifiable and credential-free", async () => {
		const principal = await keys.authenticate(`Bearer ${routerToken}`);
		const effective = await resolveEffectiveCapabilities({ client, repos, tenantId, principal, scope: "router" });
		const first = buildRouterCapabilitySnapshot({ keyId: principal.keyId, effective });
		const second = buildRouterCapabilitySnapshot({ keyId: principal.keyId, effective });
		expect(first.digest).toBe(second.digest);
		expect(verifyRouterCapabilitySnapshot(first.snapshot, first.digest).capabilityRevision).toBe(1);
		expect(canonicalJson(first.snapshot)).not.toContain("secret");
		const mutated = { ...first.snapshot, capabilityRevision: 99 };
		expect(() => verifyRouterCapabilitySnapshot(mutated, first.digest)).toThrowError(/摘要/);
	});

	test("sensitive rules publish a new Revision, reuse equivalents and register empty rules", async () => {
		const scope = { tenantId: tenantId as never };
		const internal = (external: string) => external.slice(4) as never;
		const first = await publishMcpSensitiveRules({
			client,
			repos,
			tenantId,
			mcpServerId: otherServerId,
			rules: [{ mcpServerId: otherServerId, toolNames: ["findTicket"], parameter: "authToken", credentialId: "tool_credential" }],
		});
		expect(first.created).toBe(true);
		const second = await publishMcpSensitiveRules({
			client,
			repos,
			tenantId,
			mcpServerId: otherServerId,
			rules: [{ mcpServerId: otherServerId, toolNames: ["findTicket"], parameter: "authToken", credentialId: "tool_credential" }],
		});
		expect(second.created).toBe(false);
		expect(second.revision).toBe(first.revision);
		const updated = await repos.mcpServers.getRevision(scope, internal(otherServerId), first.revision);
		expect(updated?.sensitiveBindings).toHaveLength(1);
		const empty = await publishMcpSensitiveRules({
			client,
			repos,
			tenantId,
			mcpServerId: serverId,
			rules: [],
		});
		expect(empty.created).toBe(true);
		const emptyRevision = await repos.mcpServers.getRevision(scope, internal(serverId), empty.revision);
		expect(emptyRevision?.sensitiveBindings).toEqual([]);
	});

	test("missing rules keep a Key unready until an empty rule set is published", async () => {
		await expect(
			saveDirectCapabilities({
				client,
				repos,
				tenantId,
				keyId: legacyKeyId,
				expectedRevision: 0,
				scope: "router",
				capabilities: {
					model: { provider: "test", model_id: "test-model", parameters: {} },
					mcp_servers: [{ server_id: otherServerId, revision: 1, authentication: "api_key", tool_allowlist: ["findTicket"] }],
					skills: [],
					execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
				},
			}),
		).rejects.toThrowError();
	});

	test("migration previews, backfills once via CAS and preserves the legacy entry", async () => {
		const source = await resolveMigrationSourceVersion({
			client,
			tenantId,
			key: {
				id: migratedKeyId,
				versionId: versionId,
				configurationId: null,
				scope: "legacy",
				directCapabilities: null,
				revision: 0,
			},
		});
		expect(source.mode).toBe("fixed");
		expect(source.versionId).toBe(versionId);
		const preview = await migrateRouterKeys({ client, repos, tenantId, dryRun: true, keyIds: [migratedKeyId] });
		expect(preview.dryRun).toBe(true);
		const [before] = await client.run("select direct_capabilities from aaas_api_keys where tenant_id=$1 and id=$2", tenantId, migratedKeyId);
		expect(before.direct_capabilities).toBeNull();
		const applied = await migrateRouterKeys({ client, repos, tenantId, dryRun: false, keyIds: [migratedKeyId] });
		expect(applied.keys[0].status).toBe("migrated");
		const [after] = await client.run(
			"select router_capability_scope,direct_capability_revision,orchestration_version_id from aaas_api_keys where tenant_id=$1 and id=$2",
			tenantId,
			migratedKeyId,
		);
		expect(after.router_capability_scope).toBe("dual");
		expect(after.direct_capability_revision).toBe(1);
		expect(after.orchestration_version_id).toBe(versionId);
		const again = await migrateRouterKeys({ client, repos, tenantId, dryRun: false, keyIds: [migratedKeyId] });
		expect(again.keys[0].status).toBe("skipped");
		expect(again.revisions).toHaveLength(0);
	});
});

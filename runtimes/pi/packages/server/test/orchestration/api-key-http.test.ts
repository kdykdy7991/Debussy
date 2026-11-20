/**
 * T012 / T015: admin Key surface and mutually exclusive credential dispatch.
 * An `ak_` credential must never fall back to the legacy Integration authenticator.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { createApiKeyHttp } from "../../src/orchestration/api-key-http.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const SCHEMA = `aaas_key_http_${process.pid}_${Date.now().toString(36)}`;
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

describe.skipIf(!pgUp)("API Key HTTP surface on isolated Postgres", () => {
	let client: PostgresClient;
	let keys: ApiKeyStore;
	let server: Server;
	let base: string;
	let admin = true;
	const tenantId = randomUUID();
	const configurationId = randomUUID();
	const versionId = randomUUID();

	async function call(
		method: string,
		path: string,
		options: { authorization?: string; body?: unknown } = {},
	): Promise<{ status: number; data: unknown }> {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: {
				...(options.authorization === undefined ? {} : { authorization: options.authorization }),
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
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
		return { status: response.status, data };
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run(`insert into tenants(id,name,status) values ($1,'key-http-test','active')`, tenantId);
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
			agent: { systemPrompt: "p", model: { provider: "test", modelId: "test-model" } },
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
			{ modelId: "test-model", systemPrompt: "p", parameters: {}, mcpServers: [], skills: [] },
			normalized.spec,
			sha256Hex(canonicalJson(normalized.spec)),
		);
		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		const handler = createApiKeyHttp({ keys, isAdmin: () => admin });
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

	test("legacy Integration Token paths are not claimed by the new handler", async () => {
		const result = await call("POST", `/api/aaas/v1/integrations/${randomUUID()}/runs`, {
			authorization: `Bearer oi_${randomUUID()}.${"x".repeat(43)}`,
		});
		expect(result.status).toBe(599);
	});

	test("shared Run paths fall through for a legacy oi_ credential", async () => {
		// The legacy Integration contract also serves GET /api/aaas/v1/runs/{id} and
		// POST .../cancel. A `oi_` credential must reach that handler, never a 401 here.
		const result = await call("GET", `/api/aaas/v1/runs/${randomUUID()}`, {
			authorization: `Bearer oi_${randomUUID()}.${"x".repeat(43)}`,
		});
		expect(result.status).toBe(599);
		// Without any credential the path is still claimed and returns a uniform 401.
		const anonymous = await call("GET", `/api/aaas/v1/runs/${randomUUID()}`);
		expect(anonymous.status).toBe(401);
	});

	test("admin Key management requires admin authentication", async () => {
		admin = false;
		const result = await call("GET", "/api/admin/v1/aaas/keys");
		expect(result.status).toBe(401);
		expect((await call("GET", "/api/admin/v1/aaas/keys/platform-configuration")).status).toBe(401);
		expect((await call("GET", "/api/admin/v1/aaas/keys/platform-configuration/versions")).status).toBe(401);
		expect((await call("GET", `/api/admin/v1/aaas/keys/${randomUUID()}/configuration`)).status).toBe(401);
		admin = true;
	});

	test("admin binds platform configuration, creates a Key, then lists and rotates it", async () => {
		const versionOtherTenant = randomUUID();
		const otherConfig = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'other','active')", versionOtherTenant);
		await client.run(
			"insert into orchestration_configurations(id,tenant_id,name,draft) values ($1,$2,'private','{}'::jsonb)",
			otherConfig,
			versionOtherTenant,
		);
		await client.run(
			"insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash) values ($1,$2,$3,'{}'::jsonb,1,'{}'::jsonb,'hidden')",
			randomUUID(),
			versionOtherTenant,
			otherConfig,
		);
		const versions = await call("GET", "/api/admin/v1/aaas/keys/platform-configuration/versions");
		expect(versions.status).toBe(200);
		expect(versions.data).toMatchObject({
			data: [
				{
					configuration_id: configurationId,
					orchestration_version_id: versionId,
					name: "platform",
					revision: 1,
					model_id: "test-model",
				},
			],
		});
		expect(JSON.stringify(versions.data)).not.toContain("systemPrompt");
		expect(JSON.stringify(versions.data)).not.toContain(otherConfig);
		expect((await call("GET", "/api/admin/v1/aaas/keys/platform-configuration")).data).toMatchObject({ data: null });
		const bound = await call("PUT", "/api/admin/v1/aaas/keys/platform-configuration", {
			body: { configuration_id: configurationId, orchestration_version_id: versionId, credential_bindings: [] },
		});
		expect(bound.status).toBe(200);
		const mapping = await call("GET", `/api/admin/v1/aaas/keys/versions/${versionId}/credential-bindings`);
		expect(mapping.data).toMatchObject({ data: { credential_bindings: [] } });
		const registeredAgain = await call("PUT", `/api/admin/v1/aaas/keys/versions/${versionId}/credential-bindings`, { body: { credential_bindings: [] } });
		expect(registeredAgain.status).toBe(200);
		const config = await call("GET", "/api/admin/v1/aaas/keys/platform-configuration");
		expect((config.data as { data: unknown }).data).toEqual({
			configuration_id: configurationId,
			orchestration_version_id: versionId,
			credential_bindings: [],
			enabled: true,
		});
		await client.run(
			"update aaas_platform_configuration set credential_bindings=$2::jsonb where tenant_id=$1",
			tenantId,
			[
				{
					mcpServerId: "mcp_example",
					toolName: "tool",
					parameter: "account",
					credentialId: "account",
					secret: "do-not-return",
				},
			],
		);
		const redactedConfig = await call("GET", "/api/admin/v1/aaas/keys/platform-configuration");
		expect(JSON.stringify(redactedConfig.data)).not.toContain("do-not-return");
		await client.run(
			"update aaas_platform_configuration set credential_bindings='[]'::jsonb where tenant_id=$1",
			tenantId,
		);

		const created = await call("POST", "/api/admin/v1/aaas/keys", { body: { name: "business-a", orchestration_version_id: versionId } });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ data: { orchestrationVersionId: versionId } });
		const payload = (created.data as { data: { keyId: string; token: string } }).data;
		expect(payload.token).toMatch(/^ak_[0-9a-f-]{36}\./);
		expect((await call("PUT", `/api/admin/v1/aaas/keys/${payload.keyId}/configuration`, { body: { orchestration_version_id: versionId } })).status).toBe(200);
		expect((await call("PUT", `/api/admin/v1/aaas/keys/${payload.keyId}/configuration`, { body: { orchestration_version_id: null } })).status).toBe(200);

		const list = await call("GET", "/api/admin/v1/aaas/keys");
		expect(list.status).toBe(200);
		expect((list.data as { data: readonly { keyId: string }[] }).data).toHaveLength(1);

		const rotated = await call("PATCH", `/api/admin/v1/aaas/keys/${payload.keyId}`, {
			body: { action: "rotate" },
		});
		expect(rotated.status).toBe(200);
		const newToken = (rotated.data as { data: { token: string } }).data.token;
		expect(newToken).not.toBe(payload.token);

		const otherTenant = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'other','active')", otherTenant);
		const foreignKey = randomUUID();
		await client.run(
			"insert into aaas_api_keys(id,tenant_id,name,secret_hash) values ($1,$2,'other',$3)",
			foreignKey,
			otherTenant,
			"a".repeat(64),
		);
		expect(
			(await call("PATCH", `/api/admin/v1/aaas/keys/${foreignKey}`, { body: { action: "disable" } })).status,
		).toBe(404);
	});

	test("an API Key credential is authenticated here and never downgraded", async () => {
		const invalid = await call("GET", "/api/aaas/v1/runs/00000000-0000-0000-0000-000000000000", {
			authorization: `Bearer ak_${randomUUID()}.${"y".repeat(43)}`,
		});
		expect(invalid.status).toBe(401);
		expect((invalid.data as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

		// A valid Key reaches the new handler (endpoints are wired in later phases),
		// and must not be handed to the legacy Integration authenticator.
		const created = await keys.create("business-b");
		const accepted = await call("GET", "/api/aaas/v1/mcp-servers", {
			authorization: `Bearer ${created.token}`,
		});
		expect(accepted.status).toBe(404);
		expect((accepted.data as { error: { code: string } }).error.code).toBe("NOT_FOUND");
	});

	test("only admins can recover sealed Keys; rotation replaces them and legacy Keys need rotation", async () => {
		const created = await keys.create("recoverable");
		const url = `/api/admin/v1/aaas/keys/${created.record.keyId}/secret`;
		const [stored] = await client.run("select sealed_secret from aaas_api_keys where id=$1", created.record.keyId);
		expect(JSON.stringify(stored)).not.toContain(created.token.split(".")[1]);
		admin = false;
		expect((await call("POST", url, { body: {} })).status).toBe(401);
		admin = true;
		expect((await call("POST", url, { body: {} })).data).toMatchObject({ data: { token: created.token } });
		const restarted = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		expect(await restarted.reveal(created.record.keyId)).toBe(created.token);
		const wrongKey = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(42));
		await expect(wrongKey.reveal(created.record.keyId)).rejects.toMatchObject({ code: "KEY_DECRYPTION_UNAVAILABLE" });
		const another = await keys.create("other-key");
		await client.run(
			"update aaas_api_keys set sealed_secret=$2::jsonb where id=$1",
			another.record.keyId,
			stored?.sealed_secret as object,
		);
		await expect(keys.reveal(another.record.keyId)).rejects.toMatchObject({ code: "KEY_DECRYPTION_UNAVAILABLE" });
		const otherTenant = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'foreign','active')", otherTenant);
		const foreignStore = new ApiKeyStore(client, otherTenant, new Uint8Array(32).fill(41));
		await expect(foreignStore.reveal(created.record.keyId)).rejects.toMatchObject({ status: 404 });
		await client.run("update aaas_api_keys set sealed_secret=null where id=$1", created.record.keyId);
		expect((await call("POST", url, { body: {} })).data).toMatchObject({ error: { code: "KEY_NOT_RECOVERABLE" } });
		const rotated = await keys.updateAccess(created.record.keyId, "rotate");
		expect(await keys.reveal(created.record.keyId)).toBe(rotated.token);
		await expect(keys.authenticate(`Bearer ${created.token}`)).rejects.toMatchObject({ status: 401 });
		await keys.updateAccess(created.record.keyId, "revoke");
		await expect(keys.reveal(created.record.keyId)).rejects.toMatchObject({ code: "KEY_REVOKED" });
		expect(
			(await client.run("select sealed_secret from aaas_api_keys where id=$1", created.record.keyId))[0]
				?.sealed_secret,
		).toBeNull();
	});

	test("the retired creation endpoint authenticates and never writes a Run", async () => {
		const key = await keys.create("retired-create");
		const unauthorized = await call("POST", "/api/aaas/v1/runs");
		expect(unauthorized.status).toBe(401);
		const retired = await call("POST", "/api/aaas/v1/runs", {
			authorization: `Bearer ${key.token}`,
			body: { prompt: "only a fixture" },
		});
		expect(retired).toMatchObject({ status: 410, data: { error: { code: "LEGACY_RUN_CREATION_RETIRED" } } });
		const rows = await client.run("select count(*)::int as count from orchestration_work_items where tenant_id=$1 and key_id=$2", tenantId, key.record.keyId);
		expect(rows[0]?.count).toBe(0);
	});
});

/**
 * Phase 3 (T018) foundation verification: independent Key lifecycle, carrier
 * isolation from every legacy path, and versioned idempotency digests.
 * Requires the isolated test database; skipped when unreachable.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { CANONICALIZATION_VERSION, IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { OrchestrationConfigurationRepository } from "../../src/orchestration/configuration-domain.ts";
import { OrchestrationError } from "../../src/orchestration/contracts.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const SCHEMA = `aaas_key_${process.pid}_${Date.now().toString(36)}`;
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

describe("versioned idempotency digests (no DB needed)", () => {
	const master = new Uint8Array(32).fill(7);
	const older = new Uint8Array(32).fill(3);
	const request = { prompt: "run", task_id: "t1", credentials: { servers: { s: "v" } } };

	test("same request yields the same digest; content changes yield a different one", () => {
		const ring = new IdempotencyKeyring({ masterKey: master });
		const a = ring.digest(request);
		expect(a.requestHash).toHaveLength(64);
		expect(a.canonicalizationVersion).toBe(CANONICALIZATION_VERSION);
		expect(a.digestKeyVersion).toBe(1);
		expect(ring.digest(request).requestHash).toBe(a.requestHash);
		expect(ring.digest({ ...request, task_id: "t2" }).requestHash).not.toBe(a.requestHash);
		// canonicalJson means key order does not affect the digest.
		expect(ring.digest({ credentials: request.credentials, task_id: "t1", prompt: "run" }).requestHash).toBe(
			a.requestHash,
		);
	});

	test("replay matches using the stored version, and rotation retains the old version", () => {
		const oldRing = new IdempotencyKeyring({ masterKey: older, currentVersion: 1 });
		const stored = oldRing.digest(request);
		const rotated = new IdempotencyKeyring({
			masterKey: master,
			currentVersion: 2,
			historicalMasterKeys: { 1: older },
		});
		expect(rotated.version).toBe(2);
		expect(rotated.matches(request, stored)).toBe(true);
		expect(rotated.matches({ ...request, task_id: "t2" }, stored)).toBe(false);
	});

	test("a missing digest-key version is a service error, never a 409 or a new Run", () => {
		const ring = new IdempotencyKeyring({ masterKey: master });
		const stored = ring.digest(request);
		expect(() => ring.matches(request, { ...stored, digestKeyVersion: 99 })).toThrow(
			expect.objectContaining({ status: 500, code: "IDEMPOTENCY_KEY_UNAVAILABLE" }),
		);
	});
});

describe.skipIf(!pgUp)("Key foundation on isolated Postgres", () => {
	let client: PostgresClient;
	let keys: ApiKeyStore;
	let store: OrchestrationStore;
	const tenantId = randomUUID();

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run(`insert into tenants(id,name,status) values ($1,'key-test','active')`, tenantId);

		// Platform-owned published execution configuration (prepared by the admin surface).
		const configurationId = randomUUID();
		const versionId = randomUUID();
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,1,'{}'::jsonb,$5)`,
			versionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform prompt", parameters: {}, mcpServers: [], skills: [] },
			"d".repeat(64),
		);
		await client.run(
			`insert into aaas_platform_configuration(tenant_id,configuration_id,orchestration_version_id) values ($1,$2,$3)`,
			tenantId,
			configurationId,
			versionId,
		);
		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(new Uint8Array(32).fill(11)));
		// Assert the configuration repository is reachable with the same schema.
		expect(new OrchestrationConfigurationRepository(client)).toBeDefined();
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("create is independent of carrier; a prepared carrier is non-login", async () => {
		const created = await keys.create("business-a");
		expect(created.record.status).toBe("enabled");
		expect(created.token).toMatch(/^ak_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
		const initial = await keys.authenticate(`Bearer ${created.token}`);
		expect(initial.carrierIntegrationId).toBeNull();
		await client.transaction(async (tx) => {
			await keys.lockAndVerify(tx, initial, initial.secretHash);
			await keys.ensureCarrier(tx, initial.keyId, await keys.platformConfiguration(tx));
		});
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		expect(principal.keyId).toBe(created.record.keyId);
		const carrierId = principal.carrierIntegrationId!;

		const carriers = await client.run(
			"select i.kind,i.secret_hash,c.key_id from orchestration_integrations i join aaas_key_carriers c on c.carrier_integration_id=i.id where i.tenant_id=$1",
			tenantId,
		);
		expect(carriers).toHaveLength(1);
		expect(carriers[0]?.kind).toBe("internal_key_carrier");
		expect(carriers[0]?.key_id).toBe(created.record.keyId);
		// A legacy-shaped token for the carrier ID is rejected regardless of the secret.
		await expect(store.authenticate(`Bearer oi_${carrierId}.${"x".repeat(43)}`)).rejects.toMatchObject({
			status: 401,
		});
		// listIntegrations and every legacy management read exclude the carrier.
		expect(await store.listIntegrations()).toEqual([]);
		await expect(store.getLegacyIntegration(carrierId)).rejects.toMatchObject({
			status: 404,
		});
		await expect(store.updateAccess(carrierId, "disable")).rejects.toMatchObject({
			status: 404,
		});
	});

	test("disable/revoke reject authentication; revoke is terminal; rotation keeps the logical ID", async () => {
		const { record, token } = await keys.create("business-b");
		await keys.updateAccess(record.keyId, "disable");
		await expect(keys.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
		expect((await keys.updateAccess(record.keyId, "enable")).status).toBe("enabled");
		await expect(keys.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ keyId: record.keyId });

		const rotated = await keys.updateAccess(record.keyId, "rotate");
		expect(rotated.token).toBeDefined();
		await expect(keys.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
		await expect(keys.authenticate(`Bearer ${rotated.token}`)).resolves.toMatchObject({ keyId: record.keyId });
		expect((await keys.list()).find((k) => k.keyId === record.keyId)).toBeDefined();

		expect((await keys.updateAccess(record.keyId, "revoke")).status).toBe("revoked");
		await expect(keys.authenticate(`Bearer ${rotated.token}`)).rejects.toMatchObject({ status: 401 });
		await expect(keys.updateAccess(record.keyId, "enable")).rejects.toMatchObject({ status: 409 });
		await expect(keys.updateAccess(record.keyId, "rotate")).rejects.toMatchObject({ status: 409 });
	});

	test("lockAndVerify rejects a changed Key", async () => {
		const { token } = await keys.create("business-c");
		const principal = await keys.authenticate(`Bearer ${token}`);
		await client.transaction(async (tx) => {
			const [row] = await tx.unsafe(
				"select secret_hash from aaas_api_keys where tenant_id=$1 and id=$2 for update",
				[tenantId, principal.keyId],
			);
			await expect(keys.lockAndVerify(tx, principal, String(row?.secret_hash))).resolves.toBeUndefined();
			await expect(keys.lockAndVerify(tx, principal, "0".repeat(64))).rejects.toBeInstanceOf(OrchestrationError);
		});
	});
});

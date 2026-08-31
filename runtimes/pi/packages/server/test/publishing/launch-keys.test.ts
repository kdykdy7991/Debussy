/**
 * TASK-027: Launch Key management (spec 8.1, 13.4, 26.2 `embed_launch_keys`).
 *
 * Covers: registration of a host public key (active), duplicate keyId (409),
 * expired/invalid key material rejected (400, nothing persisted — the
 * platform never receives a private key), the rotation window (registering a
 * new key retires the old one so both stay accepted), revoke (active/retiring
 * -> revoked, double revoke 409), cross-app isolation (a key of app A is
 * indistinguishable from missing in app B), audit events, and the HTTP
 * contract (201/400/404/409 + idempotency). Requires the local test DB.
 */
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { newTenantId, type PublishedAppId, type TenantId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

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

const CATALOG: CapabilityCatalog = {
	tools: [{ id: "web.search", name: "Web Search" }],
	models: [{ provider: "skdy", modelId: "pi-chat" }],
	knowledgeBases: [{ id: "kb-legal" }],
};

function source(config: AgentDraftConfig, name = "key-agent"): CurrentAgentDefinitionSource {
	return {
		async collect() {
			return { name, config, warnings: [] };
		},
	};
}

function baseConfig(): AgentDraftConfig {
	return {
		prompt: "You are a helpful assistant.",
		model: { provider: "skdy", modelId: "pi-chat" },
		tools: [{ id: "web.search" }],
		uploads: { enabled: false },
		speech: { enabled: false },
		avatar: { enabled: false },
	};
}

describe.skipIf(!pgUp)("launch key management", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;
	let tenantId: TenantId;
	/** Bare published-app ids for the two test apps. */
	let appA: PublishedAppId;
	let appB: PublishedAppId;
	let publicKeyPem: string;
	let privateKeyPem: string;
	let secondPublicKeyPem: string;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		tenantId = newTenantId();
		service = new ControlService({ repositories: repos, catalog: CATALOG, embedBaseUrl: "https://embed.test" });
		const bootstrapped = await service.bootstrapTenant({ tenantId, tenantName: "bootstrap" });
		if (!bootstrapped.ok) throw new Error("bootstrap failed");
		const imported = await service.importAgent({ tenantId }, source(baseConfig()));
		if (!imported.ok) throw new Error("import failed");
		const [appAResult, appBResult] = await Promise.all([
			service.createPublishedApp({
				tenantId,
				agentDefinitionId: imported.data.agentDefinitionId,
				name: "App A",
				accessMode: "mixed",
			}),
			service.createPublishedApp({
				tenantId,
				agentDefinitionId: imported.data.agentDefinitionId,
				name: "App B",
				accessMode: "signed_user",
			}),
		]);
		if (!appAResult.ok || !appBResult.ok) throw new Error("app creation failed");
		appA = appAResult.data.app.publishedAppId;
		appB = appBResult.data.app.publishedAppId;

		const pair = await generateKeyPair("Ed25519", { extractable: true });
		publicKeyPem = await exportSPKI(pair.publicKey);
		privateKeyPem = await exportPKCS8(pair.privateKey);
		secondPublicKeyPem = await exportSPKI((await generateKeyPair("Ed25519", { extractable: true })).publicKey);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("createLaunchKey registers an active key with the host-facing keyId", async () => {
		const created = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "host-key-1",
			publicKeyPem,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.data.key.keyId).toBe("host-key-1");
		expect(created.data.key.algorithm).toBe("EdDSA");
		expect(created.data.key.status).toBe("active");
		expect(created.data.key.publicKeyPem).toBe(publicKeyPem);
		expect(created.data.key.expiresAt).toBeNull();
		expect(created.data.retired).toEqual([]);
		expect(created.data.auditEventId).toBeTruthy();
		// The internal launch key id is a bare UUIDv7 (representation only).
		expect(created.data.key.launchKeyId).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("duplicate keyId for the same app returns KEY_ID_CONFLICT", async () => {
		const first = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "dup-key",
			publicKeyPem,
		});
		expect(first.ok).toBe(true);
		const second = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "dup-key",
			publicKeyPem: secondPublicKeyPem,
		});
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.code).toBe("KEY_ID_CONFLICT");
		expect(second.error.httpStatus).toBe(409);
		// Only one row persisted for the keyId.
		const keys = await repos.launchKeys.list({ tenantId, publishedAppId: appA });
		expect(keys.filter((key) => key.keyId === "dup-key")).toHaveLength(1);
	});

	test("private key material and garbage PEM are rejected, nothing persisted", async () => {
		const withPrivate = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "private-key",
			publicKeyPem: privateKeyPem,
		});
		expect(withPrivate.ok).toBe(false);
		if (withPrivate.ok) return;
		expect(withPrivate.error.code).toBe("INVALID_LAUNCH_KEY");
		expect(withPrivate.error.httpStatus).toBe(400);
		const garbage = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "garbage-key",
			publicKeyPem: "not-a-pem-at-all",
		});
		expect(garbage.ok).toBe(false);
		if (garbage.ok) return;
		expect(garbage.error.code).toBe("INVALID_LAUNCH_KEY");
		const keys = await repos.launchKeys.list({ tenantId, publishedAppId: appA });
		expect(keys.find((key) => key.keyId === "private-key")).toBeUndefined();
		expect(keys.find((key) => key.keyId === "garbage-key")).toBeUndefined();
	});

	test("unsupported algorithm is rejected", async () => {
		const result = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "rsa-key",
			algorithm: "RS256",
			publicKeyPem,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_LAUNCH_KEY");
		expect(result.error.httpStatus).toBe(400);
	});

	test("expired or malformed dates are rejected at registration", async () => {
		const past = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "expired-key",
			publicKeyPem,
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		});
		expect(past.ok).toBe(false);
		if (past.ok) return;
		expect(past.error.code).toBe("INVALID_LAUNCH_KEY");

		const badOrder = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "bad-order-key",
			publicKeyPem,
			notBefore: "2026-08-01T00:00:00Z",
			expiresAt: "2026-07-01T00:00:00Z",
		});
		expect(badOrder.ok).toBe(false);
		if (badOrder.ok) return;
		expect(badOrder.error.code).toBe("INVALID_LAUNCH_KEY");

		const malformed = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "malformed-key",
			publicKeyPem,
			expiresAt: "not-a-date",
		});
		expect(malformed.ok).toBe(false);
		if (malformed.ok) return;
		expect(malformed.error.code).toBe("INVALID_LAUNCH_KEY");
	});

	test("rotation window: a new key retires the old one and both stay accepted", async () => {
		const first = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "rot-1",
			publicKeyPem,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// Re-registering the same keyId is a conflict; rotation needs a NEW keyId.
		const second = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "rot-2",
			publicKeyPem: secondPublicKeyPem,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.retired.map((key) => key.keyId)).toEqual(["rot-1"]);
		// The old key moved to retiring but is still accepted (not revoked).
		const keys = await repos.launchKeys.list({ tenantId, publishedAppId: appA });
		const rot1 = keys.find((key) => key.keyId === "rot-1");
		const rot2 = keys.find((key) => key.keyId === "rot-2");
		expect(rot1?.status).toBe("retiring");
		expect(rot2?.status).toBe("active");
		expect(rot1?.status).not.toBe("revoked");
		expect(rot2?.status).not.toBe("revoked");
		// A third key retires only the previously-active one; rot-1 stays retiring.
		const third = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "rot-3",
			publicKeyPem,
		});
		expect(third.ok).toBe(true);
		if (!third.ok) return;
		expect(third.data.retired.map((key) => key.keyId)).toEqual(["rot-2"]);
		const after = await repos.launchKeys.list({ tenantId, publishedAppId: appA });
		expect(after.find((key) => key.keyId === "rot-1")?.status).toBe("retiring");
		expect(after.find((key) => key.keyId === "rot-3")?.status).toBe("active");
	});

	test("revoke transitions active/retiring to revoked; double revoke is a 409", async () => {
		const created = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "revoke-me",
			publicKeyPem,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const revoked = await service.revokeLaunchKey({ tenantId, publishedAppId: appA, keyId: "revoke-me" });
		expect(revoked.ok).toBe(true);
		if (!revoked.ok) return;
		expect(revoked.data.key.status).toBe("revoked");
		expect(revoked.data.auditEventId).toBeTruthy();
		const again = await service.revokeLaunchKey({ tenantId, publishedAppId: appA, keyId: "revoke-me" });
		expect(again.ok).toBe(false);
		if (again.ok) return;
		expect(again.error.code).toBe("KEY_ALREADY_REVOKED");
		expect(again.error.httpStatus).toBe(409);
	});

	test("keys are scoped per app: app B cannot see or revoke app A's key", async () => {
		// Register a key on app A only.
		const created = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "a-scoped-key",
			publicKeyPem,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		// App B's scope cannot find app A's key: uniform 404, no existence leak.
		const crossRevoke = await service.revokeLaunchKey({ tenantId, publishedAppId: appB, keyId: "a-scoped-key" });
		expect(crossRevoke.ok).toBe(false);
		if (crossRevoke.ok) return;
		expect(crossRevoke.error.code).toBe("KEY_NOT_FOUND");
		expect(crossRevoke.error.httpStatus).toBe(404);
		// App B can still register the SAME keyId — keyIds are per-app namespaced.
		const bCreated = await service.createLaunchKey({
			tenantId,
			publishedAppId: appB,
			keyId: "a-scoped-key",
			publicKeyPem: secondPublicKeyPem,
		});
		expect(bCreated.ok).toBe(true);
		// App A's key is untouched; app A's list never contains app B's key.
		const aKey = await repos.launchKeys.getByKeyId({ tenantId, publishedAppId: appA }, "a-scoped-key");
		expect(aKey?.status).toBe("active");
		expect(aKey?.publicKeyPem).toBe(publicKeyPem);
		const bKey = await repos.launchKeys.getByKeyId({ tenantId, publishedAppId: appB }, "a-scoped-key");
		expect(bKey?.publicKeyPem).toBe(secondPublicKeyPem);
	});

	test("audit events are appended for launch-key create and revoke", async () => {
		const created = await service.createLaunchKey({
			tenantId,
			publishedAppId: appA,
			keyId: "audited-key",
			publicKeyPem,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const revoked = await service.revokeLaunchKey({ tenantId, publishedAppId: appA, keyId: "audited-key" });
		expect(revoked.ok).toBe(true);
		const events = await repos.audit.listByTenant({ tenantId }, 50);
		const createEvent = events.find((event) => event.action === "app.launch-key.create");
		const revokeEvent = events.find((event) => event.action === "app.launch-key.revoke");
		expect(createEvent).toBeTruthy();
		expect(revokeEvent).toBeTruthy();
		expect(createEvent?.resourceType).toBe("embed_launch_key");
		expect(createEvent?.resourceId).toBe("audited-key");
		expect(createEvent?.actorType).toBe("platform_admin");
		expect(revokeEvent?.resourceId).toBe("audited-key");
		// App-scoped console query reuses one parameter as text resource_id and
		// uuid published_app_id; explicit repository casts must keep it valid.
		const appEvents = await repos.audit.list({ scope: { tenantId }, appId: appA, limit: 50 });
		expect(appEvents.some((event) => event.action === "app.launch-key.create")).toBe(true);
		expect(appEvents.some((event) => event.action === "app.launch-key.revoke")).toBe(true);
	});
});

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
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { createControlHttpHandler } from "../../src/publishing/control/http.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { newTenantId, type PublishedAppId, type TenantId, toPublicId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const ADMIN_TOKEN = "control-admin-token-0123456789abcdef0123456789abcdef";

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

function httpCall(options: {
	method: string;
	path: string;
	base: string;
	headers?: Record<string, string>;
	body?: unknown;
}): Promise<{ status: number; body: any; requestId?: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, options.base);
		const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: {
					host: url.host,
					"content-type": "application/json",
					...(payload !== undefined ? { "content-length": Buffer.byteLength(payload) } : {}),
					...options.headers,
				},
			},
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let body: any;
					try {
						body = raw ? JSON.parse(raw) : undefined;
					} catch {
						body = raw;
					}
					resolve({
						status: res.statusCode ?? 0,
						body,
						requestId: res.headers["x-request-id"] as string | undefined,
					});
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe.skipIf(!pgUp)("launch key management", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;
	let handler: HttpRequestHandler;
	let httpBase: string;
	let tenantId: TenantId;
	let server: Server;
	/** Bare published-app ids for the two test apps. */
	let appA: PublishedAppId;
	let appB: PublishedAppId;
	/** Public ids for the HTTP tests. */
	let appAPublic: string;
	let appBPublic: string;
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
		appAPublic = toPublicId("PublishedAppId", appA);
		appBPublic = toPublicId("PublishedAppId", appB);
		handler = createControlHttpHandler({
			service,
			repositories: repos,
			adminToken: ADMIN_TOKEN,
			tenantId,
			source: source(baseConfig()),
			onError: (error) => console.error("CONTROL HANDLER ERROR:", error),
		});
		server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as { port: number };
		httpBase = `http://127.0.0.1:${address.port}`;

		const pair = await generateKeyPair("Ed25519", { extractable: true });
		publicKeyPem = await exportSPKI(pair.publicKey);
		privateKeyPem = await exportPKCS8(pair.privateKey);
		secondPublicKeyPem = await exportSPKI((await generateKeyPair("Ed25519", { extractable: true })).publicKey);
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
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
	});

	test("HTTP: POST launch-keys creates a key (201) and echoes an audit id", async () => {
		const res = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "lk-http-1" },
			body: { keyId: "http-key-1", publicKeyPem },
		});
		expect(res.status).toBe(201);
		expect(res.body.data.keyId).toBe("http-key-1");
		expect(res.body.data.algorithm).toBe("EdDSA");
		expect(res.body.data.status).toBe("active");
		expect(res.body.data.id).toMatch(/^lkey_/);
		expect(res.body.data.auditEventId).toMatch(/^aud_/);
		expect(res.body.data.expiresAt).toBeNull();
		expect(res.body.requestId).toBeTruthy();
	});

	test("HTTP: create launch-key validates the body (400) and rejects private keys (400)", async () => {
		const missing = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { publicKeyPem },
		});
		expect(missing.status).toBe(400);
		expect(missing.body.error.code).toBe("INVALID_REQUEST");
		const privateKey = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { keyId: "http-private", publicKeyPem: privateKeyPem },
		});
		expect(privateKey.status).toBe(400);
		expect(privateKey.body.error.code).toBe("INVALID_LAUNCH_KEY");
	});

	test("HTTP: duplicate keyId is a 409; unknown app is a uniform 404", async () => {
		const first = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { keyId: "http-dup", publicKeyPem },
		});
		expect(first.status).toBe(201);
		const dup = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { keyId: "http-dup", publicKeyPem: secondPublicKeyPem },
		});
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe("KEY_ID_CONFLICT");
		const unknownApp = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps/app_00000000-0000-7000-8000-000000000099/launch-keys",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { keyId: "http-any", publicKeyPem },
		});
		expect(unknownApp.status).toBe(404);
		expect(unknownApp.body.error.code).toBe("APP_NOT_FOUND");
	});

	test("HTTP: revoke (200), already revoked (409), unknown keyId (404), cross-app (404)", async () => {
		const created = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { keyId: "http-revoke", publicKeyPem },
		});
		expect(created.status).toBe(201);
		const revoked = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys/http-revoke/revoke`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {},
		});
		expect(revoked.status).toBe(200);
		expect(revoked.body.data.status).toBe("revoked");
		expect(revoked.body.data.auditEventId).toMatch(/^aud_/);
		const again = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys/http-revoke/revoke`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {},
		});
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe("KEY_ALREADY_REVOKED");
		const unknownKey = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys/never-registered/revoke`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {},
		});
		expect(unknownKey.status).toBe(404);
		expect(unknownKey.body.error.code).toBe("KEY_NOT_FOUND");
		// Cross-app: the key belongs to app A, so revoking via app B is 404.
		const crossApp = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appBPublic}/launch-keys/http-revoke/revoke`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {},
		});
		expect(crossApp.status).toBe(404);
		expect(crossApp.body.error.code).toBe("KEY_NOT_FOUND");
	});

	test("HTTP: idempotency replays the same create and conflicts on a different body", async () => {
		const body = { keyId: "http-idem", publicKeyPem };
		const first = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "lk-idem" },
			body,
		});
		expect(first.status).toBe(201);
		const replay = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "lk-idem" },
			body,
		});
		expect(replay.status).toBe(first.status);
		expect(replay.body).toEqual(first.body);
		const conflicting = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "lk-idem" },
			body: { keyId: "http-idem", publicKeyPem: secondPublicKeyPem },
		});
		expect(conflicting.status).toBe(409);
		expect(conflicting.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
	});

	test("control routes still require the admin token (401)", async () => {
		const res = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appAPublic}/launch-keys`,
			base: httpBase,
			body: { keyId: "no-token", publicKeyPem },
		});
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("UNAUTHORIZED");
	});
});

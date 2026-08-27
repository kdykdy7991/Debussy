/**
 * TASK-028: signed-user Exchange 与 nonce 防重放（spec 7.2 / 27.4）。
 *
 * 覆盖：Launch Token 成功交换（external_user Principal，身份稳定）；nonce
 * 重放（第二次必定 TOKEN_REPLAYED）；篡改签名 / 过期 / 未来 iat / 未知 kid /
 * revoked key / 错误 origin / 错误 appId / 错误 aud / 未白名单 iss；retiring
 * key（轮换窗口）仍可用；同 externalUserId 跨 App 隔离；externalUserId 篡改
 * 得到不同 Principal；未启用 signed-user 显式 403；App 状态与 accessMode 校
 * 验；HTTP 请求体校验；并发同 nonce 恰好一个成功；Redis 只存 nonce hash。
 * 需要本地 PostgreSQL + Redis（任一不可达自动 skip）。
 */
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { exportSPKI, type GenerateKeyPairResult, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createExchangeHttpHandler } from "../../src/embed/auth/exchange-http.ts";
import { LaunchTokenVerifier, nonceHash } from "../../src/embed/auth/launch-token.ts";
import { ExchangeService } from "../../src/embed/auth/principal.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { RedisClient } from "../../src/persistence/redis/client.ts";
import { createRedisNonceStore } from "../../src/persistence/redis/nonce-store.ts";
import {
	newAgentDefinitionId,
	newLaunchKeyId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	type PublicAppId,
	type PublishedAppId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { AccessMode, PublishedAppStatus } from "../../src/publishing/domain/states.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const REDIS_URL = process.env.PI_TEST_REDIS_URL ?? "redis://127.0.0.1:6380/15";
const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const ALLOWED_ORIGIN = "https://host-a.example.com";
const HOST_ISSUER = "https://host.example.com";
const AUDIENCE = "skdy-embed";

async function redisUp(): Promise<boolean> {
	try {
		const redis = new RedisClient({ url: REDIS_URL, connectTimeoutMs: 1000 });
		await redis.ping();
		await redis.close();
		return true;
	} catch {
		return false;
	}
}
async function pgUp(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}

const redisReady = await redisUp();
const pgReady = await pgUp();
const bothReady = redisReady && pgReady;

function httpCall(options: {
	method: string;
	path: string;
	base: string;
	headers?: Record<string, string>;
	body?: unknown;
}): Promise<{ status: number; body: any }> {
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
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec in test fixture");
	return sha256Hex(canonicalJson(parsed.spec));
}

function buildSpec(versionId: string): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads: { enabled: false, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: false },
			avatar: { enabled: false },
		},
		contextPolicy: { maxTurns: 100, maxContextTokens: 100000, toolResultMaxBytes: 65536 },
		runtimePolicy: {
			profile: "chat-with-files",
			turnTimeoutMs: 120000,
			idleTtlMs: 1200000,
			maxConcurrentTurnsPerConversation: 1,
		},
		theme: {},
		securityPolicyVersion: "sp_001",
	};
}

describe.skipIf(!bothReady)("signed-user principal exchange", () => {
	let client: PostgresClient;
	let redis: RedisClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let service: ExchangeService;
	let noLaunchService: ExchangeService;
	let handler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appAId: PublishedAppId;
	let appAPublicId: PublicAppId;
	let appBId: PublishedAppId;
	let appBPublicId: PublicAppId;
	let hostKeys: GenerateKeyPairResult;
	let hostPublicKeyPem: string;
	const hostKeyId = "host-key-2026-01";

	async function createApp(options: {
		name: string;
		status?: PublishedAppStatus;
		accessMode?: AccessMode;
		allowedOrigins?: readonly string[];
	}): Promise<{ appId: PublishedAppId; publicAppId: PublicAppId }> {
		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: `agent-${options.name}`,
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		const appId = newPublishedAppId();
		const publicAppId = newPublicAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId,
			name: options.name,
			status: options.status ?? "active",
			accessMode: options.accessMode ?? "mixed",
			currentVersionId: null,
			allowedOrigins: options.allowedOrigins ?? [ALLOWED_ORIGIN],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		const versionId = newPublishedAppVersionId();
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: buildSpec(versionId),
			runtimeSpecHash: specHash(buildSpec(versionId)),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appId }, appId, versionId);
		return { appId, publicAppId };
	}

	/** Register a host public key for an app (TASK-027 repository path). */
	async function registerKey(appId: PublishedAppId, keyId: string, publicKeyPem: string): Promise<void> {
		const result = await repos.launchKeys.insertWithRotation(
			{ tenantId, publishedAppId: appId },
			{
				launchKeyId: newLaunchKeyId(),
				tenantId,
				publishedAppId: appId,
				keyId,
				algorithm: "EdDSA",
				publicKeyPem,
				status: "active",
				notBefore: new Date(Date.now() - 60_000),
				expiresAt: null,
				createdAt: new Date(),
			},
		);
		if (result.outcome === "key_id_conflict") throw new Error(`duplicate keyId ${keyId}`);
	}

	/** Host signs a Launch Token (spec 7.2 claims). */
	async function signLaunchToken(options: {
		keyId?: string;
		appId: string;
		externalUserId: string;
		origin: string;
		nonce: string;
		iss?: string;
		aud?: string;
		iat?: number;
		exp?: number;
	}): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({
			appId: options.appId,
			externalUserId: options.externalUserId,
			origin: options.origin,
			nonce: options.nonce,
		})
			.setProtectedHeader({ alg: "EdDSA", kid: options.keyId ?? hostKeyId, typ: "JWT" })
			.setIssuer(options.iss ?? HOST_ISSUER)
			.setAudience(options.aud ?? AUDIENCE)
			.setIssuedAt(options.iat ?? now)
			.setExpirationTime(options.exp ?? now + 120)
			.sign(hostKeys.privateKey);
	}

	async function exchangeOverHttp(options: {
		publicAppId: string;
		launchToken: string;
		origin?: string;
	}): Promise<{ status: number; body: any }> {
		return httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: options.origin ?? ALLOWED_ORIGIN },
			body: {
				publicAppId: options.publicAppId,
				mode: "signed_user",
				launchToken: options.launchToken,
				hostOrigin: options.origin ?? ALLOWED_ORIGIN,
			},
		});
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		redis = new RedisClient({ url: REDIS_URL });
		tenantId = newTenantId();
		await repos.tenants.upsert({
			tenantId,
			name: "signed-user-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		accessTokens = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid-test-1",
			ttlSeconds: 600,
			...(await generateKeyPair("Ed25519")),
		});
		const verifier = new LaunchTokenVerifier({
			repositories: repos,
			nonces: createRedisNonceStore(redis),
			audience: AUDIENCE,
			allowedIssuers: [HOST_ISSUER],
		});
		service = new ExchangeService({
			repositories: repos,
			accessTokens,
			subjectPepper: PEPPER,
			launchTokens: verifier,
		});
		noLaunchService = new ExchangeService({ repositories: repos, accessTokens, subjectPepper: PEPPER });
		handler = createExchangeHttpHandler({ service, onError: (error) => console.error("EXCHANGE ERROR:", error) });
		server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		httpBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

		hostKeys = await generateKeyPair("Ed25519", { extractable: true });
		hostPublicKeyPem = await exportSPKI(hostKeys.publicKey);
		const appA = await createApp({ name: "App A", accessMode: "mixed" });
		appAId = appA.appId;
		appAPublicId = appA.publicAppId;
		const appB = await createApp({ name: "App B", accessMode: "signed_user" });
		appBId = appB.appId;
		appBPublicId = appB.publicAppId;
		await registerKey(appAId, hostKeyId, hostPublicKeyPem);
		await registerKey(appBId, hostKeyId, hostPublicKeyPem);
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		await redis.close();
	});

	test("successful signed-user exchange (200): external_user principal, stable identity", async () => {
		const first = await exchangeOverHttp({
			publicAppId: appAPublicId,
			launchToken: await signLaunchToken({
				appId: appAPublicId,
				externalUserId: "host-user-123",
				origin: ALLOWED_ORIGIN,
				nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			}),
		});
		expect(first.status).toBe(200);
		expect(first.body.requestId).toBeTruthy();
		expect(first.body.data.principal.type).toBe("external_user");
		expect(first.body.data.principal.id).toMatch(/^prn_/);
		expect(first.body.data.app.publicAppId).toBe(appAPublicId);
		const verified = await accessTokens.verify(first.body.data.accessToken);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.claims.principalType).toBe("external_user");
		expect(verified.claims.publishedAppId).toBe(appAId);
		expect(verified.claims.principalId).toBe(first.body.data.principal.id.slice(4));

		// Same externalUserId + new nonce -> same principal (stable identity).
		const second = await exchangeOverHttp({
			publicAppId: appAPublicId,
			launchToken: await signLaunchToken({
				appId: appAPublicId,
				externalUserId: "host-user-123",
				origin: ALLOWED_ORIGIN,
				nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			}),
		});
		expect(second.status).toBe(200);
		expect(second.body.data.principal.id).toBe(first.body.data.principal.id);
	});

	test("a different externalUserId gets a different principal (no shared identity)", async () => {
		const first = await exchangeOverHttp({
			publicAppId: appAPublicId,
			launchToken: await signLaunchToken({
				appId: appAPublicId,
				externalUserId: "host-user-aaa",
				origin: ALLOWED_ORIGIN,
				nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			}),
		});
		const second = await exchangeOverHttp({
			publicAppId: appAPublicId,
			launchToken: await signLaunchToken({
				appId: appAPublicId,
				externalUserId: "host-user-bbb",
				origin: ALLOWED_ORIGIN,
				nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			}),
		});
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(first.body.data.principal.id).not.toBe(second.body.data.principal.id);
	});

	test("same externalUserId across apps is isolated (app namespaced identity)", async () => {
		const inA = await exchangeOverHttp({
			publicAppId: appAPublicId,
			launchToken: await signLaunchToken({
				appId: appAPublicId,
				externalUserId: "shared-user",
				origin: ALLOWED_ORIGIN,
				nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			}),
		});
		const inB = await exchangeOverHttp({
			publicAppId: appBPublicId,
			launchToken: await signLaunchToken({
				appId: appBPublicId,
				externalUserId: "shared-user",
				origin: ALLOWED_ORIGIN,
				nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			}),
		});
		expect(inA.status).toBe(200);
		expect(inB.status).toBe(200);
		expect(inA.body.data.principal.id).not.toBe(inB.body.data.principal.id);
		// The same public key id is registered per app; scoped lookups never cross.
		const aKey = await repos.launchKeys.getByKeyId({ tenantId, publishedAppId: appAId }, hostKeyId);
		const bKey = await repos.launchKeys.getByKeyId({ tenantId, publishedAppId: appBId }, hostKeyId);
		expect(aKey?.status).toBe("active");
		expect(bKey?.status).toBe("active");
	});

	test("nonce replay: the same Launch Token can only be exchanged once", async () => {
		const nonce = `replay-${Math.random().toString(36).slice(2)}`;
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "replay-user",
			origin: ALLOWED_ORIGIN,
			nonce,
		});
		const first = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(first.status).toBe(200);
		const replay = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(replay.status).toBe(401);
		expect(replay.body.error.code).toBe("TOKEN_REPLAYED");
	});

	test("concurrent exchanges with the same nonce: exactly one wins", async () => {
		const nonce = `race-${Math.random().toString(36).slice(2)}`;
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "race-user",
			origin: ALLOWED_ORIGIN,
			nonce,
		});
		const results = await Promise.all([
			exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token }),
			exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token }),
		]);
		const ok = results.filter((result) => result.status === 200);
		const replayed = results.filter((result) => result.status === 401 && result.body.error.code === "TOKEN_REPLAYED");
		expect(ok).toHaveLength(1);
		expect(replayed).toHaveLength(1);
	});

	test("tampered signature is rejected", async () => {
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "tamper-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const tampered = `${token.slice(0, -2)}xx`;
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: tampered });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_INVALID");
	});

	test("expired Launch Token is rejected as TOKEN_EXPIRED", async () => {
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "expired-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			exp: Math.floor(Date.now() / 1000) - 60,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_EXPIRED");
	});

	test("iat in the future is rejected (beyond clock skew)", async () => {
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "future-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			iat: Math.floor(Date.now() / 1000) + 180,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_INVALID");
	});

	test("unknown kid is rejected", async () => {
		const token = await signLaunchToken({
			keyId: "unknown-kid",
			appId: appAPublicId,
			externalUserId: "kid-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_INVALID");
	});

	test("revoked key is rejected", async () => {
		const revokedKeyId = "revoked-key-2026";
		await registerKey(appAId, revokedKeyId, hostPublicKeyPem);
		const key = await repos.launchKeys.getByKeyId({ tenantId, publishedAppId: appAId }, revokedKeyId);
		if (key === undefined) throw new Error("revoked key not registered");
		await repos.launchKeys.updateStatus({ tenantId, publishedAppId: appAId }, key.launchKeyId, "revoked");
		const token = await signLaunchToken({
			keyId: revokedKeyId,
			appId: appAPublicId,
			externalUserId: "revoked-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_INVALID");
	});

	test("retiring key (rotation window) is still accepted", async () => {
		const oldKeyId = "rotating-old-key";
		await registerKey(appAId, oldKeyId, hostPublicKeyPem);
		// Registering a NEW key retires the old one; both must verify (TASK-027).
		const newKeys = await generateKeyPair("Ed25519", { extractable: true });
		const result = await repos.launchKeys.insertWithRotation(
			{ tenantId, publishedAppId: appAId },
			{
				launchKeyId: newLaunchKeyId(),
				tenantId,
				publishedAppId: appAId,
				keyId: "rotating-new-key",
				algorithm: "EdDSA",
				publicKeyPem: await exportSPKI(newKeys.publicKey),
				status: "active",
				notBefore: new Date(Date.now() - 60_000),
				expiresAt: null,
				createdAt: new Date(),
			},
		);
		expect(result.outcome).toBe("created");
		const old = await repos.launchKeys.getByKeyId({ tenantId, publishedAppId: appAId }, oldKeyId);
		expect(old?.status).toBe("retiring");

		// Old (retiring) key still verifies.
		const oldToken = await signLaunchToken({
			keyId: oldKeyId,
			appId: appAPublicId,
			externalUserId: "rotation-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const oldRes = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: oldToken });
		expect(oldRes.status).toBe(200);
	});

	test("token origin mismatch with the request origin is rejected", async () => {
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "origin-user",
			origin: "https://evil.example.com",
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_INVALID");
	});

	test("token appId mismatch with the requested app is rejected", async () => {
		const token = await signLaunchToken({
			appId: appBPublicId,
			externalUserId: "wrong-app-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("TOKEN_INVALID");
	});

	test("wrong audience and unallowlisted issuer are rejected", async () => {
		const wrongAud = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "aud-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			aud: "some-other-audience",
		});
		const audRes = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: wrongAud });
		expect(audRes.status).toBe(401);
		expect(audRes.body.error.code).toBe("TOKEN_INVALID");

		const wrongIss = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "iss-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
			iss: "https://evil.example.com",
		});
		const issRes = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: wrongIss });
		expect(issRes.status).toBe(401);
		expect(issRes.body.error.code).toBe("TOKEN_INVALID");
	});

	test("signed-user exchange is explicitly forbidden when not enabled (no verifier)", async () => {
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "disabled-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const result = await noLaunchService.exchangeSignedUser({
			publicAppId: appAPublicId,
			launchToken: token,
			origin: ALLOWED_ORIGIN,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("FORBIDDEN");
	});

	test("app policy gates: anonymous-only app, suspended app, disallowed origin", async () => {
		const anonOnly = await createApp({ name: "Anon Only", accessMode: "anonymous" });
		const tokenForAnon = await signLaunchToken({
			appId: anonOnly.publicAppId,
			externalUserId: "policy-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const anonRes = await exchangeOverHttp({ publicAppId: anonOnly.publicAppId, launchToken: tokenForAnon });
		expect(anonRes.status).toBe(403);
		expect(anonRes.body.error.code).toBe("FORBIDDEN");

		const suspended = await createApp({ name: "Suspended", accessMode: "mixed", status: "suspended" });
		const tokenForSuspended = await signLaunchToken({
			appId: suspended.publicAppId,
			externalUserId: "policy-user",
			origin: ALLOWED_ORIGIN,
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const suspendedRes = await exchangeOverHttp({
			publicAppId: suspended.publicAppId,
			launchToken: tokenForSuspended,
		});
		expect(suspendedRes.status).toBe(403);
		expect(suspendedRes.body.error.code).toBe("APP_SUSPENDED");

		const restricted = await createApp({
			name: "Restricted Origin",
			accessMode: "mixed",
			allowedOrigins: ["https://other.example.com"],
		});
		const tokenForRestricted = await signLaunchToken({
			appId: restricted.publicAppId,
			externalUserId: "policy-user",
			origin: "https://other.example.com",
			nonce: `nonce-${Math.random().toString(36).slice(2)}`,
		});
		const originRes = await exchangeOverHttp({
			publicAppId: restricted.publicAppId,
			launchToken: tokenForRestricted,
		});
		expect(originRes.status).toBe(403);
		expect(originRes.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
	});

	test("HTTP body validation: missing/non-string launchToken, unknown mode", async () => {
		const missing = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: { publicAppId: appAPublicId, mode: "signed_user" },
		});
		expect(missing.status).toBe(400);
		expect(missing.body.error.code).toBe("INVALID_REQUEST");

		const nonString = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: { publicAppId: appAPublicId, mode: "signed_user", launchToken: 42 },
		});
		expect(nonString.status).toBe(400);

		const unknownMode = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: { publicAppId: appAPublicId, mode: "magic" },
		});
		expect(unknownMode.status).toBe(400);
	});

	test("Redis stores only the nonce hash, never the plaintext", async () => {
		const nonce = `plaintext-${Math.random().toString(36).slice(2)}-should-never-be-stored`;
		const token = await signLaunchToken({
			appId: appAPublicId,
			externalUserId: "hash-user",
			origin: ALLOWED_ORIGIN,
			nonce,
		});
		const res = await exchangeOverHttp({ publicAppId: appAPublicId, launchToken: token });
		expect(res.status).toBe(200);
		const hashKeyExists = await redis.run("EXISTS", `embed:nonce:${nonceHash(nonce)}`);
		const plainKeyExists = await redis.run("EXISTS", `embed:nonce:${nonce}`);
		const shaOfPlain = createHash("sha256").update(nonce, "utf8").digest("hex");
		expect(hashKeyExists).toBe(1);
		expect(plainKeyExists).toBe(0);
		expect(nonceHash(nonce)).toBe(shaOfPlain);
	});
});

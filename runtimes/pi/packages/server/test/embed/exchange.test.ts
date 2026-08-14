/**
 * TASK-015: 匿名 Principal Exchange 集成测试（spec 7.1 / 27.4）。
 *
 * 覆盖：成功 Exchange 的 200 + Access Token 只授权一个 App 一个 Principal；
 * 同访客同 App 身份稳定；不同访客 / 不同 App 严格隔离；App suspended /
 * draft / signed_user-only 拒绝；Origin 拒绝；未知 publicAppId 404；请求体
 * 校验 400；visitorId 永不落库、永不进 token、错误响应不回显。
 * 需要本地测试数据库（不可达时自动 skip）。
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createExchangeHttpHandler } from "../../src/embed/auth/exchange-http.ts";
import { ExchangeService } from "../../src/embed/auth/principal.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	newAgentDefinitionId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
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
const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const ALLOWED_ORIGIN = "https://host-a.example.com";

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

function httpCall(options: {
	method: string;
	path: string;
	base: string;
	headers?: Record<string, string>;
	body?: unknown;
}): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
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
					resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

function exchangeBody(publicAppId: string, visitorId: string): Record<string, unknown> {
	return { publicAppId, mode: "anonymous", anonymousVisitorId: visitorId };
}

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec in test fixture");
	return sha256Hex(canonicalJson(parsed.spec));
}

function buildSpec(versionId: string, features: { uploads: boolean; speech: boolean; avatar: boolean }): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads: { enabled: features.uploads, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: features.speech },
			avatar: { enabled: features.avatar },
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

describe.skipIf(!pgUp)("anonymous principal exchange", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let service: ExchangeService;
	let handler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appAId: PublishedAppId;
	let appAPublicId: string;
	let appAVersionId: string;
	let appBId: PublishedAppId;
	let appBPublicId: string;

	async function createApp(options: {
		name: string;
		status?: PublishedAppStatus;
		accessMode?: AccessMode;
		allowedOrigins?: readonly string[];
		features?: { uploads: boolean; speech: boolean; avatar: boolean };
		withVersion?: boolean;
	}): Promise<{ appId: PublishedAppId; publicAppId: string; versionId: string | null }> {
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
		if (options.withVersion !== false) {
			const versionId = newPublishedAppVersionId();
			const features = options.features ?? { uploads: true, speech: false, avatar: false };
			await repos.publishedAppVersions.insert({
				publishedAppVersionId: versionId,
				tenantId,
				publishedAppId: appId,
				versionNumber: 1,
				sourceAgentRevision: 1,
				snapshot: { prompt: "hi" },
				runtimeSpec: buildSpec(versionId, features),
				runtimeSpecHash: specHash(buildSpec(versionId, features)),
				status: "ready",
				validationErrors: [],
				createdAt: now,
			});
			await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appId }, appId, versionId);
			return { appId, publicAppId, versionId };
		}
		return { appId, publicAppId, versionId: null };
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		tenantId = newTenantId();
		await repos.tenants.upsert({
			tenantId,
			name: "exchange-test",
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
		service = new ExchangeService({ repositories: repos, accessTokens, subjectPepper: PEPPER });
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

		const appA = await createApp({ name: "App A", features: { uploads: true, speech: false, avatar: false } });
		appAId = appA.appId;
		appAPublicId = appA.publicAppId;
		appAVersionId = appA.versionId!;
		const appB = await createApp({ name: "App B" });
		appBId = appB.appId;
		appBPublicId = appB.publicAppId;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("exchange succeeds for an allowed origin (200) with a scoped access token", async () => {
		const visitorId = "v".repeat(64);
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorId),
		});
		expect(res.status).toBe(200);
		expect(res.body.requestId).toBeTruthy();
		expect(res.headers["x-request-id"]).toBe(res.body.requestId);
		expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
		const data = res.body.data;
		expect(typeof data.accessToken).toBe("string");
		expect(data.accessToken.split(".")).toHaveLength(3);
		expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());
		expect(data.principal.id).toMatch(/^prn_/);
		expect(data.principal.type).toBe("anonymous_visitor");
		expect(data.app.publicAppId).toBe(appAPublicId);
		expect(data.app.name).toBe("App A");
		expect(data.app.currentVersionId).toBe(`pav_${appAVersionId}`);
		expect(data.app.features).toEqual({ uploads: true, speech: false, avatar: false });

		// Token 只授权一个 App 一个 Principal：claims 与本次 Exchange 完全一致。
		const verified = await accessTokens.verify(data.accessToken);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.claims.tenantId).toBe(tenantId);
		expect(verified.claims.publishedAppId).toBe(appAId);
		expect(verified.claims.principalId).toBe(data.principal.id.slice(4));
		expect(verified.claims.principalType).toBe("anonymous_visitor");
		expect(verified.claims.publishedAppVersionId).toBe(appAVersionId);
	});

	test("the same visitor on the same app resolves to the same principal (stable identity)", async () => {
		const visitorId = "stable-visitor-".repeat(5); // 70 chars
		const first = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorId),
		});
		const second = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorId),
		});
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(second.body.data.principal.id).toBe(first.body.data.principal.id);
		expect(second.body.data.accessToken).not.toBe(first.body.data.accessToken);
	});

	test("different visitors never share a principal, and no raw visitorId is persisted", async () => {
		const visitorX = "visitor-x-".repeat(8);
		const visitorY = "visitor-y-".repeat(8);
		const x = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorX),
		});
		const y = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorY),
		});
		expect(x.status).toBe(200);
		expect(y.status).toBe(200);
		expect(x.body.data.principal.id).not.toBe(y.body.data.principal.id);

		// 落库的只有 HMAC subject hash，绝无原始 visitorId / 密文字段。
		const rows = await client.run(
			"select subject_hash, external_user_id_ciphertext from principals where tenant_id = $1 and published_app_id = $2 order by created_at",
			tenantId,
			appAId,
		);
		const hashes = rows.map((row) => String(row.subject_hash));
		expect(hashes.length).toBeGreaterThanOrEqual(4); // 此前每个测试访客各一个 Principal
		for (const hash of hashes) {
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
			expect(hash).not.toContain("visitor-");
		}
		for (const row of rows) {
			expect(row.external_user_id_ciphertext).toBeNull();
		}
		const anyRaw = await client.run(
			"select count(*) as n from principals where tenant_id = $1 and (subject_hash like $2 or subject_hash like $3)",
			tenantId,
			`%visitor-x%`,
			`%visitor-y%`,
		);
		expect(Number(anyRaw[0].n)).toBe(0);
	});

	test("the same visitor on a different app is isolated (app namespace)", async () => {
		const visitorId = "cross-app-".repeat(7);
		const appA = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorId),
		});
		const appB = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appBPublicId, visitorId),
		});
		expect(appA.status).toBe(200);
		expect(appB.status).toBe(200);
		expect(appA.body.data.principal.id).not.toBe(appB.body.data.principal.id);
		expect(appA.body.data.app.publicAppId).toBe(appAPublicId);
		expect(appB.body.data.app.publicAppId).toBe(appBPublicId);
		// App B 的 token 不能携带 App A 的 scope。
		const verifiedB = await accessTokens.verify(appB.body.data.accessToken);
		expect(verifiedB.ok).toBe(true);
		if (verifiedB.ok) {
			expect(verifiedB.claims.publishedAppId).toBe(appBId);
			expect(verifiedB.claims.publishedAppId).not.toBe(appAId);
		}
	});

	test("rejects an origin that is not on the app allowlist (403 ORIGIN_NOT_ALLOWED)", async () => {
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: "https://evil.example.com" },
			body: exchangeBody(appAPublicId, "e".repeat(64)),
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
		expect(res.body.error.requestId).toBeTruthy();
	});

	test("rejects a missing Origin header (403 ORIGIN_NOT_ALLOWED)", async () => {
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			body: exchangeBody(appAPublicId, "m".repeat(64)),
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
	});

	test("rejects a suspended app (403 APP_SUSPENDED)", async () => {
		const suspended = await createApp({ name: "Suspended App" });
		await repos.publishedApps.updateMutable({ tenantId, publishedAppId: suspended.appId }, suspended.appId, {
			status: "suspended",
		});
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(suspended.publicAppId, "s".repeat(64)),
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("APP_SUSPENDED");
	});

	test("rejects a draft app (no active version yet)", async () => {
		const draft = await createApp({ name: "Draft App", status: "draft", withVersion: false });
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(draft.publicAppId, "d".repeat(64)),
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("APP_SUSPENDED");
	});

	test("rejects an app whose accessMode excludes anonymous visitors (403 FORBIDDEN)", async () => {
		const signedOnly = await createApp({ name: "Signed Only", accessMode: "signed_user" });
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(signedOnly.publicAppId, "q".repeat(64)),
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("FORBIDDEN");
	});

	test("rejects an unknown publicAppId without leaking existence (404)", async () => {
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody("pub_00000000-0000-7000-8000-000000000000", "u".repeat(64)),
		});
		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("APP_NOT_FOUND");
	});

	test("an active app without a current version still exchanges with disabled features", async () => {
		const noVersion = await createApp({ name: "No Version", withVersion: false });
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(noVersion.publicAppId, "n".repeat(64)),
		});
		expect(res.status).toBe(200);
		expect(res.body.data.app.currentVersionId).toBeNull();
		expect(res.body.data.app.features).toEqual({ uploads: false, speech: false, avatar: false });
	});

	test("rejects malformed exchange bodies with 400 and never echoes the visitorId", async () => {
		const cases: { label: string; body: unknown; message: string }[] = [
			{ label: "non-object", body: "nope", message: "request body must be a JSON object" },
			{
				label: "missing publicAppId",
				body: { mode: "anonymous", anonymousVisitorId: "x".repeat(64) },
				message: "publicAppId must be a string",
			},
			{
				label: "bad publicAppId",
				body: { publicAppId: "not-a-locator", mode: "anonymous", anonymousVisitorId: "x".repeat(64) },
				message: "pub_<uuid>",
			},
			{
				label: "missing visitorId",
				body: { publicAppId: appAPublicId, mode: "anonymous" },
				message: "anonymousVisitorId",
			},
			{
				label: "too short visitorId",
				body: { publicAppId: appAPublicId, mode: "anonymous", anonymousVisitorId: "short" },
				message: "32..512",
			},
			{
				label: "wrong mode",
				body: { publicAppId: appAPublicId, mode: "signed_user" },
				message: "mode must be 'anonymous'",
			},
		];
		for (const c of cases) {
			const res = await httpCall({
				method: "POST",
				path: "/api/embed/v1/exchange",
				base: httpBase,
				headers: { origin: ALLOWED_ORIGIN },
				body: c.body,
			});
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("INVALID_REQUEST");
			expect(res.body.error.message).toContain(c.message);
			// 错误消息绝不包含任何访客 ID 值。
			expect(JSON.stringify(res.body)).not.toContain("short");
		}
	});

	test("invalid JSON is a 400 and oversized bodies are a 413", async () => {
		const invalidJson = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const url = new URL("/api/embed/v1/exchange", httpBase);
			const req = httpRequest(
				url,
				{ method: "POST", headers: { host: url.host, origin: ALLOWED_ORIGIN, "content-length": "1" } },
				(res: IncomingMessage) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
				},
			);
			req.on("error", reject);
			req.write("{");
			req.end();
		});
		expect(invalidJson.status).toBe(400);
		expect(invalidJson.body).toContain("INVALID_JSON");

		const big = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: { publicAppId: appAPublicId, mode: "anonymous", anonymousVisitorId: "b".repeat(70_000) },
		});
		expect(big.status).toBe(413);
		expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("the issued token and responses never contain the raw visitorId (脱敏)", async () => {
		const visitorId = "sensitive-visitor-id-0123456789abcdef0123456789abcdef";
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: exchangeBody(appAPublicId, visitorId),
		});
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toContain(visitorId);
		// 解码 JWT payload：无 visitor 相关 claim，无原始值。
		const payloadPart = res.body.data.accessToken.split(".")[1] as string;
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf-8"));
		expect(JSON.stringify(payload)).not.toContain(visitorId);
		expect(payload).not.toHaveProperty("anonymousVisitorId");
		expect(payload).not.toHaveProperty("visitorId");
	});

	test("preflight OPTIONS is answered and unclaimed paths fall through", async () => {
		const preflight = await httpCall({
			method: "OPTIONS",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "POST" },
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
		expect(preflight.headers["access-control-allow-methods"]).toContain("POST");

		const wrongMethod = await httpCall({ method: "GET", path: "/api/embed/v1/exchange", base: httpBase });
		expect(wrongMethod.status).toBe(405);

		const unclaimed = await httpCall({ method: "GET", path: "/api/embed/v1/health", base: httpBase });
		expect(unclaimed.status).toBe(404);
		expect(unclaimed.body).toBe("Not found");
	});
});

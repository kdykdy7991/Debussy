/**
 * TASK-037：Embed 数据面安全验收（spec 阶段 H / PD 系列）。
 *
 * 交叉边界安全矩阵，全部走真实 `createEmbedServices` handler（真实 PG +
 * 真实 AccessToken，挂到真实 HTTP server）：
 * - Tenant/App/Principal 三重越权 → 统一 404（不做 ID 枚举 / 不存在性 oracle）
 * - 随机 ID 枚举 → 404（不泄漏资源存在性）
 * - Origin 绕过 → 403 ORIGIN_NOT_ALLOWED（缺 Origin / 非白名单宿主同）
 * - App suspend → 已签发 token 在会话创建时被拒（PD-04，简单回滚）
 * - 上传伪造：checksum 不匹配 / 声明 MIME 与文件头不符 → 422 UPLOAD_REJECTED；
 *   跨 Principal 上传 → 404
 * - 响应/错误不回显凭据或身份（accessToken 之外的 visitorId 等不泄漏）
 *
 * 单主题的 LaunchKey/AccessToken/Ticket 重放与 nonce 并发见
 * signed-user-exchange / ws-ticket / access-token 测试；日志脱敏见
 * logging-redact 测试；跨租户控制边界见 control-service 测试（本文件只做 embed
 * 数据面交叉边界矩阵）。需本地测试数据库（不可达自动 skip）。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createEmbedServices, loadEmbedPlaneConfig } from "../../src/embed/start.ts";
import { LocalTestObjectStore } from "../../src/persistence/object-store/local-test.ts";
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
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex as specSha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `sec_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const PEPPER = "security-pepper-0123456789abcdef0123456789abcdef";
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
	raw?: Uint8Array;
}): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, options.base);
		const payload =
			options.raw !== undefined
				? options.raw
				: options.body === undefined
					? undefined
					: JSON.stringify(options.body);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: {
					host: url.host,
					...(payload !== undefined && options.raw === undefined
						? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
						: {}),
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
		if (payload !== undefined) req.write(Buffer.from(payload));
		req.end();
	});
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec in security fixture");
	return specSha256Hex(canonicalJson(parsed.spec));
}

function buildSpec(versionId: string): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
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

describe.skipIf(!pgUp)("embed data plane security matrix", () => {
	let root: string;
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let handlers: readonly HttpRequestHandler[];
	let server: Server;
	let httpBase: string;

	const tenantA = newTenantId();
	const tenantB = newTenantId();
	const appA = newPublishedAppId();
	const appB = newPublishedAppId();
	const appX = newPublishedAppId();
	let publicA: string;
	let publicB: string;
	let publicX: string;
	let versionAppA: string;
	let versionAppB: string;
	let versionAppX: string;

	let tokenA1: string;
	let tokenA2: string;
	let tokenB: string;
	let tokenX: string;
	let convId: string;
	let attachmentId: string;

	async function setupApp(
		tenantId: TenantId,
		appId: PublishedAppId,
		name: string,
	): Promise<{ publicAppId: string; versionId: string }> {
		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: `agent-${name}`,
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		const publicAppId = newPublicAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId,
			name,
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [ALLOWED_ORIGIN],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		const versionId = newPublishedAppVersionId();
		const spec = buildSpec(versionId);
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: spec,
			runtimeSpecHash: specHash(spec),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appId }, appId, versionId);
		return { publicAppId, versionId };
	}

	async function exchange(publicAppId: string, visitorId: string, origin = ALLOWED_ORIGIN): Promise<string> {
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin },
			body: { publicAppId, mode: "anonymous", anonymousVisitorId: visitorId },
		});
		expect(res.status).toBe(200);
		return res.body.data.accessToken as string;
	}

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-embed-sec-"));
		const keys = await generateKeyPair("Ed25519", { extractable: true });
		const privateKeyFile = join(root, "embed-access-private.pem");
		const publicKeyFile = join(root, "embed-access-public.pem");
		writeFileSync(privateKeyFile, await exportPKCS8(keys.privateKey), "utf8");
		writeFileSync(publicKeyFile, await exportSPKI(keys.publicKey), "utf8");

		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		const now = new Date();
		for (const t of [
			{ id: tenantA, name: "tenant-a" },
			{ id: tenantB, name: "tenant-b" },
		]) {
			await repos.tenants.upsert({ tenantId: t.id, name: t.name, status: "active", createdAt: now, updatedAt: now });
		}

		({ publicAppId: publicA, versionId: versionAppA } = await setupApp(tenantA, appA, "app-a"));
		({ publicAppId: publicB, versionId: versionAppB } = await setupApp(tenantA, appB, "app-b"));
		({ publicAppId: publicX, versionId: versionAppX } = await setupApp(tenantB, appX, "app-x"));

		const config = await loadEmbedPlaneConfig({
			enabled: true,
			databaseUrl: PG_URL,
			redisUrl: undefined,
			bootstrapTenantId: tenantA,
			bootstrapTenantName: "tenant-a",
			controlAdminTokenFile: undefined,
			embedBaseUrl: "https://agent.example.com",
			subjectPepper: PEPPER,
			accessTokenPrivateKeyFile: privateKeyFile,
			accessTokenPublicKeyFile: publicKeyFile,
			accessTokenKeyId: "kid-sec",
			accessTokenTtlSeconds: 600,
			launchTokenAudience: "skdy-embed",
			launchTokenAllowedIssuers: [],
			uploadQuota: {
				conversationBytes: 100 * 1024 * 1024,
				principalBytes: 500 * 1024 * 1024,
				appBytes: 2 * 1024 * 1024 * 1024,
			},
		});
		accessTokens = config.accessTokens;
		const localObjectStore = new LocalTestObjectStore(join(root, "objects"));
		const services = createEmbedServices({
			accessTokens: config.accessTokens,
			subjectPepper: config.subjectPepper,
			repositories: repos,
			createSession: async () => ({}) as never,
			objectStore: localObjectStore,
			attachmentBucket: "attachments",
		});
		handlers = services.handlers;
		server = createServer((req, res) => {
			(async () => {
				for (const handler of handlers) {
					if (await handler(req, res)) return;
				}
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Not found");
			})();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		httpBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

		// 签发 4 个身份：同 app 两访客、同租户另一 app、跨租户 app。
		tokenA1 = await exchange(publicA, "visitor-one-".repeat(4));
		tokenA2 = await exchange(publicA, "visitor-two-".repeat(4));
		tokenB = await exchange(publicB, "visitor-one-".repeat(4));
		tokenX = await exchange(publicX, "visitor-one-".repeat(4));

		const created = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA1}` },
			body: { title: "sec" },
		});
		expect(created.status).toBe(201);
		convId = created.body.data.id as string;

		const upload = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/uploads`,
			base: httpBase,
			headers: {
				authorization: `Bearer ${tokenA1}`,
				"x-filename": "notes.txt",
				"content-type": "text/plain",
				"x-checksum-sha256": sha256(new TextEncoder().encode("hello world")),
			},
			raw: new TextEncoder().encode("hello world"),
		});
		expect(upload.status).toBe(201);
		attachmentId = upload.body.data.id as string;
		void versionAppA;
		void versionAppB;
		void versionAppX;
	});

	afterAll(async () => {
		if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("cross-principal read of a conversation returns unified 404 (no oracle)", async () => {
		for (const token of [tokenA2, tokenB, tokenX]) {
			const res = await httpCall({
				method: "GET",
				path: `/api/embed/v1/conversations/${convId}`,
				base: httpBase,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(res.status).toBe(404);
			expect(res.body.error.code).toBe("CONVERSATION_NOT_FOUND");
		}
	});

	test("random conversation/attachment id enumeration returns 404, not 403", async () => {
		const randomConvId = `conv_${randomUUID()}`;
		const res = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${randomConvId}`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA1}` },
		});
		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("CONVERSATION_NOT_FOUND");
		const randomAtt = `att_${randomUUID()}`;
		const att = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convId}/uploads/${randomAtt}`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA1}` },
		});
		expect(att.status).toBe(404);
	});

	test("cross-principal attachment read returns unified 404", async () => {
		for (const token of [tokenA2, tokenB, tokenX]) {
			const res = await httpCall({
				method: "GET",
				path: `/api/embed/v1/conversations/${convId}/uploads/${attachmentId}`,
				base: httpBase,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(res.status).toBe(404);
		}
	});

	test("origin bypass is rejected: non-allowlisted or missing host", async () => {
		for (const origin of ["https://evil.example.com", undefined]) {
			const headers: Record<string, string> = origin === undefined ? {} : { origin };
			const res = await httpCall({
				method: "POST",
				path: "/api/embed/v1/exchange",
				base: httpBase,
				headers,
				body: { publicAppId: publicA, mode: "anonymous", anonymousVisitorId: "visitor-x-".repeat(4) },
			});
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
		}
	});

	test("forged uploads are rejected: bad checksum, and MIME/extension mismatch", async () => {
		const body = new TextEncoder().encode("forged bytes");
		const badChecksum = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/uploads`,
			base: httpBase,
			headers: {
				authorization: `Bearer ${tokenA1}`,
				"x-filename": "note.txt",
				"content-type": "text/plain",
				"x-checksum-sha256": sha256(new TextEncoder().encode("different")),
			},
			raw: body,
		});
		expect(badChecksum.status).toBe(422);
		expect(badChecksum.body.error.code).toBe("UPLOAD_REJECTED");

		const forgedMime = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/uploads`,
			base: httpBase,
			headers: {
				authorization: `Bearer ${tokenA1}`,
				"x-filename": "photo.png",
				"content-type": "image/png",
			},
			raw: new TextEncoder().encode("this is text, not a real png"),
		});
		expect(forgedMime.status).toBe(422);
		expect(forgedMime.body.error.code).toBe("UPLOAD_REJECTED");
	});

	test("cross-principal upload to another's conversation is 404", async () => {
		const res = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/uploads`,
			base: httpBase,
			headers: {
				authorization: `Bearer ${tokenA2}`,
				"x-filename": "x.txt",
				"content-type": "text/plain",
			},
			raw: new TextEncoder().encode("x"),
		});
		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("CONVERSATION_NOT_FOUND");
	});

	test("anonymous exchange does not echo the visitorId back", async () => {
		const visitorId = "visitor-secret-".repeat(4);
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: { publicAppId: publicA, mode: "anonymous", anonymousVisitorId: visitorId },
		});
		expect(res.status).toBe(200);
		const text = JSON.stringify(res.body);
		expect(text).toContain("accessToken");
		expect(text).not.toContain(visitorId);
	});

	test("suspending the app rejects an already-issued token at conversation create (PD-04)", async () => {
		await repos.publishedApps.updateMutable({ tenantId: tenantA, publishedAppId: appA }, appA, {
			status: "suspended",
		});
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA1}` },
			body: { title: "should-not-exist" },
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("APP_SUSPENDED");
	});

	test("token verifies through the same service (identity round-trip)", async () => {
		const verified = await accessTokens.verify(tokenA1);
		expect(verified.ok).toBe(true);
		if (verified.ok) expect(verified.claims.publishedAppId).toBe(appA);
	});
});

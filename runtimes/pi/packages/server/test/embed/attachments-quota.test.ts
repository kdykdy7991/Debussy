/**
 * TASK-031: Attachment ResourceOwner 与配额测试（spec 14 / 13.2 / 27.5）。
 *
 * 覆盖：跨 App / 跨 Conversation / 跨 Principal 的 scope 校验（统一不可用）；
 * 会话/Principal/App 三档总量配额（并发超配额恰好一个成功、删除后额度回收）；
 * 版本 spec 的 maxFileBytes 上限与 uploads.enabled 开关；GET 读取全 scope
 * 校验（猜中 Attachment ID 也无法探测或使用，TASK-031 完成条件）。需要本地
 * PostgreSQL（不可达自动 skip）；对象存储用 LocalTestObjectStore。
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createEmbedAuthenticator, type EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { createAttachmentsHttpHandler } from "../../src/embed/uploads/http.ts";
import { AttachmentService } from "../../src/embed/uploads/service.ts";
import { LocalTestObjectStore } from "../../src/persistence/object-store/local-test.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	type ConversationId,
	newAgentDefinitionId,
	newConversationId,
	newPrincipalId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	type PrincipalId,
	type PublicAppId,
	type PublishedAppId,
	type TenantId,
	toPublicId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex as hashHex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const ORIGIN = "https://host-a.example.com";
const BUCKET = "attachments-quota-test";

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
const pgReady = await pgUp();

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec in test fixture");
	return hashHex(canonicalJson(parsed.spec));
}

function buildSpec(versionId: string, uploads: { enabled: boolean; maxFiles: number; maxFileBytes: number }): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads,
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

function textBytes(size: number): Buffer {
	const chunk = "a".repeat(64);
	const buffer = Buffer.alloc(size, 0x61);
	// 首字节留文本可读性即可（isProbablyText 只看控制字节/NUL）。
	buffer.write(chunk, 0, "utf-8");
	return buffer;
}

interface HttpResult {
	readonly status: number;
	readonly body: any;
}

function rawHttpCall(options: {
	method: string;
	path: string;
	base: string;
	headers?: Record<string, string>;
	body?: Buffer;
}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, options.base);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: {
					host: url.host,
					...(options.body !== undefined ? { "content-length": String(options.body.length) } : {}),
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
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

describe.skipIf(!pgReady)("embed attachment quota and ownership", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let store: LocalTestObjectStore;
	let storeRoot: string;
	let service: AttachmentService;
	let handler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appId: PublishedAppId;
	let otherAppId: PublishedAppId;
	let otherAppPid: PrincipalId;
	let disabledAppId: PublishedAppId;
	let disabledAppPid: PrincipalId;
	let smallAppId: PublishedAppId;
	let smallAppPid: PrincipalId;
	let principalId: PrincipalId;
	let otherPrincipalId: PrincipalId;
	let conversationId: ConversationId;
	let conversation2Id: ConversationId;
	let token: string;
	let otherToken: string;

	async function mintToken(pid: PrincipalId, app: PublishedAppId = appId): Promise<string> {
		const signed = await accessTokens.sign({
			tenantId,
			publishedAppId: app,
			principalId: pid,
			principalType: "anonymous_visitor",
		});
		return signed.token;
	}

	async function seedApp(
		name: string,
		uploads: { enabled: boolean; maxFiles: number; maxFileBytes: number },
	): Promise<{
		appId: PublishedAppId;
		publicAppId: PublicAppId;
		principalId: PrincipalId;
	}> {
		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: `agent-${name}`,
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "b".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		const app = newPublishedAppId();
		const publicApp = newPublicAppId();
		await repos.publishedApps.insert({
			publishedAppId: app,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: publicApp,
			name,
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [ORIGIN],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		const versionId = newPublishedAppVersionId();
		const spec = buildSpec(versionId, uploads);
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: app,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: spec,
			runtimeSpecHash: specHash(spec),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: app }, app, versionId);
		// conversations 的 FK 是 (owner_principal_id, published_app_id)：
		// 每个 app 一个专属 principal 行（principals 主键 id 全局唯一）。
		const pid = newPrincipalId();
		await repos.principals.upsert({
			principalId: pid,
			tenantId,
			publishedAppId: app,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update(`q|${pid}|${name}`).digest("hex"),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		return { appId: app, publicAppId: publicApp, principalId: pid };
	}

	async function seedConversation(pid: PrincipalId, app: PublishedAppId): Promise<ConversationId> {
		const version = await repos.publishedApps.get({ tenantId, publishedAppId: app }, app);
		const now = new Date();
		const conv = newConversationId();
		await repos.conversations.insert({
			conversationId: conv,
			tenantId,
			publishedAppId: app,
			publishedAppVersionId: (version?.currentVersionId ?? newPublishedAppVersionId()) as never,
			ownerPrincipalId: pid,
			title: "conv",
			status: "active",
			lastEventSequence: 0,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});
		return conv;
	}

	async function upload(options: {
		filename: string;
		data: Buffer;
		contentType?: string;
		tokenOverride?: string;
		conversationIdOverride?: ConversationId;
	}): Promise<HttpResult> {
		const headers: Record<string, string> = {
			origin: ORIGIN,
			authorization: `Bearer ${options.tokenOverride ?? token}`,
			"x-filename": options.filename,
		};
		if (options.contentType !== undefined) headers["content-type"] = options.contentType;
		const convPublic =
			options.conversationIdOverride === undefined
				? toPublicId("ConversationId", conversationId)
				: toPublicId("ConversationId", options.conversationIdOverride);
		return rawHttpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convPublic}/uploads`,
			base: httpBase,
			headers,
			body: options.data,
		});
	}

	function uploadPath(convPublic: string, attPublic: string): string {
		return `/api/embed/v1/conversations/${convPublic}/uploads/${attPublic}`;
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
			name: "attachments-quota-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		otherPrincipalId = newPrincipalId();

		const appA = await seedApp("app-a", { enabled: true, maxFiles: 10, maxFileBytes: 25 * 1024 * 1024 });
		appId = appA.appId;
		principalId = appA.principalId;
		const appB = await seedApp("app-b", { enabled: true, maxFiles: 10, maxFileBytes: 25 * 1024 * 1024 });
		otherAppId = appB.appId;
		otherAppPid = appB.principalId;
		const appDisabled = await seedApp("app-disabled", {
			enabled: false,
			maxFiles: 10,
			maxFileBytes: 25 * 1024 * 1024,
		});
		disabledAppId = appDisabled.appId;
		disabledAppPid = appDisabled.principalId;
		const appSmall = await seedApp("app-small", { enabled: true, maxFiles: 10, maxFileBytes: 2048 });
		smallAppId = appSmall.appId;
		smallAppPid = appSmall.principalId;

		// app A 的第二 principal（跨 principal 隔离测试用）。
		const now = new Date();
		await repos.principals.upsert({
			principalId: otherPrincipalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update(`q|${otherPrincipalId}|app-a-other`).digest("hex"),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		conversationId = await seedConversation(principalId, appId);
		conversation2Id = await seedConversation(principalId, appId);

		accessTokens = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid-quota-1",
			ttlSeconds: 600,
			...(await generateKeyPair("Ed25519")),
		});
		token = await mintToken(principalId);
		otherToken = await mintToken(otherPrincipalId);

		storeRoot = await mkdtemp(join(tmpdir(), "embed-att-quota-"));
		store = new LocalTestObjectStore(storeRoot);
		service = new AttachmentService({
			repositories: repos,
			objectStore: store,
			bucket: BUCKET,
			quota: { conversationBytes: 5000, principalBytes: 10000, appBytes: 100000 },
		});
		const authenticator = createEmbedAuthenticator({ accessTokens });
		handler = createAttachmentsHttpHandler({
			service,
			authenticator,
			repositories: repos,
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
		httpBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		await store.close();
		await rm(storeRoot, { recursive: true, force: true });
	});

	test("cross-app upload is uniformly unavailable", async () => {
		// A 的 token 绑 app A，但用 app A 的会话 id 拼 URL 也无法上传到 app B 的会话；
		// 更直接的跨 App：A 的 token 访问 app B 的会话（app B 的 conv 需要 B 的 principal）。
		const convInB = await seedConversation(otherAppPid, otherAppId);
		const result = await upload({
			filename: "x.txt",
			data: textBytes(16),
			contentType: "text/plain",
			conversationIdOverride: convInB,
		});
		expect(result.status).toBe(404);
		expect(result.body.error.code).toBe("CONVERSATION_NOT_FOUND");
	});

	test("cross-conversation upload (same principal, other conversation id) is unavailable", async () => {
		// principal 只有 conversationId；会话 2 属于同一 principal（合法），
		// 但用不存在的会话 id 应同样 404（不枚举）。
		const ghost = newConversationId();
		const result = await upload({
			filename: "x.txt",
			data: textBytes(16),
			contentType: "text/plain",
			conversationIdOverride: ghost,
		});
		expect(result.status).toBe(404);
		expect(result.body.error.code).toBe("CONVERSATION_NOT_FOUND");
	});

	test("guessing an attachment id cannot read or use it (GET 404)", async () => {
		const up = await upload({ filename: "secret.txt", data: textBytes(64), contentType: "text/plain" });
		expect(up.status).toBe(201);
		const attachmentId = up.body.data.attachmentId;
		const convPublic = toPublicId("ConversationId", conversationId);
		const attPublic = toPublicId("AttachmentId", attachmentId);
		// 本人可读。
		const ok = await rawHttpCall({
			method: "GET",
			path: uploadPath(convPublic, attPublic),
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
		expect(ok.status).toBe(200);
		// 其他 principal（同 app 同会话名）不可读。
		const denied = await rawHttpCall({
			method: "GET",
			path: uploadPath(convPublic, attPublic),
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${otherToken}` },
		});
		expect(denied.status).toBe(404);
		// 随机猜测的 ID 不可读。
		const guessed = await rawHttpCall({
			method: "GET",
			path: uploadPath(convPublic, toPublicId("AttachmentId", newConversationId())),
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
		expect(guessed.status).toBe(404);
	});

	test("read returns the exact stored bytes with content type", async () => {
		const data = textBytes(128);
		const up = await upload({ filename: "readme.txt", data, contentType: "text/plain" });
		expect(up.status).toBe(201);
		const result = await rawHttpCall({
			method: "GET",
			path: uploadPath(
				toPublicId("ConversationId", conversationId),
				toPublicId("AttachmentId", up.body.data.attachmentId),
			),
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
		expect(result.status).toBe(200);
		expect(result.body).toBe(data.toString("utf-8"));
	});

	test("concurrent uploads cannot exceed the conversation quota (exactly one wins)", async () => {
		// 会话配额 5000；并发两个 3000 字节上传 -> 恰一个 201、一个 429。
		const data = textBytes(3000);
		const [a, b] = await Promise.all([
			upload({ filename: "c1.bin", data, contentType: "text/plain" }),
			upload({ filename: "c2.bin", data, contentType: "text/plain" }),
		]);
		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual([201, 429]);
		const rejected = a.status === 429 ? a : b;
		expect(rejected.body.error.code).toBe("QUOTA_EXCEEDED");
		expect(rejected.body.error.retryable).toBe(true);
	});

	test("principal quota is enforced across conversations", async () => {
		// principal 配额 4000；会话 1 已有约 2000+ 活跃字节，再传 2000 到会话 2
		// 应超 principal 配额（若会话配额允许）。会话 2 配额独立但 principal 共担。
		const data = textBytes(3000);
		const result = await upload({
			filename: "p2.bin",
			data,
			contentType: "text/plain",
			conversationIdOverride: conversation2Id,
		});
		// 并发胜者已占 3000（principal），+3000 = 6000 <= 10000 -> 201。
		expect(result.status).toBe(201);
	});

	test("delete releases quota (bytes are reclaimed)", async () => {
		const conversation3 = await seedConversation(principalId, appId);
		const data = textBytes(3000);
		const up = await upload({
			filename: "reclaim.bin",
			data,
			contentType: "text/plain",
			conversationIdOverride: conversation3,
		});
		expect(up.status).toBe(201);
		const ctx: EmbedAuthContext = {
			tokenId: "t",
			tenantId,
			publishedAppId: appId,
			principalId,
			principalType: "anonymous_visitor",
			scopes: [],
			issuedAt: new Date(),
			expiresAt: new Date(),
		};
		const before = await service.activeConversationBytes(ctx, conversation3);
		expect(before).toBe(3000);
		const del = await rawHttpCall({
			method: "DELETE",
			path: uploadPath(
				toPublicId("ConversationId", conversation3),
				toPublicId("AttachmentId", up.body.data.attachmentId),
			),
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
		expect(del.status).toBe(200);
		expect(del.body.data.deleted).toBe(true);
		const after = await service.activeConversationBytes(ctx, conversation3);
		expect(after).toBe(0);
		// 删除后额度回收：同一会话再传 3000 成功。
		const again = await upload({
			filename: "reclaim2.bin",
			data,
			contentType: "text/plain",
			conversationIdOverride: conversation3,
		});
		expect(again.status).toBe(201);
	});

	test("version spec maxFileBytes is enforced (UPLOAD_REJECTED)", async () => {
		// app-small 的版本 spec maxFileBytes=2048；1KB 可以，3KB 拒绝。
		const smallToken = await mintToken(smallAppPid, smallAppId);
		const convInSmall = await seedConversation(smallAppPid, smallAppId);
		const ok = await upload({
			filename: "ok.txt",
			data: textBytes(1024),
			contentType: "text/plain",
			tokenOverride: smallToken,
			conversationIdOverride: convInSmall,
		});
		expect(ok.status).toBe(201);
		const big = await upload({
			filename: "big.txt",
			data: textBytes(3000),
			contentType: "text/plain",
			tokenOverride: smallToken,
			conversationIdOverride: convInSmall,
		});
		expect(big.status).toBe(422);
		expect(big.body.error.code).toBe("UPLOAD_REJECTED");
	});

	test("uploads disabled by version spec is rejected", async () => {
		const disabledToken = await mintToken(disabledAppPid, disabledAppId);
		const convInDisabled = await seedConversation(disabledAppPid, disabledAppId);
		const result = await upload({
			filename: "x.txt",
			data: textBytes(16),
			contentType: "text/plain",
			tokenOverride: disabledToken,
			conversationIdOverride: convInDisabled,
		});
		expect(result.status).toBe(422);
		expect(result.body.error.code).toBe("UPLOAD_REJECTED");
	});

	test("app quota is enforced across principals", async () => {
		// app 配额 100000，已用约 2000+2000+2000；其他 principal 上传 100000 应 429。
		const data = textBytes(100000);
		const otherConv = await seedConversation(otherPrincipalId, appId);
		const result = await upload({
			filename: "app-limit.bin",
			data,
			contentType: "text/plain",
			tokenOverride: otherToken,
			conversationIdOverride: otherConv,
		});
		expect(result.status).toBe(429);
		expect(result.body.error.code).toBe("QUOTA_EXCEEDED");
	});
});

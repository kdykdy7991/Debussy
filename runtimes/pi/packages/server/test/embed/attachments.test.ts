/**
 * TASK-030: Embed Attachment Service 集成测试（spec 27.5 / 13.3 / 24.1）。
 *
 * 覆盖：上传成功（对象落库 + ready + 对象存储可读）；伪造 MIME / 扩展名不符 /
 * 超限（413）/ checksum 不符（422）；对象存储失败（503 + 记录补偿为
 * rejected + 无残留对象）；stat 校验失败（补偿删除对象 + rejected）；幂等
 * 删除（重复删除 200）；跨 Principal 越权（会话不可见 -> 统一不可用；
 * 删除幂等不泄露）；无对象存储时端点 503；sweepExpired 清理超龄 staged 与
 * 过期 ready。需要本地 PostgreSQL（不可达自动 skip）；对象存储用本地
 * filesystem 实现与注入失败的 fake。
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createEmbedAuthenticator } from "../../src/embed/middleware/authenticate.ts";
import { createAttachmentsHttpHandler } from "../../src/embed/uploads/http.ts";
import { scanUpload, sha256Hex } from "../../src/embed/uploads/scan.ts";
import { AttachmentService } from "../../src/embed/uploads/service.ts";
import { LocalTestObjectStore } from "../../src/persistence/object-store/local-test.ts";
import type {
	GetObjectParams,
	ObjectStore,
	PutObjectParams,
	RemoveObjectParams,
} from "../../src/persistence/object-store/types.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	type ConversationId,
	fromPublicId,
	newAgentDefinitionId,
	newAttachmentId,
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
const BUCKET = "attachments-test";
const MAX_FILE_BYTES = 25 * 1024;

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

function pngBytes(): Buffer {
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-payload")]);
}

/** ObjectStore 失败注入：putObject 抛错（对象存储故障路径）。 */
class FailingPutObjectStore implements ObjectStore {
	private readonly delegate: ObjectStore;
	constructor(delegate: ObjectStore) {
		this.delegate = delegate;
	}
	async putObject(_params: PutObjectParams): Promise<void> {
		throw new Error("s3 simulated outage");
	}
	async getObject(params: GetObjectParams): Promise<Buffer> {
		return this.delegate.getObject(params);
	}
	async removeObject(params: RemoveObjectParams): Promise<void> {
		return this.delegate.removeObject(params);
	}
	async statObject(
		params: Parameters<ObjectStore["statObject"]>[0],
	): Promise<Awaited<ReturnType<ObjectStore["statObject"]>>> {
		return this.delegate.statObject(params);
	}
	async close(): Promise<void> {
		return this.delegate.close();
	}
}

/** statObject 返回错误字节数（校验失败路径）。 */
class CorruptStatObjectStore implements ObjectStore {
	private readonly delegate: ObjectStore;
	constructor(delegate: ObjectStore) {
		this.delegate = delegate;
	}
	async putObject(params: PutObjectParams): Promise<void> {
		return this.delegate.putObject(params);
	}
	async getObject(params: GetObjectParams): Promise<Buffer> {
		return this.delegate.getObject(params);
	}
	async removeObject(params: RemoveObjectParams): Promise<void> {
		return this.delegate.removeObject(params);
	}
	async statObject(
		_params: Parameters<ObjectStore["statObject"]>[0],
	): Promise<Awaited<ReturnType<ObjectStore["statObject"]>>> {
		return { size: 1 };
	}
	async close(): Promise<void> {
		return this.delegate.close();
	}
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

describe.skipIf(!pgReady)("embed attachment service", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let storeRoot: string;
	let store: LocalTestObjectStore;
	let service: AttachmentService;
	let failingStore: FailingPutObjectStore;
	let failingService: AttachmentService;
	let corruptStore: CorruptStatObjectStore;
	let corruptService: AttachmentService;
	let handler: HttpRequestHandler;
	let noStoreHandler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appId: PublishedAppId;
	let publicAppId: PublicAppId;
	let principalId: PrincipalId;
	let otherPrincipalId: PrincipalId;
	let conversationId: ConversationId;
	let token: string;
	let otherToken: string;

	async function mintToken(pid: PrincipalId): Promise<string> {
		const signed = await accessTokens.sign({
			tenantId,
			publishedAppId: appId,
			principalId: pid,
			principalType: "anonymous_visitor",
		});
		return signed.token;
	}

	async function upload(options: {
		filename: string;
		data: Buffer;
		contentType?: string;
		checksum?: string;
		tokenOverride?: string;
		conversationOverride?: string;
		idempotencyKey?: string;
	}): Promise<HttpResult> {
		const headers: Record<string, string> = {
			origin: ORIGIN,
			authorization: `Bearer ${options.tokenOverride ?? token}`,
			"x-filename": options.filename,
		};
		if (options.contentType !== undefined) headers["content-type"] = options.contentType;
		if (options.checksum !== undefined) headers["x-checksum-sha256"] = options.checksum;
		if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
		const conversationPublicId = options.conversationOverride ?? toPublicId("ConversationId", conversationId);
		return rawHttpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${conversationPublicId}/uploads`,
			base: httpBase,
			headers,
			body: options.data,
		});
	}

	function conversationPublicPath(conversationPublic: string, attachmentPublic: string): string {
		return `/api/embed/v1/conversations/${conversationPublic}/uploads/${attachmentPublic}`;
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
			name: "attachments-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "attachments-agent",
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		appId = newPublishedAppId();
		publicAppId = newPublicAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId,
			name: "Attachments App",
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [ORIGIN],
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
		principalId = newPrincipalId();
		otherPrincipalId = newPrincipalId();
		const subject = (pid: PrincipalId): string => createHash("sha256").update(`visitor|${pid}`).digest("hex");
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: subject(principalId),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		await repos.principals.upsert({
			principalId: otherPrincipalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: subject(otherPrincipalId),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		conversationId = newConversationId();
		await repos.conversations.insert({
			conversationId,
			tenantId,
			publishedAppId: appId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: principalId,
			title: "conv-1",
			status: "active",
			lastEventSequence: 0,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});

		accessTokens = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid-test-1",
			ttlSeconds: 600,
			...(await generateKeyPair("Ed25519")),
		});
		token = await mintToken(principalId);
		otherToken = await mintToken(otherPrincipalId);

		storeRoot = await mkdtemp(join(tmpdir(), "embed-att-"));
		store = new LocalTestObjectStore(storeRoot);
		service = new AttachmentService({
			repositories: repos,
			objectStore: store,
			bucket: BUCKET,
			maxFileBytes: MAX_FILE_BYTES,
			stagedTtlMs: 60_000,
		});
		failingStore = new FailingPutObjectStore(store);
		failingService = new AttachmentService({
			repositories: repos,
			objectStore: failingStore,
			bucket: BUCKET,
			maxFileBytes: MAX_FILE_BYTES,
		});
		corruptStore = new CorruptStatObjectStore(store);
		corruptService = new AttachmentService({
			repositories: repos,
			objectStore: corruptStore,
			bucket: BUCKET,
			maxFileBytes: MAX_FILE_BYTES,
		});
		const authenticator = createEmbedAuthenticator({ accessTokens });
		const options = {
			repositories: repos,
			authenticator,
		};
		handler = createAttachmentsHttpHandler({
			...options,
			service,
			maxFileBytes: MAX_FILE_BYTES,
		});
		noStoreHandler = createAttachmentsHttpHandler({
			...options,
			service: undefined,
			maxFileBytes: MAX_FILE_BYTES,
		});
		const dispatch = (h: HttpRequestHandler): HttpRequestHandler => {
			return async (req, res) => {
				const handled = await h(req, res);
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
				return true;
			};
		};
		server = createServer((req, res) => {
			void dispatch(handler)(req, res);
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

	async function objectKeysInStore(): Promise<string[]> {
		// LocalTestObjectStore 结构：<root>/<bucket>/<objectKey>
		const { readdir, stat } = await import("node:fs/promises");
		const bucketDir = join(storeRoot, BUCKET);
		const out: string[] = [];
		const walk = async (dir: string, prefix: string): Promise<void> => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`);
				else if (entry.isFile() && (await stat(full)).isFile()) out.push(`${prefix}${entry.name}`);
			}
		};
		await walk(bucketDir, "");
		return out;
	}

	test("upload succeeds: 201 ready, object stored, DB row ready", async () => {
		const data = pngBytes();
		const checksum = sha256Hex(data);
		const result = await upload({
			filename: "photo.png",
			data,
			contentType: "image/png",
			checksum,
		});
		expect(result.status).toBe(201);
		expect(result.body.data.status).toBe("ready");
		expect(result.body.data.contentType).toBe("image/png");
		expect(result.body.data.sizeBytes).toBe(data.length);
		expect(result.body.data.checksumSha256).toBe(checksum);
		expect(result.body.data.objectKey).toBeUndefined(); // objectKey 不外泄
		// 对象存储中正好一个对象，内容一致。
		const keys = await objectKeysInStore();
		expect(keys).toHaveLength(1);
		const stored = await store.getObject({ bucket: BUCKET, objectKey: keys[0]! });
		expect(stored.equals(data)).toBe(true);
		// DB 行 ready（响应是公开 att_ id，库内是裸 UUID）。
		const rows = await client.run(
			`select status, filename from attachments where id = $1`,
			fromPublicId("AttachmentId", result.body.data.attachmentId),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("ready");
		expect(rows[0]!.filename).toBe("photo.png");
	});

	test("rejects forged MIME (422) and leaves no object", async () => {
		const result = await upload({ filename: "photo.png", data: Buffer.from("plain text"), contentType: "image/png" });
		expect(result.status).toBe(422);
		expect(result.body.error.code).toBe("UPLOAD_REJECTED");
		expect(await objectKeysInStore()).toHaveLength(1); // 仅上一个成功上传的对象
	});

	test("rejects checksum mismatch (422)", async () => {
		const result = await upload({
			filename: "a.txt",
			data: Buffer.from("hi"),
			contentType: "text/plain",
			checksum: "0".repeat(64),
		});
		expect(result.status).toBe(422);
		expect(result.body.error.code).toBe("UPLOAD_REJECTED");
	});

	test("rejects oversized upload (413)", async () => {
		const result = await upload({
			filename: "big.txt",
			data: Buffer.alloc(MAX_FILE_BYTES + 1, 0x41),
			contentType: "text/plain",
		});
		expect(result.status).toBe(413);
		expect(result.body.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("rejects missing x-filename (400)", async () => {
		const result = await rawHttpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${toPublicId("ConversationId", conversationId)}/uploads`,
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}`, "content-type": "text/plain" },
			body: Buffer.from("hi"),
		});
		expect(result.status).toBe(400);
	});

	test("object store outage: 503-equivalent error and record compensated to rejected with no object", async () => {
		const prior = await objectKeysInStore();
		const data = pngBytes();
		const failed = await failingService.upload({
			principal: {
				tokenId: "t",
				tenantId,
				publishedAppId: appId,
				principalId,
				principalType: "anonymous_visitor",
				scopes: [],
				issuedAt: new Date(),
				expiresAt: new Date(),
			},
			conversationId,
			filename: "outage.png",
			declaredContentType: "image/png",
			declaredChecksumSha256: undefined,
			data,
		});
		expect(failed.ok).toBe(false);
		if (!failed.ok) {
			expect(failed.error.code).toBe("RUNTIME_UNAVAILABLE");
			expect(failed.error.httpStatus).toBe(503);
		}
		// DB 记录应为 rejected（staged 补偿，不悬空）。
		const rows = await client.run(`select status from attachments where filename = 'outage.png'`);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]!.status).toBe("rejected");
		// 对象存储无新增对象。
		const after = await objectKeysInStore();
		expect(after.length).toBe(prior.length);
	});

	test("stat verification failure: object removed and record rejected", async () => {
		const data = pngBytes();
		const failed = await corruptService.upload({
			principal: {
				tokenId: "t",
				tenantId,
				publishedAppId: appId,
				principalId,
				principalType: "anonymous_visitor",
				scopes: [],
				issuedAt: new Date(),
				expiresAt: new Date(),
			},
			conversationId,
			filename: "corrupt.png",
			declaredContentType: "image/png",
			declaredChecksumSha256: undefined,
			data,
		});
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.code).toBe("UPLOAD_REJECTED");
		const rows = await client.run(`select status from attachments where filename = 'corrupt.png'`);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]!.status).toBe("rejected");
		// 补偿已删除对象。
		const keys = await objectKeysInStore();
		expect(keys.some((key) => key.includes("corrupt"))).toBe(false);
	});

	test("cross-principal: other principal cannot upload into A's conversation (uniform unavailable)", async () => {
		const result = await upload({
			filename: "x.txt",
			data: Buffer.from("hi"),
			contentType: "text/plain",
			tokenOverride: otherToken,
		});
		expect(result.status).toBe(404);
		expect(result.body.error.code).toBe("CONVERSATION_NOT_FOUND");
	});

	test("idempotent delete: repeated DELETE both succeed", async () => {
		const data = pngBytes();
		const up = await upload({ filename: "delete-me.png", data, contentType: "image/png", checksum: sha256Hex(data) });
		expect(up.status).toBe(201);
		// TASK-033：上传响应直接返回公开 att_/conv_ id，可回填路径。
		const attachmentId = up.body.data.attachmentId;
		expect(attachmentId).toMatch(/^att_/);
		const path = conversationPublicPath(up.body.data.conversationId, attachmentId);
		const first = await rawHttpCall({
			method: "DELETE",
			path,
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
		const second = await rawHttpCall({
			method: "DELETE",
			path,
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
		expect(first.status).toBe(200);
		expect(first.body.data.deleted).toBe(true);
		expect(second.status).toBe(200);
		expect(second.body.data.deleted).toBe(false);
		// 对象已从存储移除（objectKey 内是裸 UUID）。
		const keys = await objectKeysInStore();
		expect(keys.some((key) => key.includes(fromPublicId("AttachmentId", attachmentId) ?? ""))).toBe(false);
	});

	test("cross-principal delete is idempotent (no enumeration leak)", async () => {
		const data = pngBytes();
		const up = await upload({
			filename: "other-delete.png",
			data,
			contentType: "image/png",
			checksum: sha256Hex(data),
		});
		expect(up.status).toBe(201);
		const result = await rawHttpCall({
			method: "DELETE",
			path: conversationPublicPath(up.body.data.conversationId, up.body.data.attachmentId),
			base: httpBase,
			headers: { origin: ORIGIN, authorization: `Bearer ${otherToken}` },
		});
		expect(result.status).toBe(200);
		expect(result.body.data.deleted).toBe(false);
	});

	test("idempotency key replays the same upload response", async () => {
		const data = pngBytes();
		const key = `up-${Date.now()}`;
		const first = await upload({
			filename: "idem.png",
			data,
			contentType: "image/png",
			checksum: sha256Hex(data),
			idempotencyKey: key,
		});
		const second = await upload({
			filename: "idem.png",
			data,
			contentType: "image/png",
			checksum: sha256Hex(data),
			idempotencyKey: key,
		});
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(second.body.data.attachmentId).toBe(first.body.data.attachmentId);
	});

	test("sweepExpired removes aged staged rows and their objects", async () => {
		const data = pngBytes();
		const old = new Date(Date.now() - 2 * 60 * 1000);
		const result = scanUpload({ data, filename: "stale.png", declaredContentType: "image/png" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// 直接插入一个超龄 staged 记录（模拟中断上传）。
		const attachmentId = newAttachmentId();
		const objectKey = `attachments/${tenantId}/${appId}/${attachmentId}`;
		await store.putObject({ bucket: BUCKET, objectKey, data, contentType: "image/png" });
		await repos.attachments.insert({
			attachmentId,
			tenantId,
			publishedAppId: appId,
			conversationId,
			ownerPrincipalId: principalId,
			objectKey,
			filename: "stale.png",
			contentType: "image/png",
			sizeBytes: data.length,
			checksumSha256: result.checksumSha256,
			status: "staged",
			expiresAt: null,
			createdAt: old,
		});
		const swept = await service.sweepExpired(100);
		expect(swept).toBeGreaterThanOrEqual(1);
		expect(await service.objectExists(objectKey)).toBe(false);
		const rows = await client.run(`select status from attachments where id = $1`, attachmentId);
		expect(rows[0]!.status).toBe("deleted");
	});

	test("no object store: uploads endpoint returns 503", async () => {
		// 独立 handler（无 service）：上传路径返回 503。
		const noStoreServer = createServer((req, res) => {
			const handled = noStoreHandler(req, res);
			Promise.resolve(handled).then((done) => {
				if (!done) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => noStoreServer.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(noStoreServer.address() as { port: number }).port}`;
		const convPublic = toPublicId("ConversationId", conversationId);
		try {
			const result = await rawHttpCall({
				method: "POST",
				path: `/api/embed/v1/conversations/${convPublic}/uploads`,
				base,
				headers: {
					origin: ORIGIN,
					authorization: `Bearer ${token}`,
					"x-filename": "x.txt",
					"content-type": "text/plain",
				},
				body: Buffer.from("hi"),
			});
			expect(result.status).toBe(503);
			expect(result.body.error.code).toBe("RUNTIME_UNAVAILABLE");
		} finally {
			await new Promise<void>((resolve) => noStoreServer.close(() => resolve()));
		}
	});

	test("unauthenticated upload is 401", async () => {
		const result = await rawHttpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${toPublicId("ConversationId", conversationId)}/uploads`,
			base: httpBase,
			headers: { origin: ORIGIN, "x-filename": "x.txt", "content-type": "text/plain" },
			body: Buffer.from("hi"),
		});
		expect(result.status).toBe(401);
	});
});

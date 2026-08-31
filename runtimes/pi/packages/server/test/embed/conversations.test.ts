/**
 * TASK-016: Conversation Service/API 集成测试（spec 27.5 / 8.2）。
 *
 * 覆盖：创建（服务端固定版本）、客户端无法指定版本/owner、A/B 用户隔离、
 * 跨 App 隔离、新版本发布后新旧会话语义、App 停用拒绝新建、无版本拒绝、
 * cursor 分页列表、归档、401（缺失/无效/过期 token）、增量事件恢复、幂等
 * 创建。需要本地测试数据库（不可达时自动 skip）。
 */

import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createConversationsHttpHandler } from "../../src/embed/conversations/http.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createEmbedAuthenticator } from "../../src/embed/middleware/authenticate.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	type ConversationId,
	newAgentDefinitionId,
	newPrincipalId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	type PrincipalId,
	type PublishedAppId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

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
					...(payload !== undefined
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
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: false },
			avatar: { enabled: false },
		},
		contextPolicy: { maxTurns: 100, maxContextTokens: 100000, toolResultMaxBytes: 65536 },
		runtimePolicy: {
			profile: "chat-only",
			turnTimeoutMs: 120000,
			idleTtlMs: 1200000,
			maxConcurrentTurnsPerConversation: 1,
		},
		theme: {},
		securityPolicyVersion: "sp_001",
	};
}

describe.skipIf(!pgUp)("embed conversation api", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let handler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appAId: PublishedAppId;
	let appBId: PublishedAppId;
	let appAV1Id: string;
	let tokenKeys: Awaited<ReturnType<typeof generateKeyPair>>;

	async function createApp(
		name: string,
		options: { withVersion?: boolean; status?: "active" | "draft" | "suspended" } = {},
	): Promise<{
		appId: PublishedAppId;
		publicAppId: string;
		versionId: string | null;
	}> {
		const now = new Date();
		const agentId = newAgentDefinitionId();
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
		const appId = newPublishedAppId();
		const publicAppId = newPublicAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId,
			name,
			status: options.status ?? "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		if (options.withVersion === false) return { appId, publicAppId, versionId: null };
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
		return { appId, publicAppId, versionId };
	}

	/** 发布并激活新版本（版本号递增）。 */
	async function publishAndActivateNextVersion(appId: PublishedAppId): Promise<string> {
		const app = await repos.publishedApps.get({ tenantId, publishedAppId: appId }, appId);
		const versionNumber =
			app === undefined
				? 1
				: await repos.publishedAppVersions.nextVersionNumber({ tenantId, publishedAppId: appId }, appId);
		const versionId = newPublishedAppVersionId();
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appId,
			versionNumber,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi v2" },
			runtimeSpec: buildSpec(versionId),
			runtimeSpecHash: specHash(buildSpec(versionId)),
			status: "ready",
			validationErrors: [],
			createdAt: new Date(),
		});
		await repos.publishedApps.transitionVersion({ tenantId, publishedAppId: appId }, appId, versionId, {
			activate: true,
		});
		return versionId;
	}

	async function tokenFor(
		appId: PublishedAppId,
		principalId = newPrincipalId(),
	): Promise<{ token: string; principalId: PrincipalId }> {
		// 真实流程中 Exchange 会先 upsert Principal；这里模拟该前置状态，
		// 否则 conversations 的复合外键 (owner, app) 会拒绝插入。
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update(`test:${principalId}`).digest("hex"),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		const signed = await accessTokens.sign({
			tenantId,
			publishedAppId: appId,
			principalId,
			principalType: "anonymous_visitor",
			scopes: [],
			publishedAppVersionId: null,
		});
		return { token: signed.token, principalId };
	}

	/** 用与 authenticator 相同的密钥签发一个已过期（exp 在过去）的 token。 */
	async function expiredTokenFor(appId: PublishedAppId): Promise<string> {
		const expiredSigner = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid-test-1",
			...tokenKeys,
			ttlSeconds: -10,
		});
		const signed = await expiredSigner.sign({
			tenantId,
			publishedAppId: appId,
			principalId: newPrincipalId(),
			principalType: "anonymous_visitor",
			scopes: [],
			publishedAppVersionId: null,
		});
		return signed.token;
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
			name: "conv-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		tokenKeys = await generateKeyPair("Ed25519");
		accessTokens = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid-test-1",
			ttlSeconds: 600,
			...tokenKeys,
		});
		const authenticator = createEmbedAuthenticator({ accessTokens });
		const service = new ConversationService({
			repositories: repos,
			turnExecutor: async () => ({ ok: true, outputText: "" }),
		});
		handler = createConversationsHttpHandler({
			service,
			authenticator,
			repositories: repos,
			onError: (error) => console.error("CONVERSATION HANDLER ERROR:", error),
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

		const appA = await createApp("App A");
		appAId = appA.appId;
		appAV1Id = appA.versionId!;
		const appB = await createApp("App B");
		appBId = appB.appId;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("creates a conversation pinned to the current version (201)", async () => {
		const { token } = await tokenFor(appAId);
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { title: "合同审查" },
		});
		expect(res.status).toBe(201);
		expect(res.body.data.id).toMatch(/^conv_/);
		expect(res.body.data.publishedAppVersionId).toBe(`pav_${appAV1Id}`);
		expect(res.body.data.status).toBe("active");
		expect(res.body.data.lastEventSequence).toBe(0);
		expect(Date.parse(res.body.data.createdAt)).toBeGreaterThan(0);
		expect(res.body.requestId).toBeTruthy();
		expect(res.headers["x-request-id"]).toBe(res.body.requestId);
	});

	test("preview principal can create a conversation for a ready version while app is draft", async () => {
		const draft = await createApp("Draft Preview", { status: "draft" });
		if (draft.versionId === null) throw new Error("draft preview fixture requires a ready version");
		const principalId = newPrincipalId();
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: draft.appId,
			principalType: "platform_admin_preview",
			subjectHash: createHash("sha256").update(`preview:${principalId}`).digest("hex"),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		const signed = await accessTokens.sign({
			tenantId,
			publishedAppId: draft.appId,
			principalId,
			principalType: "platform_admin_preview",
			scopes: [],
			publishedAppVersionId: draft.versionId,
		});
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${signed.token}` },
			body: { title: "draft preview" },
		});
		expect(res.status).toBe(201);
		expect(res.body.data.publishedAppVersionId).toBe(`pav_${draft.versionId}`);
	});

	test("client cannot pin a version or owner: ignored fields fall back to server state", async () => {
		const { token, principalId } = await tokenFor(appAId);
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: {
				publishedAppVersionId: "pav_00000000-0000-7000-8000-000000000000",
				ownerPrincipalId: "prn_00000000-0000-7000-8000-000000000000",
			},
		});
		expect(res.status).toBe(201);
		expect(res.body.data.publishedAppVersionId).toBe(`pav_${appAV1Id}`);
		// owner 必须是 token 的 principal（库内验证，防止客户端指定）。
		const rows = await client.run(
			"select owner_principal_id from conversations where id = $1",
			res.body.data.id.slice(5),
		);
		expect(String(rows[0].owner_principal_id)).toBe(principalId);
	});

	test("user B cannot read or archive user A's conversation (404)", async () => {
		const { token: tokenA } = await tokenFor(appAId);
		const created = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA}` },
		});
		const convId = created.body.data.id as string;
		const { token: tokenB } = await tokenFor(appAId);
		const read = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convId}`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenB}` },
		});
		expect(read.status).toBe(404);
		expect(read.body.error.code).toBe("CONVERSATION_NOT_FOUND");
		const archive = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/archive`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenB}` },
		});
		expect(archive.status).toBe(404);
	});

	test("an app-B token cannot access app-A conversations (cross-app isolation)", async () => {
		const { token: tokenA } = await tokenFor(appAId);
		const created = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA}` },
		});
		const convId = created.body.data.id as string;
		const { token: tokenB } = await tokenFor(appBId);
		const res = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convId}`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenB}` },
		});
		expect(res.status).toBe(404);
	});

	test("old conversations keep their version after a new version is published", async () => {
		const { token } = await tokenFor(appAId);
		const before = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { title: "before-v2" },
		});
		const oldConv = before.body.data.id as string;
		expect(before.body.data.publishedAppVersionId).toBe(`pav_${appAV1Id}`);

		const v2 = await publishAndActivateNextVersion(appAId);
		expect(v2).not.toBe(appAV1Id);

		const after = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { title: "after-v2" },
		});
		expect(after.body.data.publishedAppVersionId).toBe(`pav_${v2}`);

		const oldRead = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${oldConv}`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(oldRead.body.data.conversation.publishedAppVersionId).toBe(`pav_${appAV1Id}`);
	});

	test("P2 resume rolls an old-version conversation forward to the CURRENT version and preserves the old one", async () => {
		const { token } = await tokenFor(appAId);
		const created = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { title: "resume-anchor" },
		});
		expect(created.status).toBe(201);
		const oldConv = created.body.data.id as string;
		expect(created.body.data.publishedAppVersionId).toBe(`pav_${appAV1Id}`);

		// Republish → appAV1 is no longer the CURRENT version.
		const v2 = await publishAndActivateNextVersion(appAId);
		expect(v2).not.toBe(appAV1Id);

		// Resume the stale conversation: must roll forward to a NEW conversation
		// on the current version, NOT return the stale one.
		const resumed = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${oldConv}/resume`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(resumed.status).toBe(200);
		expect(resumed.body.data.resumed).toBe(false);
		expect(resumed.body.data.previousConversationId).toBe(oldConv);
		const newConv = resumed.body.data.conversation.id as string;
		expect(newConv).not.toBe(oldConv);
		expect(resumed.body.data.conversation.publishedAppVersionId).toBe(`pav_${v2}`);

		// The old conversation is preserved and not deleted; it still pins v1.
		const oldRead = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${oldConv}`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(oldRead.status).toBe(200);
		expect(oldRead.body.data.conversation.publishedAppVersionId).toBe(`pav_${appAV1Id}`);
		expect(oldRead.body.data.conversation.status).toBe("active");

		// The roll-forward conversation is on the CURRENT version: resuming it
		// again returns it unchanged (resumed: true, not a new conversation).
		const resumedAgain = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${newConv}/resume`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(resumedAgain.status).toBe(200);
		expect(resumedAgain.body.data.resumed).toBe(true);
		expect(resumedAgain.body.data.conversation.id).toBe(newConv);
		expect(resumedAgain.body.data.previousConversationId).toBeNull();
	});

	test("suspended app rejects new conversations (403 APP_SUSPENDED)", async () => {
		const suspended = await createApp("Suspended");
		await repos.publishedApps.updateMutable({ tenantId, publishedAppId: suspended.appId }, suspended.appId, {
			status: "suspended",
		});
		const { token } = await tokenFor(suspended.appId);
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("APP_SUSPENDED");
	});

	test("an active app without a current version rejects creation (409 VERSION_UNAVAILABLE)", async () => {
		const noVersion = await createApp("No Version", { withVersion: false });
		const { token } = await tokenFor(noVersion.appId);
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("VERSION_UNAVAILABLE");
	});

	test("lists own conversations with cursor pagination, active only", async () => {
		const { token, principalId } = await tokenFor(appAId);
		const ids: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			const res = await httpCall({
				method: "POST",
				path: "/api/embed/v1/conversations",
				base: httpBase,
				headers: { authorization: `Bearer ${token}` },
				body: { title: `page-${i}` },
			});
			ids.push(res.body.data.id as string);
		}
		const page1 = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations?limit=2",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(page1.status).toBe(200);
		expect(page1.body.data.items).toHaveLength(2);
		expect(page1.body.data.nextCursor).toBeTruthy();
		const page2 = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations?limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(page2.status).toBe(200);
		expect(page2.body.data.items).toHaveLength(1);
		expect(page2.body.data.nextCursor).toBeNull();

		// 归档后从列表消失。
		const last = ids[ids.length - 1]!;
		await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${last}/archive`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		const afterArchive = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations?limit=100",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		const listed = afterArchive.body.data.items.map((item: { id: string }) => item.id);
		expect(listed).not.toContain(last);
		// 归档不影响他人视角的隔离（principal 自身仍可 GET 已归档会话）。
		const archivedRead = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${last}`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(archivedRead.status).toBe(200);
		expect(archivedRead.body.data.conversation.status).toBe("archived");
		// 另一个 principal 看不到这批会话。
		const { token: otherToken } = await tokenFor(appAId);
		const other = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations?limit=100",
			base: httpBase,
			headers: { authorization: `Bearer ${otherToken}` },
		});
		expect(other.body.data.items).toHaveLength(0);
		expect(other.body.data.items.some((item: { id: string }) => item.id === last)).toBe(false);
		// 消除未使用告警：principalId 仅用于语义自检。
		expect(principalId).toBeTruthy();
	});

	test("restores events incrementally via afterSequence", async () => {
		const { token, principalId } = await tokenFor(appAId);
		const created = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		const convId = created.body.data.id as string;
		const scope = { tenantId, publishedAppId: appAId, principalId };
		const conversationId = convId.slice(5) as ConversationId;
		await repos.events.append(scope, { conversationId, eventType: "user.message", payload: { text: "hi" } });
		await repos.events.append(scope, {
			conversationId,
			eventType: "assistant.completed",
			payload: { text: "hello" },
		});

		const full = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convId}`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(full.status).toBe(200);
		expect(full.body.data.conversation.id).toBe(convId);
		expect(full.body.data.events).toHaveLength(2);
		expect(full.body.data.events[0].sequence).toBe(1);
		expect(full.body.data.events[1].sequence).toBe(2);

		const delta = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convId}?afterSequence=1`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(delta.body.data.events).toHaveLength(1);
		expect(delta.body.data.events[0].sequence).toBe(2);
	});

	test("authentication: missing, invalid and expired tokens are 401", async () => {
		const missing = await httpCall({ method: "GET", path: "/api/embed/v1/conversations", base: httpBase });
		expect(missing.status).toBe(401);
		expect(missing.body.error.code).toBe("TOKEN_INVALID");

		const invalid = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: "Bearer not-a-jwt" },
		});
		expect(invalid.status).toBe(401);
		expect(invalid.body.error.code).toBe("TOKEN_INVALID");

		const expired = await expiredTokenFor(appAId);
		const expiredRes = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${expired}` },
		});
		expect(expiredRes.status).toBe(401);
		expect(expiredRes.body.error.code).toBe("TOKEN_EXPIRED");
	});

	test("creating a conversation is idempotent per Idempotency-Key", async () => {
		const { token } = await tokenFor(appAId);
		const first = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}`, "idempotency-key": "conv-idem-1" },
			body: { title: "idem" },
		});
		const second = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}`, "idempotency-key": "conv-idem-1" },
			body: { title: "idem" },
		});
		expect(first.status).toBe(201);
		expect(second.status).toBe(first.status);
		expect(second.body).toEqual(first.body);
		const conflict = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}`, "idempotency-key": "conv-idem-1" },
			body: { title: "different" },
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
	});

	test("bad request shapes are rejected with 400 and unclaimed routes fall through", async () => {
		const { token } = await tokenFor(appAId);
		const badLimit = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations?limit=abc",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(badLimit.status).toBe(400);
		const badId = await httpCall({
			method: "GET",
			path: "/api/embed/v1/conversations/not-an-id",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(badId.status).toBe(400);
		const unclaimed = await httpCall({ method: "GET", path: "/api/embed/v1/health", base: httpBase });
		expect(unclaimed.status).toBe(404);
	});
});

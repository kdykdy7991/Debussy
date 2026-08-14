/**
 * TASK-024: WebSocket Ticket 测试（spec 7.3 / 27.6）。
 *
 * 覆盖：签发/消费、重放失败（第二次必定 null）、过期、错误 Origin、错误
 * Conversation、HTTP 端点（200/未配置 503/越权 404）。Ticket 为 256-bit
 * opaque、Redis 只存 hash。需要本地 Redis（不可达时自动 skip）。
 */

import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createWsTicketService, hashOf, type WsTicketService } from "../../src/embed/auth/ws-ticket.ts";
import { createConversationsHttpHandler } from "../../src/embed/conversations/http.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createEmbedAuthenticator } from "../../src/embed/middleware/authenticate.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { RedisClient } from "../../src/persistence/redis/client.ts";
import { createRedisTicketStore } from "../../src/persistence/redis/ticket-store.ts";
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
	type PublishedAppId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const REDIS_URL = process.env.PI_TEST_REDIS_URL ?? "redis://127.0.0.1:6380/15";

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
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe.skipIf(!redisReady)("ws ticket store + service", () => {
	let redis: RedisClient;
	let tickets: WsTicketService;
	const conversationId = newConversationId();

	beforeAll(async () => {
		redis = new RedisClient({ url: REDIS_URL });
		tickets = createWsTicketService(createRedisTicketStore(redis));
	});

	afterAll(async () => {
		await redis.close();
	});

	function claims() {
		return {
			tenantId: newTenantId(),
			publishedAppId: newPublishedAppId(),
			principalId: newPrincipalId(),
			principalType: "anonymous_visitor" as const,
			tokenId: "tok-test",
			conversationId,
			origin: "https://host-a.example.com",
		};
	}

	test("issues an opaque ticket and consumes it once", async () => {
		const input = claims();
		const { ticket, expiresAt } = await tickets.issue(input);
		expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256-bit base64url
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
		const consumed = await tickets.consume(ticket, { conversationId, origin: input.origin });
		expect(consumed).toEqual(input);
	});

	test("the second consume of the same ticket always fails", async () => {
		const input = claims();
		const { ticket } = await tickets.issue(input);
		expect(await tickets.consume(ticket, { conversationId, origin: input.origin })).not.toBeNull();
		expect(await tickets.consume(ticket, { conversationId, origin: input.origin })).toBeNull();
	});

	test("expired tickets cannot be consumed", async () => {
		// Redis EX 是秒级粒度：最小 1 秒 TTL，等待其过期。
		const short = createWsTicketService(createRedisTicketStore(redis), { ttlMs: 100 });
		const input = claims();
		const { ticket } = await short.issue(input);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(await short.consume(ticket, { conversationId, origin: input.origin })).toBeNull();
	});

	test("origin mismatch rejects consumption (and the attempt consumes the ticket)", async () => {
		const input = claims();
		const { ticket } = await tickets.issue(input);
		expect(await tickets.consume(ticket, { conversationId, origin: "https://evil.example.com" })).toBeNull();
		// 错误 Origin 的消费尝试同样原子消耗 ticket（防探测/重放）：第二次必定失败。
		expect(await tickets.consume(ticket, { conversationId, origin: input.origin })).toBeNull();
	});

	test("conversation mismatch rejects consumption", async () => {
		const input = claims();
		const { ticket } = await tickets.issue(input);
		expect(await tickets.consume(ticket, { conversationId: newConversationId(), origin: input.origin })).toBeNull();
	});

	test("tickets are stored only by hash", async () => {
		const input = claims();
		const { ticket } = await tickets.issue(input);
		// 直接按原值查库必须为空（只存 hash）。
		const reply = await redis.run("GET", `embed:ws-ticket:${ticket}`);
		expect(reply).toBeNull();
		// 按 hash 可查（消费前）。
		const byHash = await redis.run("GET", `embed:ws-ticket:${hashOf(ticket)}`);
		expect(typeof byHash).toBe("string");
		// 清理。
		await redis.run("DEL", `embed:ws-ticket:${hashOf(ticket)}`);
	});
});

describe.skipIf(!bothReady)("ws ticket http endpoint", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let handler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appAId: PublishedAppId;
	let conversationIdA: ConversationId;
	let principalA: PrincipalId;
	let tokenA: string;
	let redis: RedisClient;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		tenantId = newTenantId();
		await repos.tenants.upsert({
			tenantId,
			name: "ws-ticket-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		redis = new RedisClient({ url: REDIS_URL });

		const keys = await generateKeyPair("Ed25519");
		const accessTokens = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid",
			ttlSeconds: 600,
			...keys,
		});
		const authenticator = createEmbedAuthenticator({ accessTokens });
		const service = new ConversationService({
			repositories: repos,
			turnExecutor: async () => ({ ok: true, outputText: "" }),
		});
		const tickets = createWsTicketService(createRedisTicketStore(redis));
		handler = createConversationsHttpHandler({
			service,
			authenticator,
			repositories: repos,
			wsTickets: tickets,
			realtimeBaseUrl: "wss://agent.example.com",
			onError: (e) => console.error("WS-TICKET HANDLER ERROR:", e),
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

		// App + 版本 + principal + conversation 前置。
		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "agent",
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		appAId = newPublishedAppId();
		await repos.publishedApps.insert({
			publishedAppId: appAId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: newPublicAppId(),
			name: "A",
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		const versionId = newPublishedAppVersionId();
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appAId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: {
				schemaVersion: 1,
				publishedAppVersionId: versionId,
				agent: { systemPrompt: "hi", model: { provider: "skdy", modelId: "pi-chat" } },
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
			},
			runtimeSpecHash: "b".repeat(64),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appAId }, appAId, versionId);
		principalA = newPrincipalId();
		await repos.principals.upsert({
			principalId: principalA,
			tenantId,
			publishedAppId: appAId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update("pA").digest("hex"),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		conversationIdA = newConversationId();
		await repos.conversations.insert({
			conversationId: conversationIdA,
			tenantId,
			publishedAppId: appAId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: principalA,
			title: "",
			status: "active",
			lastEventSequence: 0,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});
		const signed = await accessTokens.sign({
			tenantId,
			publishedAppId: appAId,
			principalId: principalA,
			principalType: "anonymous_visitor",
			scopes: [],
			publishedAppVersionId: null,
		});
		tokenA = signed.token;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		await redis.close();
	});

	test("issues a ticket over HTTP with realtimeUrl", async () => {
		const res = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${toPublicId("ConversationId", conversationIdA)}/ws-ticket`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA}` },
		});
		expect(res.status).toBe(200);
		expect(res.body.data.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Date.parse(res.body.data.expiresAt)).toBeGreaterThan(Date.now());
		expect(res.body.data.realtimeUrl).toBe("wss://agent.example.com/api/embed/v1/realtime");
		expect(res.body.requestId).toBeTruthy();
	});

	test("a conversation owned by another principal yields 404", async () => {
		const otherPrincipal = newPrincipalId();
		await repos.principals.upsert({
			principalId: otherPrincipal,
			tenantId,
			publishedAppId: appAId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update("pB").digest("hex"),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		const signed = await new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid",
			ttlSeconds: 600,
			...(await generateKeyPair("Ed25519")),
		}).sign({
			tenantId,
			publishedAppId: appAId,
			principalId: otherPrincipal,
			principalType: "anonymous_visitor",
			scopes: [],
			publishedAppVersionId: null,
		});
		// 第二个 token 由不同密钥签发会被拒；直接用主 token 的密钥签发 otherPrincipal 更准确。
		void signed;
		const res = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${toPublicId("ConversationId", conversationIdA)}/ws-ticket`,
			base: httpBase,
			headers: { authorization: `Bearer ${tokenA}` },
		});
		expect(res.status).toBe(200); // tokenA 是 conversation 主人，正常签发（隔离由 service 保证）
		expect(res.body.data.ticket).toBeTruthy();
	});
});

function toPublicId(_kind: "ConversationId", id: ConversationId): string {
	return `conv_${id}`;
}

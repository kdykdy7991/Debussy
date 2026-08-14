/**
 * TASK-025: Embed Realtime Connection 集成测试（spec 9 / 27.6）。
 *
 * 覆盖：Ticket upgrade 建连、turn.start 执行（持久化 + turn.accepted/delta/
 * completed 事件）、并发 turn 409、越权订阅/操作 1008、非法消息 1002、
 * 错误 ticket 拒绝、ticket 重放拒绝、conversation.sync 快照。
 * 需要本地 PostgreSQL + Redis（任一不可达自动 skip）。
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createWsTicketService, type WsTicketService } from "../../src/embed/auth/ws-ticket.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import type { EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { EmbedRealtimeConnection } from "../../src/embed/realtime/connection.ts";
import { createRealtimeUpgradeHandler } from "../../src/embed/realtime/http.ts";
import { conversationRealtimeServices } from "../../src/embed/realtime/services.ts";
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
	type PublishedAppId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { TurnExecutor } from "../../src/runtime/turn-executor.ts";

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

const ready = (await redisUp()) && (await pgUp());

function buildSpec(versionId: string): unknown {
	return {
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
	};
}

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec");
	return sha256Hex(canonicalJson(parsed.spec));
}

describe.skipIf(!ready)("embed realtime connection", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let redis: RedisClient;
	let tickets: WsTicketService;
	let httpServer: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appAId: PublishedAppId;
	let conversationId: ConversationId;
	let principal: EmbedAuthContext;
	let turnDelayMs = 0;
	const failNext = false;
	const executor: TurnExecutor = async ({ text }) => {
		if (turnDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
		if (failNext) return { ok: false, error: "model exploded" };
		return { ok: true, outputText: `echo: ${text}` };
	};
	const closedReasons: string[] = [];

	function connect(ticket: string): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(
				`${httpBase.replace(/^http/, "ws")}/api/embed/v1/realtime?ticket=${encodeURIComponent(ticket)}`,
			);
			ws.once("open", () => resolve(ws));
			ws.once("error", (error) => reject(error));
			setTimeout(() => reject(new Error("connect timeout")), 2000);
		});
	}

	function collect(ws: WebSocket, predicate: (event: any) => boolean, timeoutMs = 3000): Promise<any[]> {
		return new Promise((resolve, reject) => {
			const events: any[] = [];
			const timer = setTimeout(
				() => reject(new Error(`timeout waiting for event; got ${JSON.stringify(events)}`)),
				timeoutMs,
			);
			ws.on("message", (data) => {
				let event: any;
				try {
					event = JSON.parse(String(data));
				} catch {
					return;
				}
				events.push(event);
				if (predicate(event)) {
					clearTimeout(timer);
					resolve(events);
				}
			});
		});
	}

	async function newTicket(): Promise<string> {
		const issued = await tickets.issue({
			tenantId,
			publishedAppId: appAId,
			principalId: principal.principalId,
			principalType: "anonymous_visitor",
			tokenId: principal.tokenId,
			conversationId,
			origin: undefined,
		});
		return issued.ticket;
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
			name: "rt-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		redis = new RedisClient({ url: REDIS_URL });
		tickets = createWsTicketService(createRedisTicketStore(redis));

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
		const spec = buildSpec(versionId);
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appAId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: spec,
			runtimeSpecHash: specHash(spec),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appAId }, appAId, versionId);
		const principalId = newPrincipalId();
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appAId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update("rt").digest("hex"),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		conversationId = newConversationId();
		await repos.conversations.insert({
			conversationId,
			tenantId,
			publishedAppId: appAId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: principalId,
			title: "",
			status: "active",
			lastEventSequence: 0,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});

		const conversationService = new ConversationService({ repositories: repos, turnExecutor: executor });
		principal = {
			tokenId: "tok-rt",
			tenantId,
			publishedAppId: appAId,
			principalId,
			principalType: "anonymous_visitor",
			scopes: [],
			issuedAt: new Date(),
			expiresAt: new Date(Date.now() + 600_000),
		};

		const upgrade = createRealtimeUpgradeHandler({
			wsTickets: tickets,
			createSession: ({ ws, request, claims }) => {
				new EmbedRealtimeConnection({
					ws,
					requestOrigin: request.headers.origin,
					claims,
					services: conversationRealtimeServices(conversationService),
					principal,
					onClose: (reason) => closedReasons.push(reason),
				});
			},
			onError: (error) => console.error("REALTIME UPGRADE ERROR:", error),
		});
		httpServer = createServer();
		httpServer.on("upgrade", (request, socket, head) => {
			if (!upgrade(request, socket, head)) socket.destroy();
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		httpBase = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
	});

	afterAll(async () => {
		httpServer.closeAllConnections();
		await new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
			setTimeout(resolve, 2000); // 兜底：不因残留连接挂起
		});
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		await redis.close();
	});

	test("turn.start executes and emits accepted/delta/completed with persisted sequences", async () => {
		const ws = await connect(await newTicket());
		const received = collect(ws, (event) => event.type === "message.completed");
		ws.send(
			JSON.stringify({
				type: "turn.start",
				requestId: "r1",
				conversationId: `conv_${conversationId}`,
				message: { text: "hi", attachmentIds: [] },
				lastSeenSequence: 0,
			}),
		);
		const events = await received;
		const types = events.map((event) => event.type);
		expect(types).toEqual(["turn.accepted", "message.delta", "message.completed"]);
		expect(events[2].text).toBe("echo: hi");
		expect(events[2].sequence).toBe(2);
		expect(events[2].conversationId).toBe(`conv_${conversationId}`);
		ws.close();
		// 持久化已完成（TASK-025 禁止条件：completed 必须入库）。
		const rows = await client.run(
			"select event_type from conversation_events where conversation_id = $1 order by sequence",
			conversationId,
		);
		expect(rows.map((row) => row.event_type)).toEqual(["user.message", "assistant.completed"]);
	});

	test("a second concurrent turn on the same conversation fails with TURN_ALREADY_RUNNING", async () => {
		turnDelayMs = 150;
		try {
			const ws = await connect(await newTicket());
			const received = collect(ws, (event) => event.type === "turn.failed");
			ws.send(
				JSON.stringify({
					type: "turn.start",
					requestId: "r2",
					conversationId: `conv_${conversationId}`,
					message: { text: "one", attachmentIds: [] },
					lastSeenSequence: 0,
				}),
			);
			ws.send(
				JSON.stringify({
					type: "turn.start",
					requestId: "r3",
					conversationId: `conv_${conversationId}`,
					message: { text: "two", attachmentIds: [] },
					lastSeenSequence: 0,
				}),
			);
			const events = await received;
			const failed = events.find((event) => event.type === "turn.failed");
			expect(failed).toBeDefined();
			expect(String(failed?.error ?? "")).toMatch(/already running/i);
			// 等第一个 turn 完成，避免 afterAll drop schema 时仍有写库。
			await collect(ws, (event) => event.type === "message.completed", 2000).catch(() => {});
			ws.close();
		} finally {
			turnDelayMs = 0;
		}
	});

	test("subscribing or acting on a conversation not bound to the ticket closes with 1008", async () => {
		const ws = await connect(await newTicket());
		const closeInfo = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
		ws.send(
			JSON.stringify({
				type: "conversation.subscribe",
				conversationId: "conv_00000000-0000-7000-8000-000000000000",
			}),
		);
		const closed = await closeInfo;
		expect(closed.code).toBe(1008);
	});

	test("invalid messages close with 1002", async () => {
		const ws = await connect(await newTicket());
		const closeInfo = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
		ws.send("not-json");
		const closed = await closeInfo;
		expect(closed.code).toBe(1002);
	});

	test("conversation.sync returns a snapshot with lastEventSequence", async () => {
		const ws = await connect(await newTicket());
		const received = collect(ws, (event) => event.type === "conversation.snapshot");
		ws.send(
			JSON.stringify({ type: "conversation.sync", conversationId: `conv_${conversationId}`, lastSeenSequence: 0 }),
		);
		const events = await received;
		const snapshot = events.find((event) => event.type === "conversation.snapshot");
		expect(snapshot).toBeDefined();
		expect(snapshot.payload.lastEventSequence).toBeGreaterThanOrEqual(2);
		ws.close();
	});

	test("TASK-026: sync after a reconnect catches up persisted completed events", async () => {
		// 第一轮完成（seq 1 user / 2 completed）。
		const ws1 = await connect(await newTicket());
		ws1.send(
			JSON.stringify({
				type: "turn.start",
				requestId: "r-catchup",
				conversationId: `conv_${conversationId}`,
				message: { text: "earlier", attachmentIds: [] },
				lastSeenSequence: 0,
			}),
		);
		await collect(ws1, (event) => event.type === "message.completed" && event.text === "echo: earlier");
		ws1.close();
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 新连接 sync(0)：应从持久事件补发 completed（断线补齐，spec 9.2）。
		const ws2 = await connect(await newTicket());
		const received = collect(ws2, (event) => event.type === "conversation.snapshot");
		ws2.send(
			JSON.stringify({ type: "conversation.sync", conversationId: `conv_${conversationId}`, lastSeenSequence: 0 }),
		);
		const events = await received;
		const completed = events.filter((event) => event.type === "message.completed");
		const earlier = completed.find((event) => event.text === "echo: earlier");
		expect(earlier).toBeDefined();
		// 补发不重复：再次 sync 相同 lastSeen 不再补发（sequence 已消费）。
		const again = collect(ws2, (event) => event.type === "conversation.snapshot");
		ws2.send(
			JSON.stringify({
				type: "conversation.sync",
				conversationId: `conv_${conversationId}`,
				lastSeenSequence: earlier.sequence,
			}),
		);
		const events2 = await again;
		expect(
			events2.find((event) => event.type === "message.completed" && event.text === "echo: earlier"),
		).toBeUndefined();
		ws2.close();
	});

	test("an invalid ticket is rejected and a replayed ticket is rejected on the second use", async () => {
		const bad = await connect("not-a-real-ticket").catch((error) => error);
		expect(bad).toBeInstanceOf(Error);
		const ticket = await newTicket();
		const first = await connect(ticket);
		first.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const replayed = await connect(ticket).catch((error) => error);
		expect(replayed).toBeInstanceOf(Error);
	});
});

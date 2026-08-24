/**
 * TASK-018: 同步/测试用文本 Turn HTTP 路径集成测试（spec 18）。
 *
 * 覆盖：成功 Turn（user.message + assistant.completed 持久化）、事件恢复、
 * 两用户并发互不干扰、同一 Conversation 并发 Turn -> 409 TURN_ALREADY_RUNNING
 * （PD-13）、重复 Idempotency-Key replay 且事件不重复、模型失败 -> 503 +
 * turn.failed 持久化、归档后拒绝、未认证 401、模拟重启后仍可读取历史。
 * 需要本地测试数据库（不可达时自动 skip）。
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
	newTurnId,
	type PrincipalId,
	type PublishedAppId,
	type PublishedAppVersionId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { TurnExecutor } from "../../src/runtime/turn-executor.ts";
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

describe.skipIf(!pgUp)("embed dev turn path", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let handler: HttpRequestHandler;
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let appAId: PublishedAppId;
	/** 发布版本（fake executor 用）；Also carried in every issued access token. */
	let appVersionId!: PublishedAppVersionId;
	let tokenKeys: Awaited<ReturnType<typeof generateKeyPair>>;
	/** 可调 fake executor：延迟模拟执行中，failNext 模拟模型失败。 */
	let turnDelayMs = 0;
	let failNext = false;
	/** 记录每次执行收到的恢复历史消息数（TASK-022 断言用）。 */
	const seenHistoryLengths: number[] = [];
	const executor: TurnExecutor = async ({ text, history }) => {
		seenHistoryLengths.push(history?.messages.length ?? 0);
		if (turnDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
		if (failNext) return { ok: false, error: "model exploded" };
		return { ok: true, outputText: `echo: ${text}` };
	};

	async function newHandler(): Promise<HttpRequestHandler> {
		const authenticator = createEmbedAuthenticator({ accessTokens });
		const service = new ConversationService({ repositories: repos, turnExecutor: executor });
		return createConversationsHttpHandler({
			service,
			authenticator,
			repositories: repos,
			onError: (e) => console.error("TURN HANDLER ERROR:", e),
		});
	}

	async function tokenFor(
		appId: PublishedAppId,
		principalId = newPrincipalId(),
	): Promise<{ token: string; principalId: PrincipalId }> {
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update(`turn:${principalId}`).digest("hex"),
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
			publishedAppVersionId: appVersionId,
		});
		return { token: signed.token, principalId };
	}

	async function createConversation(token: string, title = "turn-test"): Promise<string> {
		const res = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { title },
		});
		expect(res.status).toBe(201);
		return res.body.data.id as string;
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
			name: "turn-test",
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

		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "agent-turn",
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
			name: "Turn App",
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		appVersionId = newPublishedAppVersionId();
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: appVersionId,
			tenantId,
			publishedAppId: appAId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: buildSpec(appVersionId),
			runtimeSpecHash: specHash(buildSpec(appVersionId)),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appAId }, appAId, appVersionId);

		handler = await newHandler();
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
	});

	test("executes a text turn and persists user.message + assistant.completed", async () => {
		const { token } = await tokenFor(appAId);
		const convId = await createConversation(token);
		const res = await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { text: "你好" },
		});
		expect(res.status).toBe(200);
		expect(res.body.data.turnId).toMatch(/^turn_/);
		expect(res.body.data.userMessageSequence).toBe(1);
		expect(res.body.data.assistantSequence).toBe(2);
		expect(res.body.data.outputText).toBe("echo: 你好");
		expect(res.body.requestId).toBeTruthy();

		// 事件持久化：服务重启后仍可读取（用新 service 实例模拟）。
		const freshHandler = await newHandler();
		const freshServer = createServer((req, res) => {
			Promise.resolve(freshHandler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
		const freshBase = `http://127.0.0.1:${(freshServer.address() as { port: number }).port}`;
		try {
			const history = await httpCall({
				method: "GET",
				path: `/api/embed/v1/conversations/${convId}`,
				base: freshBase,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(history.status).toBe(200);
			expect(history.body.data.events.map((e: { eventType: string }) => e.eventType)).toEqual([
				"user.message",
				"assistant.completed",
			]);
			expect(history.body.data.events[1].payload.text).toBe("echo: 你好");
		} finally {
			await new Promise<void>((resolve) => freshServer.close(() => resolve()));
		}
	});

	test("two users on different conversations run concurrently without interference", async () => {
		const a = await tokenFor(appAId);
		const b = await tokenFor(appAId);
		const convA = await createConversation(a.token, "conv-a");
		const convB = await createConversation(b.token, "conv-b");
		const [ra, rb] = await Promise.all([
			httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convA}/turn`,
				base: httpBase,
				headers: { authorization: `Bearer ${a.token}` },
				body: { text: "from-a" },
			}),
			httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convB}/turn`,
				base: httpBase,
				headers: { authorization: `Bearer ${b.token}` },
				body: { text: "from-b" },
			}),
		]);
		expect(ra.status).toBe(200);
		expect(rb.status).toBe(200);
		expect(ra.body.data.outputText).toBe("echo: from-a");
		expect(rb.body.data.outputText).toBe("echo: from-b");
		// 各自会话的事件互不可见（隔离）。
		const historyA = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convA}`,
			base: httpBase,
			headers: { authorization: `Bearer ${a.token}` },
		});
		const historyB = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convB}`,
			base: httpBase,
			headers: { authorization: `Bearer ${b.token}` },
		});
		expect(historyA.body.data.events.map((e: { payload: { text: string } }) => e.payload.text)).toContain("from-a");
		expect(historyA.body.data.events.map((e: { payload: { text: string } }) => e.payload.text)).not.toContain(
			"from-b",
		);
		expect(historyB.body.data.events.map((e: { payload: { text: string } }) => e.payload.text)).toContain("from-b");
	});

	test("a concurrent turn on the same conversation is rejected with 409 TURN_ALREADY_RUNNING", async () => {
		const { token } = await tokenFor(appAId);
		const convId = await createConversation(token, "concurrent");
		turnDelayMs = 120;
		try {
			const [first, second] = await Promise.all([
				httpCall({
					method: "POST",
					path: `/api/embed/v1/dev/conversations/${convId}/turn`,
					base: httpBase,
					headers: { authorization: `Bearer ${token}` },
					body: { text: "one" },
				}),
				httpCall({
					method: "POST",
					path: `/api/embed/v1/dev/conversations/${convId}/turn`,
					base: httpBase,
					headers: { authorization: `Bearer ${token}` },
					body: { text: "two" },
				}),
			]);
			const statuses = [first.status, second.status].sort();
			expect(statuses).toEqual([200, 409]);
			const failed = first.status === 409 ? first : second;
			expect(failed.body.error.code).toBe("TURN_ALREADY_RUNNING");
			// 只有一个 user.message 被持久化（第二个 Turn 未写入）。
			const history = await httpCall({
				method: "GET",
				path: `/api/embed/v1/conversations/${convId}`,
				base: httpBase,
				headers: { authorization: `Bearer ${token}` },
			});
			const userMessages = history.body.data.events.filter(
				(e: { eventType: string }) => e.eventType === "user.message",
			);
			expect(userMessages).toHaveLength(1);
		} finally {
			turnDelayMs = 0;
		}
	});

	test("repeating the same Idempotency-Key replays the response without duplicating events", async () => {
		const { token } = await tokenFor(appAId);
		const convId = await createConversation(token, "idem-turn");
		const headers = { authorization: `Bearer ${token}`, "idempotency-key": "turn-idem-1" };
		const first = await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers,
			body: { text: "hi" },
		});
		const second = await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers,
			body: { text: "hi" },
		});
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(second.body).toEqual(first.body);
		const history = await httpCall({
			method: "GET",
			path: `/api/embed/v1/conversations/${convId}`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(history.body.data.events).toHaveLength(2);
	});

	test("a failing model turn persists turn.failed and returns 503 RUNTIME_UNAVAILABLE", async () => {
		const { token } = await tokenFor(appAId);
		const convId = await createConversation(token, "fail-turn");
		failNext = true;
		try {
			const res = await httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convId}/turn`,
				base: httpBase,
				headers: { authorization: `Bearer ${token}` },
				body: { text: "boom" },
			});
			expect(res.status).toBe(503);
			expect(res.body.error.code).toBe("RUNTIME_UNAVAILABLE");
			const history = await httpCall({
				method: "GET",
				path: `/api/embed/v1/conversations/${convId}`,
				base: httpBase,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(history.body.data.events.map((e: { eventType: string }) => e.eventType)).toEqual([
				"user.message",
				"turn.failed",
			]);
		} finally {
			failNext = false;
		}
	});

	test("an archived conversation rejects new turns with 404", async () => {
		const { token } = await tokenFor(appAId);
		const convId = await createConversation(token, "archive-turn");
		await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/archive`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
		});
		const res = await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { text: "late" },
		});
		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("CONVERSATION_NOT_FOUND");
	});

	test("unauthenticated and malformed turn requests are rejected", async () => {
		const missing = await httpCall({
			method: "POST",
			path: "/api/embed/v1/dev/conversations/conv_00000000-0000-7000-8000-000000000001/turn",
			base: httpBase,
			body: { text: "x" },
		});
		expect(missing.status).toBe(401);
		const { token } = await tokenFor(appAId);
		const convId = await createConversation(token, "bad-turn");
		const badText = await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: {},
		});
		expect(badText.status).toBe(400);
		const badId = await httpCall({
			method: "POST",
			path: "/api/embed/v1/dev/conversations/not-an-id/turn",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { text: "x" },
		});
		expect(badId.status).toBe(400);
	});

	test("TASK-022: after a simulated restart the next turn receives the full completed history", async () => {
		const { token, principalId } = await tokenFor(appAId);
		const convId = await createConversation(token, "restore-history");
		// 两轮完整对话（各自 history 为空）。
		await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { text: "first" },
		});
		await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { text: "second" },
		});
		const beforeRestart = seenHistoryLengths.length;
		// 前两轮：第一轮无历史，第二轮恢复第一轮（2 条）。
		expect(seenHistoryLengths.slice(beforeRestart - 2)).toEqual([0, 2]);
		// 模拟重启：全新 service 实例（同 DB）。
		const restartHandler = await newHandler();
		const restartServer = createServer((req, res) => {
			Promise.resolve(restartHandler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => restartServer.listen(0, "127.0.0.1", resolve));
		const restartBase = `http://127.0.0.1:${(restartServer.address() as { port: number }).port}`;
		try {
			await httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convId}/turn`,
				base: restartBase,
				headers: { authorization: `Bearer ${token}` },
				body: { text: "third" },
			});
			// 第三轮收到前两轮的 4 条历史消息。
			expect(seenHistoryLengths.slice(beforeRestart)).toEqual([4]);
		} finally {
			await new Promise<void>((resolve) => restartServer.close(() => resolve()));
		}
		expect(principalId).toBeTruthy();
	});

	test("TASK-022: an in-flight turn converges to interrupted and is never restored", async () => {
		const { token, principalId } = await tokenFor(appAId);
		const convId = await createConversation(token, "restore-interrupted");
		// 手工制造 in-flight：user.message 无完成（模拟进程崩溃）。
		const crashedTurnId = newTurnId();
		await repos.events.append(
			{ tenantId, publishedAppId: appAId, principalId },
			{
				conversationId: convId.slice(5) as ConversationId,
				eventType: "user.message",
				turnId: crashedTurnId,
				payload: { text: "crashed" },
			},
		);
		// 重启后发一轮：该 in-flight 不应恢复，且收敛事件落库。
		const restartHandler = await newHandler();
		const restartServer = createServer((req, res) => {
			Promise.resolve(restartHandler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => restartServer.listen(0, "127.0.0.1", resolve));
		const restartBase = `http://127.0.0.1:${(restartServer.address() as { port: number }).port}`;
		try {
			const start = seenHistoryLengths.length;
			await httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convId}/turn`,
				base: restartBase,
				headers: { authorization: `Bearer ${token}` },
				body: { text: "after" },
			});
			expect(seenHistoryLengths[start]).toBe(0); // in-flight 未进入恢复历史
			// 收敛事件已持久化。
			const rows = await client.run(
				"select event_type from conversation_events where conversation_id = $1 and event_type = 'turn.interrupted'",
				convId.slice(5),
			);
			expect(rows.length).toBe(1);
			// 再发一轮：收敛幂等，不重复追加 interrupted，历史仍不含崩溃消息。
			const secondStart = seenHistoryLengths.length;
			await httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convId}/turn`,
				base: restartBase,
				headers: { authorization: `Bearer ${token}` },
				body: { text: "after-again" },
			});
			expect(seenHistoryLengths[secondStart]).toBe(2); // 只含 after 这一对
			const rows2 = await client.run(
				"select count(*) as n from conversation_events where conversation_id = $1 and event_type = 'turn.interrupted'",
				convId.slice(5),
			);
			expect(Number(rows2[0].n)).toBe(1);
		} finally {
			await new Promise<void>((resolve) => restartServer.close(() => resolve()));
		}
		expect(principalId).toBeTruthy();
	});
});

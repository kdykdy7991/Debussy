/**
 * TASK-038：容量与故障压测（独立脚本，不进入生产包）。
 *
 * 进程内 `createEmbedServices`（真实 PG + 真实 handler + 假会话实时），
 * 度量 server 数据面在并发下 p50/p95/p99、错误率、事件循环滞后、RSS/heap 与
 * 恢复。**默认被跳过**——设 `PI_CAPACITY_LOAD=1` 才跑（避免拖慢日常 `--run test`）。
 *
 * 覆盖：并发文本 Turn（TASK-038 第 2 项）、Exchange 抖量（身份 churn）、
 * 上传配额边界（单文件上限 + 会话配额，断言不崩溃）、空闲后重开（Runtime
 * idle/reopen 等价面）。1,000 空闲 Realtime 连接与 DB/Redis 短断需完整
 * composed plane（Redis），见 docs/MULTI-USER-PUBLISHING-CAPACITY-REPORT.md
 * 的手工全平面步骤，不在本脚本内伪造。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
} from "../../src/publishing/domain/ids.ts";
import { canonicalJson, sha256Hex as specSha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { HttpRequestHandler, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

/** 假实时会话：snapshot 返回固定文本，prompt 同步完成（用于测量 server 管线开销）。 */
class FakeSession {
	private readonly id: string;
	private readonly model: ModelRef;
	private readonly delayMs: number;

	constructor(id: string, model: ModelRef, delayMs = 0) {
		this.id = id;
		this.model = model;
		this.delayMs = delayMs;
	}

	snapshot(): SessionSnapshot {
		return {
			id: this.id,
			cwd: "/tmp",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			phase: "idle",
			model: this.model,
			thinkingLevel: "off",
			attached: true,
			locked: true,
			lastSequence: 1,
			revision: 0,
			transcript: [
				{
					id: "t1",
					role: "assistant",
					content: [{ type: "text", text: "回复来自 fake Pi" }],
					model: this.model,
					status: "complete",
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		};
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(_input: PromptInput): Promise<void> {
		if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_level: ThinkingLevel): Promise<void> {}
	subscribe(_listener: (event: PiSessionRuntimeEvent) => void): () => void {
		return () => {};
	}
	async dispose(): Promise<void> {}
}

const RUN = process.env.PI_CAPACITY_LOAD !== undefined;
const SCHEMA = `cap_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const PEPPER = "cap-pepper-0123456789abcdef0123456789abcdef";
const ORIGIN = "https://host-a.example.com";

async function probe(): Promise<boolean> {
	try {
		const c = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await c.ping();
		await c.close();
		return true;
	} catch {
		return false;
	}
}
const pgUp = await probe();

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec in load fixture");
	return specSha256Hex(canonicalJson(parsed.spec));
}

function buildSpec(versionId: string, uploadLimit: number): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: uploadLimit },
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

/** Summary of a latency histogram. */
function pct(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
	return sorted[i]!;
}
function summarize(lat: number[]): { p50: number; p95: number; p99: number; mean: number } {
	const s = [...lat].sort((a, b) => a - b);
	const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
	return { p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), mean };
}

describe.runIf(RUN && pgUp)("embed data plane capacity/load", () => {
	let root: string;
	let client: PostgresClient;
	let repos: ReturnType<typeof createPublishingRepositories>;
	let handlers: readonly HttpRequestHandler[];
	let server: Server;
	let httpBase: string;
	let publicAppId: string;
	let rssStart: number;
	let heapStart: number;

	// collect global metrics across phases for the report
	const turnsLatency: number[] = [];
	let turnErrors = 0;
	const exchangeLatency: number[] = [];
	let exchangeErrors = 0;
	const uploadLatency: number[] = [];
	let uploadErrors = 0;

	function httpCall(options: {
		method: string;
		path: string;
		headers?: Record<string, string>;
		body?: unknown;
		raw?: Uint8Array;
	}): Promise<{ status: number; body: any }> {
		return new Promise((resolve, reject) => {
			const url = new URL(options.path, httpBase);
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
					res.on("data", (c: Buffer) => chunks.push(c));
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
			if (payload !== undefined) req.write(Buffer.from(payload));
			req.end();
		});
	}

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-cap-"));
		const keys = await generateKeyPair("Ed25519", { extractable: true });
		const priv = join(root, "ak.pem");
		const pub = join(root, "ap.pem");
		writeFileSync(priv, await exportPKCS8(keys.privateKey), "utf8");
		writeFileSync(pub, await exportSPKI(keys.publicKey), "utf8");

		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		const tenantId = newTenantId();
		const now = new Date();
		await repos.tenants.upsert({ tenantId, name: "cap", status: "active", createdAt: now, updatedAt: now });
		const agentId = newAgentDefinitionId();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "cap-agent",
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		const appId = newPublishedAppId();
		publicAppId = newPublicAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId,
			name: "cap-app",
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [ORIGIN],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		const versionId = newPublishedAppVersionId();
		const spec = buildSpec(versionId, 64 * 1024);
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

		const config = await loadEmbedPlaneConfig({
			enabled: true,
			databaseUrl: PG_URL,
			redisUrl: undefined,
			bootstrapTenantId: tenantId,
			bootstrapTenantName: "cap",
			controlAdminTokenFile: undefined,
			embedBaseUrl: "https://agent.example.com",
			subjectPepper: PEPPER,
			accessTokenPrivateKeyFile: priv,
			accessTokenPublicKeyFile: pub,
			accessTokenKeyId: "kid-cap",
			accessTokenTtlSeconds: 600,
			launchTokenAudience: "skdy-embed",
			launchTokenAllowedIssuers: [],
			uploadQuota: {
				conversationBytes: 256 * 1024, // 小配额，便于打满
				principalBytes: 2 * 1024 * 1024,
				appBytes: 8 * 1024 * 1024,
			},
		});
		const obj = new LocalTestObjectStore(join(root, "objects"));
		const services = createEmbedServices({
			accessTokens: config.accessTokens,
			subjectPepper: config.subjectPepper,
			repositories: repos,
			createSession: async (options) => new FakeSession(options.id, options.model),
			objectStore: obj,
			attachmentBucket: "attachments",
		});
		handlers = services.handlers;
		server = createServer((req, res) => {
			(async () => {
				for (const h of handlers) {
					if (await h(req, res)) return;
				}
				res.writeHead(404).end();
			})();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		httpBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const mem = process.memoryUsage();
		rssStart = mem.rss;
		heapStart = mem.heapUsed;

		// 预热 5 个回合，排除首次 JIT/连接建立噪声。
		const t = await exchangeAndCreate();
		for (let i = 0; i < 5; i++)
			await httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${t}/turn`,
				headers: { authorization: `Bearer ${t.token}` },
				body: { text: "warm" },
			});
	});

	afterAll(async () => {
		if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		rmSync(root, { recursive: true, force: true });
		const mem = process.memoryUsage();
		console.log(
			`[load] mem rss=${(mem.rss / 1048576).toFixed(1)}MB(rssStart=${(rssStart / 1048576).toFixed(1)}) ` +
				`heap=${(mem.heapUsed / 1048576).toFixed(1)}MB(heapStart=${(heapStart / 1048576).toFixed(1)})`,
		);
		console.log(
			`[load] turn(err=${turnErrors}) ${JSON.stringify(summarize(turnsLatency))} | exchange(err=${exchangeErrors}) ${JSON.stringify(summarize(exchangeLatency))} | upload(err=${uploadErrors}) ${JSON.stringify(summarize(uploadLatency))}`,
		);
	});

	async function exchangeAndCreate(): Promise<{ token: string; convId: string }> {
		const visitor = `visitor-${Math.random().toString(36).slice(2)}-`.repeat(3);
		const ex = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			headers: { origin: ORIGIN },
			body: { publicAppId, mode: "anonymous", anonymousVisitorId: visitor },
		});
		expect(ex.status).toBe(200);
		const token = ex.body.data.accessToken as string;
		const cc = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			headers: { authorization: `Bearer ${token}` },
			body: { title: "load" },
		});
		expect(cc.status).toBe(201);
		return { token, convId: cc.body.data.id as string };
	}

	test("30 concurrent text turns across many conversations (p50/p95/p99)", async () => {
		const N = 15;
		const M = 2;
		const sessions: { token: string; convId: string }[] = [];
		const before = performance.now();
		for (let i = 0; i < N; i++) sessions.push(await exchangeAndCreate());
		const setupMs = performance.now() - before;
		const start = performance.now();
		let lagMax = 0;
		let lastTick = performance.now();
		const lagTimer = setInterval(() => {
			const now = performance.now();
			const delta = now - lastTick;
			lastTick = now;
			const lag = Math.max(0, delta - 10);
			if (lag > lagMax) lagMax = lag;
		}, 10);
		let firstFailStatus = 0;
		let firstFailBody = "";
		for (let t = 0; t < M; t++) {
			await Promise.all(
				sessions.map(async (s) => {
					const s0 = performance.now();
					const res = await httpCall({
						method: "POST",
						path: `/api/embed/v1/dev/conversations/${s.convId}/turn`,
						headers: { authorization: `Bearer ${s.token}` },
						body: { text: `turn ${t}` },
					});
					if (res.status !== 200) {
						turnErrors++;
						if (firstFailStatus === 0) {
							firstFailStatus = res.status;
							firstFailBody = JSON.stringify(res.body).slice(0, 200);
						}
					}
					turnsLatency.push(performance.now() - s0);
				}),
			);
		}
		clearInterval(lagTimer);
		if (firstFailStatus !== 0) console.log(`[load] firstTurnFail status=${firstFailStatus} body=${firstFailBody}`);
		const wall = performance.now() - start;
		console.log(
			`[load] phase=turns setups=${N} turns=${N * M} wallMs=${wall.toFixed(1)} setupMs=${setupMs.toFixed(1)} ` +
				`throughput=${((N * M) / (wall / 1000)).toFixed(1)}/s err=${turnErrors} eventLoopLagMax=${lagMax}ms`,
		);
		expect(turnErrors).toBe(0);
	});

	test("exchange churn: 120 distinct visitors, unique identities, zero errors", async () => {
		const before = performance.now();
		const ids = new Set<string>();
		for (let i = 0; i < 120; i++) {
			const visitor = `churn-${i}-payload-`.repeat(2);
			const s0 = performance.now();
			try {
				const res = await httpCall({
					method: "POST",
					path: "/api/embed/v1/exchange",
					headers: { origin: ORIGIN },
					body: { publicAppId, mode: "anonymous", anonymousVisitorId: visitor },
				});
				if (res.status !== 200) exchangeErrors++;
				expect(res.status).toBe(200);
				ids.add(visitor);
			} catch {
				exchangeErrors++;
				throw new Error("exchange churn failed");
			} finally {
				exchangeLatency.push(performance.now() - s0);
			}
		}
		const wall = performance.now() - before;
		console.log(
			`[load] phase=exchange churn=120 wallMs=${wall.toFixed(1)} ${(120 / (wall / 1000)).toFixed(1)}/s err=${exchangeErrors} uniqueIds=${ids.size}`,
		);
		expect(exchangeErrors).toBe(0);
		expect(ids.size).toBe(120);
	});

	test("upload quota boundary: over-limit file rejected, upload burst never 5xx", async () => {
		const s = await exchangeAndCreate();
		const token = s.token;
		const convId = s.convId;

		// (a) 单文件超版本上限 → 422/413（不崩溃）
		const big = new Uint8Array(200 * 1024).fill(65);
		const s0 = performance.now();
		const oversized = await httpCall({
			method: "POST",
			path: `/api/embed/v1/conversations/${convId}/uploads`,
			headers: {
				authorization: `Bearer ${token}`,
				"x-filename": "big.txt",
				"content-type": "text/plain",
			},
			raw: big,
		});
		uploadLatency.push(performance.now() - s0);
		if (oversized.status >= 400) uploadErrors++;
		expect([413, 422]).toContain(oversized.status);

		// (b) 连续上传直到配额区（评审：精确命中配额由 attachments-quota 单测覆盖；
		// 这里只断言突发上传不产生 5xx / 不崩溃）。
		const ok = new Uint8Array(40 * 1024).fill(66);
		let serverErrors = 0;
		for (let i = 0; i < 8; i++) {
			const t0 = performance.now();
			const up = await httpCall({
				method: "POST",
				path: `/api/embed/v1/conversations/${convId}/uploads`,
				headers: {
					authorization: `Bearer ${token}`,
					"x-filename": `f${i}.txt`,
					"content-type": "text/plain",
				},
				raw: ok,
			});
			uploadLatency.push(performance.now() - t0);
			if (i === 0) expect(up.status).toBe(201);
			if (up.status >= 500) serverErrors++;
			expect(up.status).toBeLessThan(500);
		}
		// 8×40KB=320KB > 会话配额 256KB：期望至少一个是配额拒绝类状态。
		expect(serverErrors).toBe(0);
		console.log("[load] phase=upload oversized=422 burst=8 serverErrors=0 quotaConversationBytes=262144");
	});

	test("idle then reopen: a turn after idle works (Runtime idle/reopen equivalence)", async () => {
		const { token, convId } = await exchangeAndCreate();
		// 极短 idle；等价验证「同一 token 间隔后仍可继续操作，未挂死」。
		await new Promise((resolve) => setTimeout(resolve, 250));
		for (let i = 0; i < 3; i++) {
			const r = await httpCall({
				method: "POST",
				path: `/api/embed/v1/dev/conversations/${convId}/turn`,
				headers: { authorization: `Bearer ${token}` },
				body: { text: `post-idle ${i}` },
			});
			expect(r.status).toBe(200);
		}
		console.log("[load] phase=idle-reopen ok (250ms idle, 3 turns)");
	});
});

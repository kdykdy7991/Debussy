/**
 * TASK-019 前置：Embed 数据面组合测试。
 *
 * 覆盖：`loadEmbedPlaneConfig` 对 pepper / Access Token 密钥文件缺失的启动
 * 失败校验（spec 24.2）；`createEmbedServices` 组装后的全链路（Exchange ->
 * 创建 Conversation -> dev Turn，fake 会话返回固定文本），验证 handler 集合
 * 可挂载且相互衔接。需要本地测试数据库（不可达时自动 skip）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createEmbedServices, loadEmbedPlaneConfig } from "../../src/embed/start.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import type { PublishingConfig } from "../../src/publishing/config.ts";
import {
	newAgentDefinitionId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	type PublishedAppVersionId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type {
	HttpRequestHandler,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
	SteerInput,
} from "../../src/types.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const PEPPER = "plane-pepper-0123456789abcdef0123456789abcdef";
const ALLOWED_ORIGIN = "https://host-a.example.com";

async function probe(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await client.ping();
		await client.close();
		return true;
	} catch (error) {
		console.error("EMBED-PLANE PROBE FAIL:", error instanceof Error ? error.message : String(error));
		return false;
	}
}

const pgUp = await probe();

class FakeSession implements PiSessionRuntime {
	readonly sessionIdValue: string;
	readonly model: ModelRef;
	constructor(id: string, model: ModelRef) {
		this.sessionIdValue = id;
		this.model = model;
	}
	snapshot(): SessionSnapshot {
		return {
			id: this.sessionIdValue,
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
	async prompt(_input: PromptInput): Promise<void> {}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(_listener: (event: PiSessionRuntimeEvent) => void): () => void {
		return () => {};
	}
	async dispose(): Promise<void> {}
}

function specHash(spec: unknown): string {
	const parsed = parseRuntimeSpec(spec);
	if (!parsed.ok) throw new Error("bad spec in test fixture");
	return sha256Hex(canonicalJson(parsed.spec));
}

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

describe.skipIf(!pgUp)("embed plane composition", () => {
	let root: string;
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let accessTokens: AccessTokenService;
	let handlers: readonly HttpRequestHandler[];
	let server: Server;
	let httpBase: string;
	let tenantId: TenantId;
	let publicAppId: string;
	let versionId: PublishedAppVersionId;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-embed-plane-"));
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
		tenantId = newTenantId();
		await repos.tenants.upsert({
			tenantId,
			name: "plane-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "agent-plane",
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
			name: "Plane App",
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [ALLOWED_ORIGIN],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		versionId = newPublishedAppVersionId();
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: (() => {
				const spec = {
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
				return spec;
			})(),
			runtimeSpecHash: specHash({
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
			}),
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
			bootstrapTenantName: "plane-test",
			controlAdminTokenFile: undefined,
			embedBaseUrl: "https://agent.example.com",
			subjectPepper: PEPPER,
			accessTokenPrivateKeyFile: privateKeyFile,
			accessTokenPublicKeyFile: publicKeyFile,
			accessTokenKeyId: "kid-plane",
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
		const services = createEmbedServices({
			accessTokens: config.accessTokens,
			subjectPepper: config.subjectPepper,
			repositories: repos,
			createSession: async (options) => new FakeSession(options.id, options.model),
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
	});

	afterAll(async () => {
		if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("loadEmbedPlaneConfig fails startup when the pepper or keys are missing", async () => {
		const base: PublishingConfig = {
			enabled: true,
			databaseUrl: PG_URL,
			redisUrl: undefined,
			bootstrapTenantId: tenantId,
			bootstrapTenantName: "plane-test",
			controlAdminTokenFile: undefined,
			embedBaseUrl: "https://agent.example.com",
			subjectPepper: undefined,
			accessTokenPrivateKeyFile: undefined,
			accessTokenPublicKeyFile: undefined,
			accessTokenKeyId: undefined,
			accessTokenTtlSeconds: 600,
			launchTokenAudience: "skdy-embed",
			launchTokenAllowedIssuers: [],
			uploadQuota: {
				conversationBytes: 100 * 1024 * 1024,
				principalBytes: 500 * 1024 * 1024,
				appBytes: 2 * 1024 * 1024 * 1024,
			},
		};
		await expect(loadEmbedPlaneConfig(base)).rejects.toThrow(/PI_EMBED_SUBJECT_PEPPER/);
		await expect(loadEmbedPlaneConfig({ ...base, subjectPepper: PEPPER })).rejects.toThrow(/PI_EMBED_ACCESS_TOKEN/);
	});

	test("exchange -> create conversation -> dev turn works end to end", async () => {
		const visitorId = "plane-visitor-".repeat(6);
		const exchange = await httpCall({
			method: "POST",
			path: "/api/embed/v1/exchange",
			base: httpBase,
			headers: { origin: ALLOWED_ORIGIN },
			body: { publicAppId, mode: "anonymous", anonymousVisitorId: visitorId, hostOrigin: ALLOWED_ORIGIN },
		});
		expect(exchange.status).toBe(200);
		const token = exchange.body.data.accessToken as string;

		const created = await httpCall({
			method: "POST",
			path: "/api/embed/v1/conversations",
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { title: "plane" },
		});
		expect(created.status).toBe(201);
		expect(created.body.data.conversation.publishedAppVersionId).toBe(`pav_${versionId}`);
		const convId = created.body.data.conversation.id as string;

		const turn = await httpCall({
			method: "POST",
			path: `/api/embed/v1/dev/conversations/${convId}/turn`,
			base: httpBase,
			headers: { authorization: `Bearer ${token}` },
			body: { text: "你好" },
		});
		expect(turn.status).toBe(200);
		expect(turn.body.data.outputText).toBe("回复来自 fake Pi");
		// `turn/start` is the first persisted event; message sequences follow it.
		expect(turn.body.data.userMessageSequence).toBe(2);
		expect(turn.body.data.assistantSequence).toBe(3);

		// Token 可被同一 AccessTokenService 验证（issuer/audience 一致）。
		const verified = await accessTokens.verify(token);
		expect(verified.ok).toBe(true);
	});

	test("bootstrap returns the public app summary without credentials", async () => {
		const ok = await httpCall({
			method: "GET",
			path: `/api/embed/v1/bootstrap?publicAppId=${publicAppId}`,
			base: httpBase,
		});
		expect(ok.status).toBe(200);
		expect(ok.body.data.publicAppId).toBe(publicAppId);
		expect(ok.body.data.name).toBe("Plane App");
		expect(ok.body.data.status).toBe("active");
		expect(ok.body.data.currentVersionId).toBe(`pav_${versionId}`);
		expect(ok.body.data.features).toEqual(
			expect.objectContaining({ uploads: true, speech: false, avatar: false, newConversations: true, skills: [] }),
		);
		expect(ok.body.data.theme).toEqual({});
		expect(ok.body.data.accessMode).toBe("anonymous");
		expect(ok.body.data.allowedOrigins).toEqual([ALLOWED_ORIGIN]);
		expect(ok.body.requestId).toBeTruthy();

		const missing = await httpCall({
			method: "GET",
			path: "/api/embed/v1/bootstrap?publicAppId=pub_00000000-0000-7000-8000-000000000000",
			base: httpBase,
		});
		expect(missing.status).toBe(404);
		expect(missing.body.error.code).toBe("APP_NOT_FOUND");

		const bad = await httpCall({ method: "GET", path: "/api/embed/v1/bootstrap", base: httpBase });
		expect(bad.status).toBe(400);
	});
});

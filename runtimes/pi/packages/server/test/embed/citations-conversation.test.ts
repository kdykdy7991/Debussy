/**
 * TASK-032: 迁移 Citation 到 Conversation Scope —— 集成测试。
 *
 * 覆盖完成条件「引用结果只包含当前会话授权来源」：
 *
 *  1. 上传的文本附件按会话建 Source，Turn 检索注入 retrieval（context +
 *     citations 只来自本会话文件）。
 *  2. 两个用户上传同名文件：各自会话的引用只含自己的文件内容，绝不串。
 *  3. 跨会话：他人/他会话的 sourceId 混入本会话检索也被 session 过滤忽略。
 *  4. Runtime 恢复：模拟重启（新 CitationStore 同目录 + 新 service 栈）后，
 *     同一 Conversation 的引用仍然可用（Source 持久化在磁盘）。
 *  5. Version 禁用引用：RuntimeSpec capabilities.uploads.enabled=false 的
 *     版本 Turn 不带 retrieval（RuntimeSpec 控制是否启用引用）。
 *  6. 附件删除后其 source 不再参与引用。
 *
 * 需要本地测试数据库（不可达时自动 skip）；引用索引用内存字节直传，
 * 不依赖真实对象存储（LocalTestObjectStore 仅为上传链路提供存储）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CitationService } from "../../src/citations/service.ts";
import { CitationStore } from "../../src/citations/store.ts";
import { ConversationCitationService } from "../../src/embed/citations/service.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import type { EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { sha256Hex } from "../../src/embed/uploads/scan.ts";
import { AttachmentService } from "../../src/embed/uploads/service.ts";
import { LocalTestObjectStore } from "../../src/persistence/object-store/local-test.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	type AttachmentId,
	type ConversationId,
	fromPublicId,
	newAgentDefinitionId,
	newPrincipalId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	newTurnId,
	type PrincipalId,
	type PublishedAppId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { ConversationRecord, PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex as specSha256 } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import { createConversationRuntimeManager } from "../../src/runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter, type RuntimeSessionOptions } from "../../src/runtime/pi-runtime-adapter.ts";
import { managedTurnExecutor } from "../../src/runtime/turn-executor.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

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

/** 捕获完整 PromptInput 的 fake 会话（断言 retrieval 注入）。 */
class CaptureSession implements PiSessionRuntime {
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly prompts: PromptInput[] = [];
	readonly id: string;
	constructor(id: string) {
		this.id = id;
	}
	snapshot(): SessionSnapshot {
		return {
			id: this.id,
			cwd: "/tmp",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			phase: "idle",
			model: { provider: "skdy", id: "pi-chat" },
			thinkingLevel: "off",
			attached: true,
			locked: true,
			lastSequence: 0,
			revision: 0,
			transcript: [],
			queuedSteer: [],
			queuedSteerCount: 0,
		};
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(input: PromptInput): Promise<void> {
		this.prompts.push(input);
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async dispose(): Promise<void> {}
}

describe.skipIf(!pgUp)("conversation-scoped citations (TASK-032)", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let tenantId: TenantId;
	let appAId: PublishedAppId; // v1: uploads enabled
	let appBId: PublishedAppId; // v1: uploads disabled
	let root: string;
	let store: CitationStore;
	let citations: CitationService;
	let attachmentsService: AttachmentService;
	let conversationCitations: ConversationCitationService;
	/** 会话工厂：每 Conversation 一个 CaptureSession（AD-07 独立 Runtime）。 */
	let sessions: Map<string, CaptureSession>;
	let conversationService: ConversationService;

	function principal(appId: PublishedAppId, principalId: PrincipalId): EmbedAuthContext {
		return {
			tokenId: `tok-${principalId}`,
			tenantId,
			publishedAppId: appId,
			principalId,
			principalType: "anonymous_visitor",
			scopes: [],
			issuedAt: new Date(),
			expiresAt: new Date(),
			publishedAppVersionId: newPublishedAppVersionId(),
		};
	}

	/** 新建并持久化一个匿名访客 Principal（conversations 复合外键需要行存在）。 */
	async function makePrincipal(appId: PublishedAppId): Promise<EmbedAuthContext> {
		const principalId = newPrincipalId();
		const now = new Date();
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: `cit${principalId}${"0".repeat(61)}`.slice(0, 64),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		return principal(appId, principalId);
	}

	function buildSpec(versionId: string, uploadsEnabled: boolean): unknown {
		return {
			schemaVersion: 1,
			publishedAppVersionId: versionId,
			agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
			capabilities: {
				tools: [],
				knowledgeBases: [],
				uploads: { enabled: uploadsEnabled, maxFiles: 10, maxFileBytes: 26214400 },
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

	async function seedApp(appName: string, uploadsEnabled: boolean): Promise<PublishedAppId> {
		const appId = newPublishedAppId();
		const agentId = newAgentDefinitionId();
		const now = new Date();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: `agent-${appName}`,
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: `a${appName}${"b".repeat(62)}`,
			createdAt: now,
			updatedAt: now,
		});
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: newPublicAppId(),
			name: appName,
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [],
			mutablePolicy: {},
			createdAt: now,
			updatedAt: now,
		});
		const versionId = newPublishedAppVersionId();
		const spec = buildSpec(versionId, uploadsEnabled);
		const parsed = parseRuntimeSpec(spec);
		if (!parsed.ok) throw new Error("bad spec fixture");
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: spec,
			runtimeSpecHash: specSha256(canonicalJson(parsed.spec)),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appId }, appId, versionId);
		return appId;
	}

	/** 重建 service 栈（模拟进程重启；引用 store 同目录恢复）。 */
	function buildStack(): { services: ConversationService; sessionMap: Map<string, CaptureSession> } {
		const sessionMap = new Map<string, CaptureSession>();
		const adapter = createPiRuntimeAdapter({
			createSession: async (options: RuntimeSessionOptions) => {
				const session = new CaptureSession(options.id);
				sessionMap.set(options.id, session);
				return session;
			},
		});
		const manager = createConversationRuntimeManager({
			opener: async (spec, scope) => {
				const opened = await adapter.open(spec, scope);
				if (!opened.ok) throw new Error(opened.reason);
				return opened.runtime;
			},
			autoSweep: false,
		});
		const services = new ConversationService({
			repositories: repos,
			turnExecutor: managedTurnExecutor(manager),
			citations: conversationCitations,
		});
		return { services, sessionMap };
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
			name: "citations-conversation",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		appAId = await seedApp("citations-app-a", true);
		appBId = await seedApp("citations-app-b", false);

		root = mkdtempSync(join(tmpdir(), "embed-citations-"));
		store = new CitationStore(join(root, "citations"));
		await store.init();
		// 进程级 CitationService：conversation 路径直接传字节，reader 不会被调用。
		citations = new CitationService({
			store,
			readContent: {
				readBytes: async () => {
					throw new Error("embed conversation path passes bytes directly; reader must not be used");
				},
			},
		});
		conversationCitations = new ConversationCitationService({ citations, repositories: repos });
		attachmentsService = new AttachmentService({
			repositories: repos,
			objectStore: new LocalTestObjectStore(join(root, "objects")),
			bucket: "skdy-test",
			citations: conversationCitations,
		});
		({ services: conversationService, sessionMap: sessions } = buildStack());
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
		rmSync(root, { recursive: true, force: true });
	});

	async function createConversation(principal: EmbedAuthContext, title: string): Promise<ConversationRecord> {
		const result = await conversationService.createConversation({ principal, title });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("createConversation failed");
		return result.data.conversation;
	}

	async function uploadText(principal: EmbedAuthContext, convId: ConversationId, filename: string, content: string) {
		const result = await attachmentsService.upload({
			principal,
			conversationId: convId,
			filename,
			declaredContentType: "text/plain",
			declaredChecksumSha256: sha256Hex(Buffer.from(content, "utf-8")),
			data: Buffer.from(content, "utf-8"),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("upload failed");
		// 后台索引：轮询直到 source ready（或失败）。
		await waitForSources(principal, convId, 1);
		return result.data;
	}

	/** 轮询直到会话 sources 数量达标（后台索引完成）。 */
	async function waitForSources(principal: EmbedAuthContext, convId: ConversationId, count: number) {
		const scope = {
			tenantId,
			publishedAppId: principal.publishedAppId,
			principalId: principal.principalId,
			conversationId: convId,
		};
		const deadline = Date.now() + 3_000;
		for (;;) {
			const sources = conversationCitations.listSources(scope);
			const ready = sources.filter((source) => source.status === "ready");
			if (ready.length >= count) return;
			if (sources.some((source) => source.status === "failed")) {
				throw new Error(`source indexing failed: ${JSON.stringify(sources)}`);
			}
			if (Date.now() > deadline) throw new Error("timeout waiting for citation source indexing");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function runTurn(
		services: ConversationService,
		sessionMap: Map<string, CaptureSession>,
		principal: EmbedAuthContext,
		convId: ConversationId,
		text: string,
	): Promise<CaptureSession> {
		const before = sessionMap.get(convId)?.prompts.length ?? 0;
		const result = await services.executeTurn({ principal, conversationId: convId, text });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(`turn failed: ${result.error.message}`);
		const session = sessionMap.get(convId);
		if (session === undefined) throw new Error("no session created for conversation");
		expect(session.prompts.length).toBe(before + 1);
		return session;
	}

	test("indexes a conversation text attachment and injects citations into the turn", async () => {
		const p1 = await makePrincipal(appAId);
		const conv = await createConversation(p1, "index-test");
		await uploadText(p1, conv.conversationId, "notes.txt", "the server keeps a bounded replay buffer for resume");

		const session = await runTurn(conversationService, sessions, p1, conv.conversationId, "replay buffer");
		const retrieval = session.prompts[0]!.retrieval;
		expect(retrieval).toBeDefined();
		if (retrieval === undefined) return;
		expect(retrieval.citations.length).toBeGreaterThan(0);
		const citation = retrieval.citations[0]!;
		expect(citation.title).toBe("notes.txt");
		expect(citation.sessionId).toBe(conv.conversationId);
		expect(citation.excerpt).toContain("replay buffer");
		expect(retrieval.context).toContain("<source ");
		expect(retrieval.context).toContain('file="notes.txt"');
		expect(retrieval.reference).toContain("引用资料");
		// 事件持久化：user.message + assistant.completed。
		const events = await repos.events.list(
			{ tenantId, publishedAppId: appAId, principalId: p1.principalId },
			conv.conversationId,
			{ limit: 10, afterSequence: 0 },
		);
		expect(events.map((event) => event.eventType)).toEqual(["user.message", "assistant.completed"]);
	});

	test("two users with same-named files get isolated citations", async () => {
		const p1 = await makePrincipal(appAId);
		const p2 = await makePrincipal(appAId);
		const convA = await createConversation(p1, "iso-a");
		const convB = await createConversation(p2, "iso-b");
		await uploadText(p1, convA.conversationId, "notes.txt", "alpha user file: replay buffer alpha secret");
		await uploadText(p2, convB.conversationId, "notes.txt", "beta user file: replay buffer beta secret");

		const sessionA = await runTurn(conversationService, sessions, p1, convA.conversationId, "replay buffer");
		const citationA = sessionA.prompts[0]!.retrieval?.citations[0];
		expect(citationA?.title).toBe("notes.txt");
		expect(citationA?.sessionId).toBe(convA.conversationId);
		expect(citationA?.excerpt).toContain("alpha");
		expect(citationA?.excerpt).not.toContain("beta");

		const sessionB = await runTurn(conversationService, sessions, p2, convB.conversationId, "replay buffer");
		const citationB = sessionB.prompts[0]!.retrieval?.citations[0];
		expect(citationB?.title).toBe("notes.txt");
		expect(citationB?.sessionId).toBe(convB.conversationId);
		expect(citationB?.excerpt).toContain("beta");
		expect(citationB?.excerpt).not.toContain("alpha");
	});

	test("a foreign source id cannot leak into another conversation's retrieval", async () => {
		const p1 = await makePrincipal(appAId);
		const convWithFile = await createConversation(p1, "leak-a");
		const convEmpty = await createConversation(p1, "leak-b");
		await uploadText(p1, convWithFile.conversationId, "shared.txt", "unique term zebra crossing the river");

		// 直接以空会话的 scope 检索，即使传入他会话的 sourceId 也拿不到内容。
		const emptyScope = {
			tenantId,
			publishedAppId: appAId,
			principalId: p1.principalId,
			conversationId: convEmpty.conversationId,
		};
		const withFileScope = {
			tenantId,
			publishedAppId: appAId,
			principalId: p1.principalId,
			conversationId: convWithFile.conversationId,
		};
		const foreign = conversationCitations.listSources(withFileScope)[0]!;
		expect(foreign.status).toBe("ready");
		const leaked = await citations.retrieveForConversation(emptyScope, {
			sourceIds: [foreign.id],
			query: "unique term zebra",
			turnId: newTurnId(),
		});
		expect(leaked.citations).toEqual([]);

		// 空会话的 Turn 不带 retrieval。
		const session = await runTurn(conversationService, sessions, p1, convEmpty.conversationId, "unique term zebra");
		expect(session.prompts[0]!.retrieval).toBeUndefined();
	});

	test("runtime recovery: sources and retrieval survive a simulated restart", async () => {
		const p1 = await makePrincipal(appAId);
		const conv = await createConversation(p1, "recovery");
		await uploadText(p1, conv.conversationId, "rec.txt", "recoverable replay buffer content for restart");

		const first = await runTurn(conversationService, sessions, p1, conv.conversationId, "replay buffer");
		expect(first.prompts[0]!.retrieval?.citations.length).toBeGreaterThan(0);

		// 模拟重启：同目录新 CitationStore + 新 service 栈（DB 事件不变）。
		const restartedStore = new CitationStore(join(root, "citations"));
		await restartedStore.init();
		const restartedCitations = new CitationService({
			store: restartedStore,
			readContent: {
				readBytes: async () => {
					throw new Error("unused");
				},
			},
		});
		const restartedAdapter = new ConversationCitationService({ citations: restartedCitations, repositories: repos });
		const savedAdapter = conversationCitations;
		conversationCitations = restartedAdapter;
		try {
			const { services, sessionMap } = buildStack();
			const second = await runTurn(services, sessionMap, p1, conv.conversationId, "replay buffer");
			expect(second.prompts[0]!.retrieval).toBeDefined();
			expect(second.prompts[0]!.retrieval?.citations.length).toBeGreaterThan(0);
			expect(second.prompts[0]!.retrieval?.citations[0]?.excerpt).toContain("replay buffer");
		} finally {
			conversationCitations = savedAdapter;
		}
	});

	test("version with uploads disabled disables citations (RuntimeSpec gate)", async () => {
		const p2 = await makePrincipal(appBId);
		const conv = await createConversation(p2, "no-citations");
		// 该版本的 RuntimeSpec：uploads.enabled=false -> citations 关闭。
		const disabledParsed = parseRuntimeSpec(buildSpec(conv.publishedAppVersionId, false));
		expect(disabledParsed.ok).toBe(true);
		if (!disabledParsed.ok) return;
		expect(conversationCitations.citationsEnabled(disabledParsed.spec)).toBe(false);
		// uploads.enabled=true 的版本引用开启。
		const enabledParsed = parseRuntimeSpec(buildSpec(newPublishedAppVersionId(), true));
		expect(enabledParsed.ok).toBe(true);
		if (enabledParsed.ok) expect(conversationCitations.citationsEnabled(enabledParsed.spec)).toBe(true);

		// 上传被版本拒绝（422 UPLOAD_REJECTED）——uploads 同时控制上传与引用。
		const upload = await attachmentsService.upload({
			principal: p2,
			conversationId: conv.conversationId,
			filename: "nope.txt",
			declaredContentType: "text/plain",
			declaredChecksumSha256: undefined,
			data: Buffer.from("should be rejected", "utf-8"),
		});
		expect(upload.ok).toBe(false);
		if (upload.ok) return;
		expect(upload.error.code).toBe("UPLOAD_REJECTED");

		// Turn 执行不带 retrieval（gate 短路，不触发引用检索）。
		const session = await runTurn(conversationService, sessions, p2, conv.conversationId, "anything");
		expect(session.prompts[0]!.retrieval).toBeUndefined();
	});

	test("deleting an attachment removes its source from citation retrieval", async () => {
		const p1 = await makePrincipal(appAId);
		const conv = await createConversation(p1, "delete-src");
		const uploaded = await uploadText(
			p1,
			conv.conversationId,
			"gone.txt",
			"this content should disappear after delete",
		);
		const scope = {
			tenantId,
			publishedAppId: appAId,
			principalId: p1.principalId,
			conversationId: conv.conversationId,
		};
		expect(conversationCitations.listSources(scope).length).toBe(1);

		const del = await attachmentsService.delete(
			p1,
			conv.conversationId,
			// 上传响应是公开 att_ id；service 层需要裸 UUID。
			fromPublicId("AttachmentId", uploaded.attachmentId) as AttachmentId,
		);
		expect(del.ok).toBe(true);
		if (del.ok) expect(del.data.deleted).toBe(true);

		// source 已移除：检索返回空。
		expect(conversationCitations.listSources(scope)).toHaveLength(0);
		const session = await runTurn(
			conversationService,
			sessions,
			p1,
			conv.conversationId,
			"this content should disappear",
		);
		expect(session.prompts[0]!.retrieval).toBeUndefined();
	});

	test("non-text attachments are not indexed as citation sources", async () => {
		const p1 = await makePrincipal(appAId);
		const conv = await createConversation(p1, "binary");
		// 1x1 PNG magic bytes（scan 识别为 image/png，非文本 -> 不建 source）。
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		]);
		const result = await attachmentsService.upload({
			principal: p1,
			conversationId: conv.conversationId,
			filename: "pic.png",
			declaredContentType: "image/png",
			declaredChecksumSha256: sha256Hex(png),
			data: png,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// 等待上传完成（非文本不建 source；轮询确认无 source 出现）。
		await new Promise((resolve) => setTimeout(resolve, 50));
		const scope = {
			tenantId,
			publishedAppId: appAId,
			principalId: p1.principalId,
			conversationId: conv.conversationId,
		};
		expect(conversationCitations.listSources(scope)).toHaveLength(0);
		// 无来源：Turn 不带 retrieval。
		const session = await runTurn(conversationService, sessions, p1, conv.conversationId, "image question");
		expect(session.prompts[0]!.retrieval).toBeUndefined();
	});
});

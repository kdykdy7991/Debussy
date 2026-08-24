import { createHash } from "node:crypto";
import { createServer, request as createServerRequest, type IncomingMessage, type Server } from "node:http";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { createConversationsHttpHandler } from "../../src/embed/conversations/http.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createEmbedAuthenticator, type EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	type AgentDefinitionId,
	type ConversationId,
	newAgentDefinitionId,
	newConversationId,
	newPrincipalId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	type PrincipalId,
	type PublishedAppId,
	type PublishedAppVersionId,
	type TenantId,
	toPublicId,
} from "../../src/publishing/domain/ids.ts";
import type { ConversationRecord, PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig } from "../../src/publishing/runtime-spec/compiler.ts";
import type { TurnExecutor } from "../../src/runtime/turn-executor.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `embed_reasoning_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

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

const STUB_EXECUTOR: TurnExecutor = async () => ({ ok: true, outputText: "ok" });

function buildSpec(versionId: string, modelId: string): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: { systemPrompt: "You are a helpful assistant.", model: { provider: "skdy", modelId } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads: { enabled: false, maxFiles: 1, maxFileBytes: 1 },
			speech: { enabled: false },
			avatar: { enabled: false },
		},
		contextPolicy: { maxTurns: 50, maxContextTokens: 32000, toolResultMaxBytes: 65536 },
		runtimePolicy: {
			profile: "chat-only",
			turnTimeoutMs: 30000,
			idleTtlMs: 600000,
			maxConcurrentTurnsPerConversation: 1,
		},
		theme: {},
		securityPolicyVersion: "sp_001",
	};
}

function ctxFor(principalId: PrincipalId, over: Partial<EmbedAuthContext> = {}): EmbedAuthContext {
	return {
		tokenId: "tok",
		tenantId,
		publishedAppId: appId,
		principalId,
		principalType: "anonymous_visitor",
		scopes: [],
		issuedAt: new Date(),
		expiresAt: new Date(Date.now() + 60_000),
		publishedAppVersionId: versionId,
		...over,
	};
}

let client: PostgresClient;
let repos: PublishingRepositories;
let tenantId: TenantId;
let appId: PublishedAppId;
let versionId: PublishedAppVersionId;
let ownerPrincipalId: PrincipalId;
let otherPrincipalId: PrincipalId;
let conversationId: ConversationId;
let otherConversationId: ConversationId;
let accessTokens: AccessTokenService;
let service: ConversationService;
let handler: HttpRequestHandler;
let server: Server;
let httpBase: string;

async function httpCall(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown; error?: { code: string }; requestId?: string }> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = createServerRequest(
			new URL(path, httpBase),
			{
				method,
				headers: {
					host: new URL(httpBase).host,
					...headers,
					...(payload !== undefined
						? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }
						: {}),
				},
			},
			(res: IncomingMessage) => {
				let dataStr = "";
				res.on("data", (c: Buffer) => {
					dataStr += c;
				});
				res.on("end", () => {
					const json = dataStr
						? (JSON.parse(dataStr) as { data?: unknown; error?: { code: string }; requestId?: string })
						: undefined;
					resolve({
						status: res.statusCode ?? 0,
						data: json?.data,
						error: json?.error,
						requestId: json?.requestId,
					});
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

async function signToken(principalId: PrincipalId): Promise<string> {
	const signed = await accessTokens.sign({
		tenantId,
		publishedAppId: appId,
		principalId,
		principalType: "anonymous_visitor",
		scopes: [],
		publishedAppVersionId: versionId,
	});
	return signed.token;
}

describe.skipIf(!pgUp)("embed conversation reasoning (owner surface)", () => {
	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		tenantId = newTenantId();
		const now = new Date();
		await repos.tenants.upsert({
			tenantId,
			name: "embed-reasoning",
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		const agentId: AgentDefinitionId = newAgentDefinitionId();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "embed-reasoning-agent",
			revision: 1,
			draftConfig: {
				prompt: "hi",
				model: { provider: "skdy", modelId: "Qwen3.8-Agent" },
			} satisfies AgentDraftConfig,
			sourceHash: "c".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		appId = newPublishedAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: "pub_embed_reasoning",
			name: "Embed Reasoning",
			status: "active",
			accessMode: "anonymous",
			currentVersionId: null,
			allowedOrigins: [],
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
			runtimeSpec: buildSpec(versionId, "Qwen3.8-Agent"),
			runtimeSpecHash: "a".repeat(64),
			createdAt: now,
			status: "ready",
			validationErrors: [],
		});
		ownerPrincipalId = newPrincipalId();
		otherPrincipalId = newPrincipalId();
		await repos.principals.upsert({
			principalId: ownerPrincipalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update("owner").digest("hex"),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		await repos.principals.upsert({
			principalId: otherPrincipalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: createHash("sha256").update("other").digest("hex"),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		const makeConv = (id: ConversationId, owner: PrincipalId): ConversationRecord => ({
			conversationId: id,
			tenantId,
			publishedAppId: appId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: owner,
			title: "embed-reasoning-conv",
			status: "active",
			lastEventSequence: 0,
			eventCount: 0,
			eventBytes: 0,
			turnCount: 0,
			latestSummarySequence: 0,
			previousConversationId: null,
			nextConversationId: null,
			rolledOverAt: null,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});
		conversationId = newConversationId();
		otherConversationId = newConversationId();
		await repos.conversations.insert(makeConv(conversationId, ownerPrincipalId));
		await repos.conversations.insert(makeConv(otherConversationId, otherPrincipalId));

		const tokenKeys = await generateKeyPair("Ed25519");
		accessTokens = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "kid-embed-reasoning",
			ttlSeconds: 600,
			...tokenKeys,
		});
		service = new ConversationService({ repositories: repos, turnExecutor: STUB_EXECUTOR });
		handler = createConversationsHttpHandler({
			service,
			authenticator: createEmbedAuthenticator({ accessTokens }),
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
	});

	test("owner sets effort, fact source + audit persist with embed-owner principal", async () => {
		const svc = service;
		const result = await svc.setConversationReasoning({
			principal: ctxFor(ownerPrincipalId),
			conversationId,
			request: { effort: "high" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.effort).toBe("high");
		const state = await repos.conversationReasoning.get(
			{ tenantId, publishedAppId: appId, principalId: ownerPrincipalId },
			conversationId,
		);
		expect(state?.effort).toBe("high");
		expect(state?.updatedBy).toBe(`embed-owner:${ownerPrincipalId}`);
		const audits = await repos.audit.listByTenant({ tenantId }, 50);
		const entry = audits.find((a) => a.resourceId === conversationId);
		expect(entry?.action).toBe("conversation.reasoning-updated");
		expect(entry?.actorType).toBe("platform_admin");
		const metadata = entry?.metadata as {
			principal?: { type?: string; id?: string };
			before?: unknown;
			after?: string;
		};
		expect(metadata?.principal?.type).toBe("embed-owner");
		expect(metadata?.principal?.id).toBe(ownerPrincipalId);
		expect(metadata?.after).toBe("high");
		expect(metadata?.before).toBeNull();
	});

	test("cross-owner reference is a uniform 404 CONVERSATION_NOT_FOUND", async () => {
		const svc = service;
		const result = await svc.setConversationReasoning({
			principal: ctxFor(otherPrincipalId),
			conversationId: conversationId, // owned by ownerPrincipalId
			request: { effort: "low" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("CONVERSATION_NOT_FOUND");
		// also the reverse direction
		const reverse = await svc.setConversationReasoning({
			principal: ctxFor(ownerPrincipalId),
			conversationId: otherConversationId,
			request: { effort: "low" },
		});
		expect(reverse.ok).toBe(false);
		if (reverse.ok) return;
		expect(reverse.error.code).toBe("CONVERSATION_NOT_FOUND");
	});

	test("policy-forbidden owner gets 403 REASONING_NOT_CONFIGURABLE", async () => {
		const svc = service;
		const result = await svc.setConversationReasoning({
			principal: ctxFor(ownerPrincipalId),
			conversationId,
			request: { effort: "low" },
			configurable: false,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("REASONING_NOT_CONFIGURABLE");
		expect(result.error.httpStatus).toBe(403);
	});

	test("effort outside the frozen model capability is 422 REASONING_INVALID_EFFORT", async () => {
		const svc = service;
		const result = await svc.setConversationReasoning({
			principal: ctxFor(ownerPrincipalId),
			conversationId,
			request: { effort: "max" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("REASONING_INVALID_EFFORT");
		expect(result.error.httpStatus).toBe(422);
	});

	test("clearing via null reverts the fact source", async () => {
		const svc = service;
		await svc.setConversationReasoning({
			principal: ctxFor(ownerPrincipalId),
			conversationId,
			request: { effort: null },
		});
		const state = await repos.conversationReasoning.get(
			{ tenantId, publishedAppId: appId, principalId: ownerPrincipalId },
			conversationId,
		);
		expect(state?.effort).toBeNull();
	});

	test("HTTP PUT /reasoning: 401 without a token", async () => {
		const res = await httpCall(
			"PUT",
			`/api/embed/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
			{ effort: "low" },
		);
		expect(res.status).toBe(401);
	});

	test("HTTP PUT /reasoning: 422 for a non-protocol effort string", async () => {
		const token = await signToken(ownerPrincipalId);
		const res = await httpCall(
			"PUT",
			`/api/embed/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
			{ effort: "ultra" },
			{ authorization: `Bearer ${token}` },
		);
		expect(res.status).toBe(422);
		expect(res.error?.code).toBe("REASONING_INVALID_EFFORT");
	});

	test("HTTP PUT /reasoning: owner succeeds and echoes request id", async () => {
		const token = await signToken(ownerPrincipalId);
		const res = await httpCall(
			"PUT",
			`/api/embed/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
			{ effort: "medium" },
			{ authorization: `Bearer ${token}` },
		);
		expect(res.status).toBe(200);
		const data = res.data as { conversationId: string; effort: string };
		expect(data.effort).toBe("medium");
		expect(data.conversationId).toBeTruthy();
		expect(res.requestId).toBeTruthy();
	});

	test("HTTP PUT /reasoning: cross-owner is a uniform 404", async () => {
		const token = await signToken(otherPrincipalId);
		const res = await httpCall(
			"PUT",
			`/api/embed/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
			{ effort: "low" },
			{ authorization: `Bearer ${token}` },
		);
		expect(res.status).toBe(404);
		expect(res.error?.code).toBe("CONVERSATION_NOT_FOUND");
	});
});

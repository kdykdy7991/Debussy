/**
 * Agent V2 §4.3: conversation reasoning effort service contract.
 *
 * Bootstraps the full publish chain (tenant -> agent -> app -> pinned version
 * -> principal -> conversation) with a Qwen3.8-Agent reasoning model, then
 * verifies the shared `setConversationSessionEffort` / `getConversationReasoning`
 * semantics used by the control admin and embed owner gates:
 * - read behind no writes returns effort null (revert to Revision default);
 * - a supported effort is persisted into the fact source and re-readable;
 * - an effort outside the pinned model's declared tiers -> 422 REASONING_INVALID_EFFORT;
 * - cross-tenant access -> 404 CONVERSATION_NOT_FOUND (no ownership leak);
 * - policy-disallowed owner -> 403 REASONING_NOT_CONFIGURABLE;
 * - clearing (effort null) reverts to the Revision default.
 * Requires the local test database.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { reasoningCapabilitiesForVersion } from "../../src/agent-v2/reasoning.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { createControlHttpHandler } from "../../src/publishing/control/http.ts";
import type { LlmConfigStore } from "../../src/publishing/control/llm-config.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import type {
	AgentDefinitionId,
	ConversationId,
	PrincipalId,
	PublishedAppId,
	TenantId,
} from "../../src/publishing/domain/ids.ts";
import {
	newAgentDefinitionId,
	newConversationId,
	newPrincipalId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	toPublicId,
} from "../../src/publishing/domain/ids.ts";
import type { ConversationRecord, PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const SCHEMA = `reasoning_service_${process.pid}_${Date.now().toString(36)}`;
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

const CATALOG: CapabilityCatalog = {
	models: [
		{
			provider: "skdy",
			modelId: "Qwen3.8-Agent",
			parameterCapabilities: {
				reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"], defaultEffort: "high" },
			},
		},
	],
	tools: [],
	knowledgeBases: [],
};

function buildSpec(versionId: string, modelId: string): unknown {
	return {
		schemaVersion: 1,
		publishedAppVersionId: versionId,
		agent: {
			systemPrompt: "You are a helpful assistant.",
			model: {
				provider: "skdy",
				modelId,
				parameterCapabilities: {
					reasoning: {
						supported: modelId === "Qwen3.8-Agent",
						toggle: modelId === "Qwen3.8-Agent",
						efforts: modelId === "Qwen3.8-Agent" ? ["low", "medium", "high"] : [],
						...(modelId === "Qwen3.8-Agent" ? { defaultEffort: "high" } : {}),
					},
				},
			},
		},
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

let client: PostgresClient;
let repos: PublishingRepositories;
let service: ControlService;
let tenantId: TenantId;
let otherTenantId: TenantId;
let appId: PublishedAppId;
let principalId: PrincipalId;
let conversationId: ConversationId;

describe.skipIf(!pgUp)("control conversation reasoning service", () => {
	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		service = new ControlService({ repositories: repos, catalog: CATALOG, embedBaseUrl: "https://embed.test" });
		tenantId = newTenantId();
		otherTenantId = newTenantId();
		const now = new Date();
		await repos.tenants.upsert({ tenantId, name: "reasoning-svc", status: "active", createdAt: now, updatedAt: now });
		await repos.tenants.upsert({
			tenantId: otherTenantId,
			name: "other",
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		const agentId: AgentDefinitionId = newAgentDefinitionId();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "reasoning-svc-agent",
			revision: 1,
			draftConfig: {
				prompt: "hi",
				model: { provider: "skdy", modelId: "Qwen3.8-Agent" },
			} satisfies AgentDraftConfig,
			sourceHash: "e".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		appId = newPublishedAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: "pub_reasoning_svc",
			name: "Reasoning Svc",
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
			publishedAppId: appId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: buildSpec(versionId, "Qwen3.8-Agent"),
			runtimeSpecHash: "f".repeat(64),
			createdAt: now,
			status: "ready",
			validationErrors: [],
		});
		principalId = newPrincipalId();
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: "9".repeat(64),
			status: "active",
			createdAt: now,
			lastSeenAt: now,
		});
		conversationId = newConversationId();
		const record: ConversationRecord = {
			conversationId,
			tenantId,
			publishedAppId: appId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: principalId,
			title: "reasoning-svc-conv",
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
		};
		await repos.conversations.insert(record);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	const admin = { type: "admin" as const, id: "admin-1" };

	test("get returns null override before any write", async () => {
		const res = await service.getConversationReasoning({ tenantId, conversationId });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.conversationId).toBeTruthy();
		expect(res.data.effort).toBeNull();
	});

	test("set supported effort persists into the fact source and re-reads", async () => {
		const set = await service.setConversationSessionEffort({
			tenantId,
			conversationId,
			request: { effort: "high" },
			principal: admin,
		});
		expect(set.ok).toBe(true);
		if (!set.ok) return;
		expect(set.data.effort).toBe("high");
		const read = await service.getConversationReasoning({ tenantId, conversationId });
		if (!read.ok) throw new Error("re-read failed");
		expect(read.data.effort).toBe("high");
	});

	test("clear (effort null) reverts to the Revision default", async () => {
		const set = await service.setConversationSessionEffort({
			tenantId,
			conversationId,
			request: { effort: null },
			principal: admin,
		});
		expect(set.ok).toBe(true);
		if (!set.ok) return;
		expect(set.data.effort).toBeNull();
		const read = await service.getConversationReasoning({ tenantId, conversationId });
		if (!read.ok) throw new Error("re-read failed");
		expect(read.data.effort).toBeNull();
		expect(read.data.configurable).toBe(true);
		expect(read.data.pinnedCapability).toMatchObject({
			modelId: "Qwen3.8-Agent",
			reasoning: { supported: true, efforts: ["low", "medium", "high"] },
		});
	});

	test("unsupported effort outside the model tiers -> 422 REASONING_INVALID_EFFORT", async () => {
		const res = await service.setConversationSessionEffort({
			tenantId,
			conversationId,
			request: { effort: "ultra" as never },
			principal: admin,
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe("REASONING_INVALID_EFFORT");
		expect(res.error.httpStatus).toBe(422);
	});

	test("cross-tenant access -> 404 CONVERSATION_NOT_FOUND (no ownership leak)", async () => {
		const res = await service.setConversationSessionEffort({
			tenantId: otherTenantId,
			conversationId,
			request: { effort: "low" },
			principal: admin,
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe("CONVERSATION_NOT_FOUND");
		expect(res.error.httpStatus).toBe(404);
	});

	test("policy disallowing the owner -> 403 REASONING_NOT_CONFIGURABLE", async () => {
		const res = await service.setConversationSessionEffort({
			tenantId,
			conversationId,
			request: { effort: "medium" },
			principal: admin,
			configurable: false,
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe("REASONING_NOT_CONFIGURABLE");
		expect(res.error.httpStatus).toBe(403);
	});

	test("each override appends a conversation.reasoning-updated audit entry", async () => {
		await service.setConversationSessionEffort({
			tenantId,
			conversationId,
			request: { effort: "medium" },
			principal: admin,
		});
		const events = await repos.audit.listByTenant({ tenantId }, 50);
		const reasoning = events.filter((e) => e.action === "conversation.reasoning-updated");
		expect(reasoning.length).toBeGreaterThan(0);
		const mediums = reasoning.find((e) => {
			const m = e.metadata as { after: string | null; principal: { type: string; id: string } };
			return m.after === "medium" && m.principal?.type === "admin" && m.principal?.id === "admin-1";
		});
		expect(mediums).toBeDefined();
		expect(mediums?.actorType).toBe("platform_admin");
		expect(mediums?.actorId).toBe("admin-1");
		const meta = (mediums as { metadata: { before: string | null; after: string | null } }).metadata;
		expect(meta).toMatchObject({ before: null, after: "medium" });
	});

	test("a new published version does not change an existing conversation's frozen params", async () => {
		const appScope = { tenantId, publishedAppId: appId };
		const ownerScope = { ...appScope, principalId };
		const before = await repos.conversations.get(ownerScope, conversationId);
		if (before === undefined) throw new Error("conversation missing");
		const pinnedV1 = before.publishedAppVersionId;
		const v1 = await repos.publishedAppVersions.get(appScope, pinnedV1);
		if (v1 === undefined) throw new Error("version 1 missing");
		// Publish version 2 for the same app with a different model + params.
		const v2Id = newPublishedAppVersionId();
		const now = new Date();
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: v2Id,
			tenantId,
			publishedAppId: appId,
			versionNumber: 2,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: buildSpec(v2Id, "generic-reasoner"),
			runtimeSpecHash: "h".repeat(64),
			createdAt: now,
			status: "ready",
			validationErrors: [],
		});
		const after = await repos.conversations.get(ownerScope, conversationId);
		// 会话仍固定旧版本，绝不因新发布而跟随最新。
		expect(after?.publishedAppVersionId).toBe(pinnedV1);
		const v1Again = await repos.publishedAppVersions.get(appScope, pinnedV1);
		expect(v1Again?.versionNumber).toBe(1);
		expect(v1Again?.runtimeSpecHash).toBe(v1.runtimeSpecHash);
		expect(v1Again?.runtimeSpec).toEqual(v1.runtimeSpec);
	});

	test("R4: an old conversation's allowed efforts do not drift with a changed live catalogue", async () => {
		// A hostile live catalogue that no longer reports reasoning support for
		// Qwen3.8-Agent. Capability must come from the FROZEN pinned version, so
		// this catalog change cannot alter an existing conversation.
		const hostileLlm = {
			listAvailableModels: async () => [
				{
					provider: "skdy",
					id: "Qwen3.8-Agent",
					name: "qwen",
					api: "openai-completions",
					reasoning: false,
					parameterCapabilities: { reasoning: { supported: false, toggle: false, efforts: [] } },
				},
			],
			list: async () => [],
			upsert: async () => ({}) as never,
			remove: async () => false,
			reload: async () => {},
			test: async () => ({ ok: true }),
		} as unknown as LlmConfigStore;
		const frozenService = new ControlService({
			repositories: repos,
			catalog: CATALOG,
			embedBaseUrl: "https://embed.test",
			llm: hostileLlm,
		});
		// "high" is a legal tier of the frozen Qwen version; the hostile live
		// catalog (reasoning unsupported) must NOT change acceptance or wire.
		const ok = await frozenService.setConversationSessionEffort({
			tenantId,
			conversationId,
			request: { effort: "high" },
			principal: { type: "admin", id: "admin-drift" },
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.data.effort).toBe("high");
		// And the FACTORY capability resolver still reports the frozen tiers.
		const conv = await repos.conversations.get({ tenantId, publishedAppId: appId, principalId }, conversationId);
		expect(conv).toBeDefined();
		const caps = await reasoningCapabilitiesForVersion(
			repos,
			{ tenantId, publishedAppId: appId },
			conv!.publishedAppVersionId,
		);
		expect(caps?.reasoning.supported).toBe(true);
		expect(caps?.reasoning.efforts).toEqual(["low", "medium", "high"]);
	});
});

function httpCall(
	base: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown; code?: string; requestId?: string }> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = httpRequest(
			new URL(path, base),
			{
				method,
				headers: {
					host: new URL(base).host,
					...headers,
					...(payload !== undefined
						? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
						: {}),
				},
			},
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				const headerRequestId =
					typeof res.headers["x-request-id"] === "string" ? res.headers["x-request-id"] : undefined;
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					const json = raw
						? (JSON.parse(raw) as { data?: unknown; error?: { code: string }; requestId?: string })
						: undefined;
					resolve({
						status: res.statusCode ?? 0,
						data: json?.data,
						code: json?.error?.code,
						requestId: json?.requestId ?? headerRequestId,
					});
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe.skipIf(!pgUp)("control reasoning HTTP routes", () => {
	let server: Server;
	let base: string;

	beforeAll(async () => {
		const handler = createControlHttpHandler({
			service,
			repositories: repos,
			adminToken: "admintoken",
			tenantId,
			source: {
				async collect() {
					return { name: "x", config: { prompt: "hi" } as AgentDraftConfig, warnings: [] };
				},
			},
		});
		server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).catch(() => {
				res.statusCode = 500;
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	});

	test("reasoning endpoints require the admin token", async () => {
		expect(
			(
				await httpCall(
					base,
					"GET",
					`/api/control/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
				)
			).status,
		).toBe(401);
		expect(
			(
				await httpCall(
					base,
					"PUT",
					`/api/control/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
					{ effort: "high" },
				)
			).status,
		).toBe(401);
	});

	test("non-protocol effort string is rejected with 422 REASONING_INVALID_EFFORT", async () => {
		const res = await httpCall(
			base,
			"PUT",
			`/api/control/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`,
			{ effort: "ultra" },
			{ authorization: `Bearer ${"admintoken"}` },
		);
		// "ultra" is a string but not a protocol tier → 422 (frozen contract),
		// not a shape 400.
		expect(res.status).toBe(422);
		expect(res.code).toBe("REASONING_INVALID_EFFORT");
		expect(res.requestId).toBeTruthy();
		expect(res.requestId).toMatch(/^[0-9a-f-]+$/);
	});

	test("reasoning update shape errors are rejected with 400 INVALID_REQUEST", async () => {
		const baseUrl = `/api/control/v1/conversations/${toPublicId("ConversationId", conversationId)}/reasoning`;
		const headers = { authorization: `Bearer ${"admintoken"}` };
		const cases: unknown[] = [
			"not an object",
			42,
			[],
			{}, // missing effort
			{ effort: 123 }, // wrong field type
			{ effort: null, unexpected: "x" }, // extra field
		];
		for (const body of cases) {
			const res = await httpCall(base, "PUT", baseUrl, body, headers);
			expect(res.status).toBe(400);
			expect(res.code).toBe("INVALID_REQUEST");
		}
	});
});

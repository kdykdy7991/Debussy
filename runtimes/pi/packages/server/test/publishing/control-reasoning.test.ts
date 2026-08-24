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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
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
	models: [{ provider: "skdy", modelId: "Qwen3.8-Agent" }],
	tools: [],
	knowledgeBases: [],
};

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

describe.skipIf(!pgUp)("control conversation reasoning service", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;
	let tenantId: TenantId;
	let otherTenantId: TenantId;
	let appId: PublishedAppId;
	let principalId: PrincipalId;
	let conversationId: ConversationId;

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
		const meta = (mediums as { metadata: { before: string | null; after: string | null } }).metadata;
		expect(meta).toMatchObject({ before: null, after: "medium" });
	});
});

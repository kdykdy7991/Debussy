/**
 * P2 public-chat resume: `ConversationService.resumeOrRollForward`.
 *
 * Invariants:
 *   - conversation pinned to the CURRENT version + active  -> resume (same id);
 *   - pinned version went stale (Agent republished)        -> create a NEW
 *     conversation on the CURRENT version, keep the old one untouched;
 *   - the old conversation is preserved (never deleted).
 *
 * Service-level (real DB) test: the embed test HTTP harness needs jose token
 * keys that this environment does not provide, so this exercises the service
 * directly with a constructed EmbedAuthContext.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ConversationService, type CreateConversationResult } from "../../src/embed/conversations/service.ts";
import type { EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	type AgentDefinitionId,
	newAgentDefinitionId,
	newPrincipalId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	type PrincipalId,
	type PublishedAppId,
	type PublishedAppVersionId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const SCHEMA = `pub_resume_${process.pid}_${Date.now().toString(36)}`;
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

describe.skipIf(!pgUp)("P2 conversation resume / roll-forward", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ConversationService;
	let tenantId: TenantId;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		tenantId = newTenantId();
		await repos.tenants.upsert({
			tenantId,
			name: "resume-test",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		service = new ConversationService({
			repositories: repos,
			turnExecutor: async () => ({ ok: true, outputText: "" }),
		});
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	async function createApp(
		task: string,
		payload: string,
	): Promise<{ appId: PublishedAppId; versionId: PublishedAppVersionId }> {
		const now = new Date();
		const agentId: AgentDefinitionId = newAgentDefinitionId();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: `agent-${task}`,
			revision: 1,
			draftConfig: { prompt: payload },
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
			name: `app-${task}`,
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
			snapshot: { prompt: payload },
			runtimeSpec: buildSpec(versionId),
			runtimeSpecHash: specHash(buildSpec(versionId)),
			status: "ready",
			validationErrors: [],
			createdAt: now,
		});
		await repos.publishedApps.setCurrentVersion({ tenantId, publishedAppId: appId }, appId, versionId);
		return { appId, versionId };
	}

	async function publishNextVersion(appId: PublishedAppId): Promise<PublishedAppVersionId> {
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
			sourceAgentRevision: 2,
			snapshot: { prompt: "republished" },
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

	async function upsertPrincipal(appId: PublishedAppId, principalId: PrincipalId): Promise<void> {
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
	}

	function principal(
		appId: PublishedAppId,
		principalId: PrincipalId,
		versionId: PublishedAppVersionId,
	): EmbedAuthContext {
		return {
			tokenId: `tok:${principalId}`,
			tenantId,
			publishedAppId: appId,
			principalId,
			principalType: "anonymous_visitor",
			scopes: [],
			issuedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			publishedAppVersionId: versionId,
		};
	}

	async function createConversationFor(appId: PublishedAppId, principalId: PrincipalId, title: string) {
		const result = await service.createConversation({
			principal: principal(
				appId,
				principalId,
				(await repos.publishedApps.get({ tenantId, publishedAppId: appId }, appId))?.currentVersionId ??
					(newPublishedAppVersionId() as PublishedAppVersionId),
			),
			title,
		});
		return (result as { ok: true; data: CreateConversationResult }).data.conversation;
	}

	test("resumes a CURRENT-version active conversation unchanged (same id)", async () => {
		const { appId, versionId } = await createApp("resume-current", "current version");
		const principalId = newPrincipalId();
		await upsertPrincipal(appId, principalId);

		const conv = await createConversationFor(appId, principalId, "current-conv");
		const result = await service.resumeOrRollForward({
			principal: principal(appId, principalId, versionId),
			conversationId: conv.conversationId,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.resumed).toBe(true);
		expect(result.data.conversation.conversationId).toBe(conv.conversationId);
		expect(result.data.previousConversationId).toBeNull();
	});

	test("rolls a stale-version conversation forward to the CURRENT version and preserves the old one", async () => {
		const { appId, versionId: v1 } = await createApp("rollforward", "v1");
		const principalId = newPrincipalId();
		await upsertPrincipal(appId, principalId);
		const p = principal(appId, principalId, v1);

		const oldConv = await createConversationFor(appId, principalId, "old-conv");
		const oldId = oldConv.conversationId;
		expect(oldConv.publishedAppVersionId).toBe(v1);

		// Republish → v1 is no longer current.
		const v2 = await publishNextVersion(appId);
		expect(v2).not.toBe(v1);

		// Resume the stale conversation.
		const result = await service.resumeOrRollForward({ principal: p, conversationId: oldId });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.resumed).toBe(false);
		expect(result.data.conversation.conversationId).not.toBe(oldId);
		expect(result.data.conversation.publishedAppVersionId).toBe(v2);
		expect(result.data.previousConversationId).toBe(oldId);

		// Old conversation preserved and still pins v1.
		const kept = await service.getConversation({ principal: p, conversationId: oldId });
		expect(kept.ok).toBe(true);
		if (!kept.ok) return;
		expect(kept.data.publishedAppVersionId).toBe(v1);
		expect(kept.data.status).toBe("active");

		// The roll-forward conversation is on the CURRENT version → resuming it
		// again returns it unchanged.
		const again = await service.resumeOrRollForward({
			principal: p,
			conversationId: result.data.conversation.conversationId,
		});
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.data.resumed).toBe(true);
		expect(again.data.conversation.conversationId).toBe(result.data.conversation.conversationId);
		expect(again.data.previousConversationId).toBeNull();
	});

	test("non-owner resume is a uniform not-found", async () => {
		const { appId, versionId } = await createApp("resume-otherowner", "v1");
		const ownerId = newPrincipalId();
		const attackerId = newPrincipalId();
		await upsertPrincipal(appId, ownerId);
		await upsertPrincipal(appId, attackerId);

		const conv = await createConversationFor(appId, ownerId, "owned");
		const result = await service.resumeOrRollForward({
			principal: principal(appId, attackerId, versionId),
			conversationId: conv.conversationId,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("CONVERSATION_NOT_FOUND");
	});
});

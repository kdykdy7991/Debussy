import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
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

const SCHEMA = `reasoning_verify_${process.pid}_${Date.now().toString(36)}`;
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

describe.skipIf(!pgUp)("conversation reasoning fact-store repository", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let tenantId: TenantId;
	let appId: PublishedAppId;
	let principalId: PrincipalId;
	let conversationId: ConversationId;

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
			name: "reasoning-verify",
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		const agentId: AgentDefinitionId = newAgentDefinitionId();
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "reasoning-verify-agent",
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "b".repeat(64),
			createdAt: now,
			updatedAt: now,
		});
		appId = newPublishedAppId();
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: "pub_reasoning_verify",
			name: "Reasoning Verify",
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
			runtimeSpec: { frozen: true },
			runtimeSpecHash: "c".repeat(64),
			createdAt: now,
			publishedAt: now,
			status: "ready",
			validationErrors: [],
		});
		principalId = newPrincipalId();
		await repos.principals.upsert({
			principalId,
			tenantId,
			publishedAppId: appId,
			principalType: "anonymous_visitor",
			subjectHash: "d".repeat(64),
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
			title: "reasoning-verify",
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

	async function get() {
		return repos.conversationReasoning.get({ tenantId, publishedAppId: appId, principalId }, conversationId);
	}

	test("get before any write returns undefined", async () => {
		expect(await get()).toBeUndefined();
	});

	test("upsert then get round-trips a reasoned effort; scoped read", async () => {
		await repos.conversationReasoning.upsert({
			conversationId,
			tenantId,
			publishedAppId: appId,
			ownerPrincipalId: principalId,
			effort: "high",
			updatedBy: "admin-1",
			requestId: "00000000-0000-0000-0000-000000000001" as never,
			updatedAt: new Date(),
		});
		const got = await get();
		expect(got?.effort).toBe("high");
		expect(got?.conversationId).toBe(conversationId);
	});

	test("clearing effort (null) updates the fact source", async () => {
		await repos.conversationReasoning.upsert({
			conversationId,
			tenantId,
			publishedAppId: appId,
			ownerPrincipalId: principalId,
			effort: null,
			updatedBy: "admin-2",
			requestId: "00000000-0000-0000-0000-000000000002" as never,
			updatedAt: new Date(),
		});
		const got = await get();
		expect(got?.effort).toBeNull();
		expect(got?.updatedBy).toBe("admin-2");
	});
});

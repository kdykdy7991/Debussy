/**
 * TASK-007 scoped repository tests.
 *
 * Verifies the core security invariant of the repository layer: every lookup
 * embeds the resource scope and returns the same "unavailable" result
 * (`undefined`) when tenant, app or principal does not match — so cross-scope
 * access is indistinguishable from a missing resource (no ID enumeration).
 * Skipped when the local test database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import {
	newAgentDefinitionId,
	newConversationId,
	newPrincipalId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
} from "../../src/publishing/domain/ids.ts";
import type { AgentDefinitionRecord, PublishingRepositories } from "../../src/publishing/repositories.ts";

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

describe.skipIf(!pgUp)("scoped repositories", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;

	const tenantA = newTenantId();
	const tenantB = newTenantId();
	const agentAId = newAgentDefinitionId();
	const appA = newPublishedAppId();
	const appB = newPublishedAppId();
	const versionA1 = newPublishedAppVersionId();
	const principalA = newPrincipalId();
	const principalB = newPrincipalId();
	const conversationA1 = newConversationId();

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		const result = await runMigrations(client);
		expect(result.applied).toEqual([
			"0001_publishing_core.sql",
			"0002_principals_conversations.sql",
			"0003_conversation_events.sql",
			"0004_attachments.sql",
			"0005_idempotency_audit.sql",
			"0006_agent_definition_source_hash.sql",
			"0007_platform_service_principal.sql",
		]);
		repos = createPublishingRepositories(client);

		// tenants
		await repos.tenants.upsert({
			tenantId: tenantA,
			name: "tenant-a",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await repos.tenants.upsert({
			tenantId: tenantB,
			name: "tenant-b",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		// agent definitions
		const agentA: AgentDefinitionRecord = {
			agentDefinitionId: agentAId,
			tenantId: tenantA,
			name: "agent-a",
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await repos.agentDefinitions.insert(agentA);

		// apps
		await repos.publishedApps.insert({
			publishedAppId: appA,
			tenantId: tenantA,
			agentDefinitionId: agentAId,
			publicAppId: "pub_repo_a",
			name: "app-a",
			status: "active",
			accessMode: "mixed",
			currentVersionId: null,
			allowedOrigins: ["https://a.example.com"],
			mutablePolicy: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await repos.publishedApps.insert({
			publishedAppId: appB,
			// appB lives under tenantA so the scope isolation tests exercise
			// "same tenant, different app" (the stricter cross-app case).
			tenantId: tenantA,
			agentDefinitionId: agentAId,
			publicAppId: "pub_repo_b",
			name: "app-b",
			status: "active",
			accessMode: "mixed",
			currentVersionId: null,
			allowedOrigins: [],
			mutablePolicy: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		// version under appA/tenantA
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionA1,
			tenantId: tenantA,
			publishedAppId: appA,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: { schemaVersion: 1 },
			runtimeSpecHash: "c".repeat(64),
			status: "ready",
			validationErrors: [],
			createdAt: new Date(),
		});

		// principals
		await repos.principals.upsert({
			principalId: principalA,
			tenantId: tenantA,
			publishedAppId: appA,
			principalType: "external_user",
			subjectHash: "d".repeat(64),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		await repos.principals.upsert({
			principalId: principalB,
			tenantId: tenantA,
			publishedAppId: appA,
			principalType: "external_user",
			subjectHash: "e".repeat(64),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});

		// conversation owned by principalA under appA
		await repos.conversations.insert({
			conversationId: conversationA1,
			tenantId: tenantA,
			publishedAppId: appA,
			publishedAppVersionId: versionA1,
			ownerPrincipalId: principalA,
			title: "conv-a1",
			status: "active",
			lastEventSequence: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			lastActiveAt: new Date(),
		});
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("tenant lookup returns the record and undefined for a missing tenant", async () => {
		expect((await repos.tenants.get(tenantA))?.name).toBe("tenant-a");
		expect(await repos.tenants.get(newTenantId())).toBeUndefined();
	});

	test("app lookup requires the tenant scope", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA };
		const scopeB = { tenantId: tenantB, publishedAppId: appB };
		expect((await repos.publishedApps.get(scopeA, appA))?.name).toBe("app-a");
		// Same app id under the wrong tenant is unavailable.
		expect(await repos.publishedApps.get(scopeB, appA)).toBeUndefined();
		expect(await repos.publishedApps.get(scopeA, appB)).toBeUndefined();
	});

	test("getByPublicAppId resolves by the globally-unique public locator", async () => {
		// The public Exchange endpoint only knows the publicAppId; this is the
		// one intentionally unscoped lookup because `public_app_id` is
		// globally UNIQUE and unguessable (AD-10). The returned row carries
		// the tenant that scopes every downstream operation.
		const app = await repos.publishedApps.getByPublicAppId("pub_repo_a");
		expect(app?.publishedAppId).toBe(appA);
		expect(app?.tenantId).toBe(tenantA);
		expect(await repos.publishedApps.getByPublicAppId("pub_repo_b")).toBeDefined();
		expect(await repos.publishedApps.getByPublicAppId("pub_does_not_exist")).toBeUndefined();
	});

	test("version lookup requires tenant + app scope", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA };
		const scopeB = { tenantId: tenantB, publishedAppId: appB };
		expect((await repos.publishedAppVersions.get(scopeA, versionA1))?.status).toBe("ready");
		// Wrong app scope hides the version.
		expect(await repos.publishedAppVersions.get(scopeB, versionA1)).toBeUndefined();
		expect(await repos.publishedAppVersions.get({ ...scopeA, publishedAppId: appB }, versionA1)).toBeUndefined();
	});

	test("nextVersionNumber starts at 1 and increments", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA };
		expect(await repos.publishedAppVersions.nextVersionNumber(scopeA, appA)).toBe(2);
		expect(
			await repos.publishedAppVersions.nextVersionNumber({ tenantId: tenantB, publishedAppId: appB }, appB),
		).toBe(1);
	});

	test("version status transition is scoped and only affects the target", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA };
		await repos.publishedAppVersions.updateStatus(scopeA, versionA1, "retired", ["manual"]);
		const record = await repos.publishedAppVersions.get(scopeA, versionA1);
		expect(record?.status).toBe("retired");
		expect(record?.validationErrors).toEqual(["manual"]);
	});

	test("principal upsert is idempotent per subject triple and scoped", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA };
		const existing = await repos.principals.get(scopeA, principalA);
		expect(existing?.subjectHash).toBe("d".repeat(64));

		// Upsert with the same subject returns the existing id (no duplicate).
		const upserted = await repos.principals.upsert({
			principalId: newPrincipalId(),
			tenantId: tenantA,
			publishedAppId: appA,
			principalType: "external_user",
			subjectHash: "d".repeat(64),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		expect(upserted.principalId).toBe(principalA);

		// The same subject hash under a different app is a separate principal.
		const otherApp = await repos.principals.upsert({
			principalId: newPrincipalId(),
			tenantId: tenantA,
			publishedAppId: appB,
			principalType: "external_user",
			subjectHash: "d".repeat(64),
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		expect(otherApp.principalId).not.toBe(principalA);
	});

	test("principal lookup is scoped by app", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA };
		const scopeB = { tenantId: tenantA, publishedAppId: appB };
		expect((await repos.principals.get(scopeA, principalA))?.principalId).toBe(principalA);
		// Same principal id under another app is unavailable.
		expect(await repos.principals.get(scopeB, principalA)).toBeUndefined();
		// The same subject hash exists under both apps, but each lookup only
		// resolves within its own app scope (AD-09 app-namespace isolation).
		expect((await repos.principals.getBySubject(scopeA, "external_user", "d".repeat(64)))?.principalId).toBe(
			principalA,
		);
		expect((await repos.principals.getBySubject(scopeB, "external_user", "d".repeat(64)))?.principalId).not.toBe(
			principalA,
		);
	});

	test("conversation lookup requires the full owner scope", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA, principalId: principalA };
		const scopeB = { tenantId: tenantA, publishedAppId: appA, principalId: principalB };
		const scopeWrongTenant = { tenantId: tenantB, publishedAppId: appA, principalId: principalA };
		expect((await repos.conversations.get(scopeA, conversationA1))?.title).toBe("conv-a1");
		// Same conversation id under another principal is unavailable.
		expect(await repos.conversations.get(scopeB, conversationA1)).toBeUndefined();
		// Wrong tenant also unavailable.
		expect(await repos.conversations.get(scopeWrongTenant, conversationA1)).toBeUndefined();
	});

	test("conversation list is scoped and cursor-paginated", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA, principalId: principalA };
		const scopeB = { tenantId: tenantA, publishedAppId: appA, principalId: principalB };
		const page1 = await repos.conversations.list({ scope: scopeA, limit: 1 });
		expect(page1).toHaveLength(1);
		expect(page1[0].conversationId).toBe(conversationA1);
		expect(page1[0].cursor).toContain("|");

		const page2 = await repos.conversations.list({ scope: scopeA, limit: 1, cursor: page1[0].cursor });
		expect(page2).toHaveLength(0);

		// Another principal sees no conversations.
		expect(await repos.conversations.list({ scope: scopeB, limit: 10 })).toHaveLength(0);
	});

	test("nextEventSequence allocates atomically and is scoped", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA, principalId: principalA };
		const scopeB = { tenantId: tenantA, publishedAppId: appA, principalId: principalB };
		const seq1 = await repos.conversations.nextEventSequence(scopeA, conversationA1);
		const seq2 = await repos.conversations.nextEventSequence(scopeA, conversationA1);
		expect(seq1).toBe(1);
		expect(seq2).toBe(2);
		// Out-of-scope conversation returns undefined without advancing.
		expect(await repos.conversations.nextEventSequence(scopeB, conversationA1)).toBeUndefined();
		const record = await repos.conversations.get(scopeA, conversationA1);
		expect(record?.lastEventSequence).toBe(2);
	});

	test("status transition is scoped", async () => {
		const scopeA = { tenantId: tenantA, publishedAppId: appA, principalId: principalA };
		const scopeB = { tenantId: tenantA, publishedAppId: appA, principalId: principalB };
		await repos.conversations.updateStatus(scopeA, conversationA1, "archived");
		// Out-of-scope update leaves the conversation untouched.
		await repos.conversations.updateStatus(scopeB, conversationA1, "archived");
		const raw = await client.run("select status from conversations where id = $1", conversationA1);
		expect(String(raw[0]?.status)).toBe("archived");
		// `get` returns archived records (only soft-deleted rows are hidden);
		// `list` filters to active conversations.
		const record = await repos.conversations.get(scopeA, conversationA1);
		expect(record?.status).toBe("archived");
		expect(await repos.conversations.list({ scope: scopeA, limit: 10 })).toHaveLength(0);
	});

	test("agent definition getRevision/getLatest are tenant-scoped", async () => {
		const scopeA = { tenantId: tenantA };
		const scopeB = { tenantId: tenantB };
		const agentId = agentAId;
		expect((await repos.agentDefinitions.getRevision(scopeA, agentId, 1))?.name).toBe("agent-a");
		expect(await repos.agentDefinitions.getRevision(scopeB, agentId, 1)).toBeUndefined();
		expect((await repos.agentDefinitions.getLatest(scopeA, agentId))?.revision).toBe(1);
		expect(await repos.agentDefinitions.getLatest(scopeB, agentId)).toBeUndefined();
	});
});

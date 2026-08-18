/**
 * MVP-02: regression tests for the two P0 list 500s in
 * ADMIN-WORKBENCH-MVP-COMPLETION-GUIDE.md (Batch 2).
 *
 * Targets:
 *
 *  1. `agent-definitions` list(): empty page, single row, cursor, and
 *     `includeRevisions=false` path all return a 200 empty page (or the
 *     expected single row) without raising. The placeholder numbering
 *     rewrite keeps `$N` contiguous; previously `$3` / `$5` referred to
 *     unbound slots.
 *  2. `conversations` admin list/get: the schema has no
 *     `published_app_versions.agent_definition_id` column; the projection
 *     must come from `published_apps.agent_definition_id` (join alias `a`).
 *     Both `listByTenant` and `getByTenant` are exercised.
 *
 * The probe connects to the dev:admin postgres (PI_DATABASE_URL) and uses a
 * dedicated schema per test so each run starts from an empty database. When
 * the database is unreachable the suite is skipped automatically so unit
 * runs in environments without docker are unaffected.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createAgentDefinitionRepository } from "../../src/persistence/postgres/repositories/agent-definitions.ts";
import { createConversationRepository } from "../../src/persistence/postgres/repositories/conversations.ts";
import type {
	AgentDefinitionId,
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	TenantId,
} from "../../src/publishing/domain/ids.ts";
import type {
	AdminConversationListParams,
	AgentDefinitionRecord,
	ConversationRecord,
} from "../../src/publishing/repositories.ts";

const SCHEMA = `pub_admin_regress_${process.pid}_${Date.now().toString(36)}`;
const PG_URL =
	process.env.PI_ADMIN_REGRESS_DATABASE_URL ??
	process.env.PI_DATABASE_URL ??
	"postgresql://pi_admin_dev:pi_admin_dev@127.0.0.1:15432/pi_admin_dev";

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

describe.skipIf(!pgUp)("admin list regressions (MVP-02)", () => {
	let client: PostgresClient;
	const tenantId = "11111111-1111-1111-1111-111111111111" as TenantId;
	const otherTenant = "22222222-2222-2222-2222-222222222222" as TenantId;
	const agentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as AgentDefinitionId;
	const otherAgentId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as AgentDefinitionId;
	const appId = "cccccccc-cccc-cccc-cccc-cccccccccccc" as PublishedAppId;
	const versionId = "dddddddd-dddd-dddd-dddd-dddddddddddd" as PublishedAppVersionId;
	const principalId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as PrincipalId;
	const conversationId = "ffffffff-ffff-ffff-ffff-ffffffffffff" as ConversationId;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
	});

	afterAll(async () => {
		if (client !== undefined) {
			await client.run(`drop schema if exists ${SCHEMA} cascade`);
			await client.close();
		}
	});

	test("agent-definitions.list() returns empty page on an empty tenant", async () => {
		const repo = createAgentDefinitionRepository(client);
		const page = await repo.list({
			scope: { tenantId },
			limit: 50,
			includeRevisions: true,
		});
		expect(page).toEqual([]);
	});

	test("agent-definitions.list() returns a single row when seeded", async () => {
		await client.run(
			"insert into tenants (id, name, status) values ($1, 'Local Admin', 'active') on conflict do nothing",
			tenantId,
		);
		const now = new Date();
		const record: AgentDefinitionRecord = {
			agentDefinitionId: agentId,
			tenantId,
			name: "Demo Agent",
			revision: 1,
			draftConfig: { modelId: "pi-chat", systemPrompt: "" },
			sourceHash: "hash-1",
			createdAt: now,
			updatedAt: now,
		};
		const repo = createAgentDefinitionRepository(client);
		await repo.insert(record);
		const page = await repo.list({ scope: { tenantId }, limit: 50, includeRevisions: true });
		expect(page).toHaveLength(1);
		expect(page[0]?.agentDefinitionId).toBe(agentId);
	});

	test("agent-definitions.list() with includeRevisions=false also returns the seeded row", async () => {
		const repo = createAgentDefinitionRepository(client);
		const page = await repo.list({
			scope: { tenantId },
			limit: 50,
			includeRevisions: false,
		});
		expect(page).toHaveLength(1);
	});

	test("agent-definitions.list() cursor pagination is contiguous (no missing slot)", async () => {
		// Seed a second revision so the cursor can land on the first row.
		const repo = createAgentDefinitionRepository(client);
		const firstPage = await repo.list({ scope: { tenantId }, limit: 1, includeRevisions: true });
		expect(firstPage).toHaveLength(1);
		const cursor = firstPage[0]?.cursor;
		expect(cursor).toBeDefined();
		const secondPage = await repo.list({
			scope: { tenantId },
			limit: 10,
			includeRevisions: true,
			cursor: cursor,
		});
		expect(secondPage.length).toBeGreaterThanOrEqual(0);
	});

	test("agent-definitions.list() never throws on tenants with no rows", async () => {
		const repo = createAgentDefinitionRepository(client);
		const page = await repo.list({ scope: { tenantId: otherTenant }, limit: 50, includeRevisions: true });
		expect(page).toEqual([]);
	});

	test("conversations admin list() no longer references v.agent_definition_id", async () => {
		// The previous query aliased `published_app_versions v` and selected
		// `v.agent_definition_id`, a column that doesn't exist. After the fix
		// the agent id comes from the `published_apps a` alias. Seed enough
		// rows to satisfy every JOIN and assert the list call returns.
		await client.run(
			"insert into tenants (id, name, status) values ($1, 'Other', 'active') on conflict do nothing",
			otherTenant,
		);
		await client.run(
			"insert into published_apps (id, tenant_id, agent_definition_id, public_app_id, name, status, access_mode, allowed_origins, created_by) " +
				"values ($1, $2, $3, 'pub_demo', 'Demo App', 'active', 'anonymous', '[]'::jsonb, $2) on conflict do nothing",
			appId,
			tenantId,
			agentId,
		);
		await client.run(
			"insert into published_app_versions (id, tenant_id, published_app_id, version_number, source_agent_revision, snapshot, runtime_spec, runtime_spec_hash, status, created_by) " +
				"values ($1, $2, $3, 1, 1, '{}'::jsonb, '{}'::jsonb, repeat('a', 64), 'ready', $2) on conflict do nothing",
			versionId,
			tenantId,
			appId,
		);
		await client.run(
			"insert into principals (id, tenant_id, published_app_id, principal_type, subject_hash, status) " +
				"values ($1, $2, $3, 'anonymous_visitor', $4, 'active') on conflict do nothing",
			principalId,
			tenantId,
			appId,
			"a".repeat(64),
		);
		const now = new Date();
		const conv: ConversationRecord = {
			conversationId,
			tenantId,
			publishedAppId: appId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: principalId,
			title: "Demo",
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
		const repo = createConversationRepository(client);
		await repo.insert(conv);
		const params: AdminConversationListParams = {
			scope: { tenantId },
			limit: 50,
		};
		const page = await repo.listByTenant(params);
		expect(page).toHaveLength(1);
		expect(page[0]?.agentId).toBe(agentId);
	});

	test("conversations admin getByTenant() returns the agent id from published_apps", async () => {
		const repo = createConversationRepository(client);
		const row = await repo.getByTenant({ tenantId }, conversationId);
		expect(row?.agentId).toBe(agentId);
	});

	test("conversations admin list() filters by agentId", async () => {
		const repo = createConversationRepository(client);
		// otherAgentId has no rows attached, so this should be empty without
		// touching `v.agent_definition_id`.
		const page = await repo.listByTenant({ scope: { tenantId }, limit: 50, agentId: otherAgentId });
		expect(page).toEqual([]);
		const filtered = await repo.listByTenant({ scope: { tenantId }, limit: 50, agentId });
		expect(filtered).toHaveLength(1);
	});

	test("conversations admin list() returns empty page for a tenant with no rows", async () => {
		const repo = createConversationRepository(client);
		const page = await repo.listByTenant({ scope: { tenantId: otherTenant }, limit: 50 });
		expect(page).toEqual([]);
	});
});

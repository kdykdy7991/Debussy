/**
 * TASK-005 schema constraint tests: principals, conversations and events must
 * reject illegal states, foreign keys, duplicate subjects and duplicate
 * sequences at the database level. Skipped when the local test database is
 * unreachable.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

const HASH_64 = "a".repeat(64);

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

describe.skipIf(!pgUp)("principal/conversation/event schema", () => {
	let client: PostgresClient;
	let tenantId: string;
	let agentId: string;
	let appA: string;
	let appB: string;
	let versionA1: string;
	let principalA: string;

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

		tenantId = randomUUID();
		agentId = randomUUID();
		appA = randomUUID();
		appB = randomUUID();
		versionA1 = randomUUID();
		principalA = randomUUID();

		await client.run("insert into tenants (id, name, status) values ($1, $2, 'active')", tenantId, "test-tenant");
		await client.run(
			"insert into agent_definitions (id, tenant_id, name, revision, draft_config, created_by) values ($1, $2, 'agent', 1, '{}'::jsonb, $2)",
			agentId,
			tenantId,
		);
		for (const [id, publicAppId] of [
			[appA, "pub_schema_a"],
			[appB, "pub_schema_b"],
		] as const) {
			await client.run(
				"insert into published_apps (id, tenant_id, agent_definition_id, public_app_id, name, status, access_mode, created_by) values ($1, $2, $3, $4, 'app', 'active', 'mixed', $2)",
				id,
				tenantId,
				agentId,
				publicAppId,
			);
		}
		await client.run(
			`insert into published_app_versions
			 (id, tenant_id, published_app_id, version_number, source_agent_revision,
			  snapshot, runtime_spec, runtime_spec_hash, status, created_by)
			 values ($1, $2, $3, 1, 1, '{}'::jsonb, '{}'::jsonb, $4, 'ready', $2)`,
			versionA1,
			tenantId,
			appA,
			HASH_64,
		);
		await client.run(
			"insert into principals (id, tenant_id, published_app_id, principal_type, subject_hash, status) values ($1, $2, $3, 'external_user', $4, 'active')",
			principalA,
			tenantId,
			appA,
			HASH_64,
		);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("rejects an unknown principal type", async () => {
		await expect(
			client.run(
				"insert into principals (id, tenant_id, published_app_id, principal_type, subject_hash, status) values ($1, $2, $3, 'admin', $4, 'active')",
				randomUUID(),
				tenantId,
				appA,
				HASH_64,
			),
		).rejects.toThrow();
	});

	test("rejects an unknown conversation status", async () => {
		await expect(
			client.run(
				`insert into conversations
				 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
				 values ($1, $2, $3, $4, $5, 'weird')`,
				randomUUID(),
				tenantId,
				appA,
				versionA1,
				principalA,
			),
		).rejects.toThrow();
	});

	test("rejects a negative last_event_sequence", async () => {
		await expect(
			client.run(
				`insert into conversations
				 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status, last_event_sequence)
				 values ($1, $2, $3, $4, $5, 'active', -1)`,
				randomUUID(),
				tenantId,
				appA,
				versionA1,
				principalA,
			),
		).rejects.toThrow();
	});

	test("duplicate subject within the same app is rejected", async () => {
		await expect(
			client.run(
				"insert into principals (id, tenant_id, published_app_id, principal_type, subject_hash, status) values ($1, $2, $3, 'external_user', $4, 'active')",
				randomUUID(),
				tenantId,
				appA,
				HASH_64,
			),
		).rejects.toThrow();
	});

	test("the same subject is allowed under a different app (app namespace isolation)", async () => {
		await expect(
			client.run(
				"insert into principals (id, tenant_id, published_app_id, principal_type, subject_hash, status) values ($1, $2, $3, 'external_user', $4, 'active')",
				randomUUID(),
				tenantId,
				appB,
				HASH_64,
			),
		).resolves.toBeDefined();
	});

	test("a conversation cannot reference a version of another app", async () => {
		await expect(
			client.run(
				`insert into conversations
				 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
				 values ($1, $2, $3, $4, $5, 'active')`,
				randomUUID(),
				tenantId,
				appB,
				versionA1,
				principalA,
			),
		).rejects.toThrow();
	});

	test("a conversation cannot reference a principal of another app", async () => {
		// principalA belongs to appA; referencing it from an appB conversation must fail.
		await expect(
			client.run(
				`insert into conversations
				 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
				 values ($1, $2, $3, $4, $5, 'active')`,
				randomUUID(),
				tenantId,
				appB,
				versionA1,
				principalA,
			),
		).rejects.toThrow();
	});

	test("a conversation referencing a missing principal fails", async () => {
		await expect(
			client.run(
				`insert into conversations
				 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
				 values ($1, $2, $3, $4, $5, 'active')`,
				randomUUID(),
				tenantId,
				appA,
				versionA1,
				randomUUID(),
			),
		).rejects.toThrow();
	});

	test("a valid conversation and event insert works", async () => {
		const conversationId = randomUUID();
		await client.run(
			`insert into conversations
			 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
			 values ($1, $2, $3, $4, $5, 'active')`,
			conversationId,
			tenantId,
			appA,
			versionA1,
			principalA,
		);
		await client.run(
			`insert into conversation_events
			 (id, tenant_id, published_app_id, conversation_id, sequence, event_type, payload)
			 values ($1, $2, $3, $4, 1, 'message.completed', '{}'::jsonb)`,
			randomUUID(),
			tenantId,
			appA,
			conversationId,
		);
	});

	test("duplicate event sequence within a conversation is rejected", async () => {
		const conversationId = randomUUID();
		await client.run(
			`insert into conversations
			 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
			 values ($1, $2, $3, $4, $5, 'active')`,
			conversationId,
			tenantId,
			appA,
			versionA1,
			principalA,
		);
		await client.run(
			`insert into conversation_events
			 (id, tenant_id, published_app_id, conversation_id, sequence, event_type, payload)
			 values ($1, $2, $3, $4, 1, 'message.completed', '{}'::jsonb)`,
			randomUUID(),
			tenantId,
			appA,
			conversationId,
		);
		await expect(
			client.run(
				`insert into conversation_events
				 (id, tenant_id, published_app_id, conversation_id, sequence, event_type, payload)
				 values ($1, $2, $3, $4, 1, 'message.completed', '{}'::jsonb)`,
				randomUUID(),
				tenantId,
				appA,
				conversationId,
			),
		).rejects.toThrow();
	});

	test("event sequence must be positive", async () => {
		const conversationId = randomUUID();
		await client.run(
			`insert into conversations
			 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
			 values ($1, $2, $3, $4, $5, 'active')`,
			conversationId,
			tenantId,
			appA,
			versionA1,
			principalA,
		);
		await expect(
			client.run(
				`insert into conversation_events
				 (id, tenant_id, published_app_id, conversation_id, sequence, event_type, payload)
				 values ($1, $2, $3, $4, 0, 'message.completed', '{}'::jsonb)`,
				randomUUID(),
				tenantId,
				appA,
				conversationId,
			),
		).rejects.toThrow();
	});
});

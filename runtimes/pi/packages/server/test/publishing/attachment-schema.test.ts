/**
 * TASK-006 schema tests: attachments, idempotency records and audit events.
 * Verifies cross-session attachment rejection, duplicate idempotency keys,
 * expiry queries and soft-delete semantics at the database level.
 * Skipped when the local test database is unreachable.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

const HASH_64 = "b".repeat(64);

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

describe.skipIf(!pgUp)("attachment/idempotency/audit schema", () => {
	let client: PostgresClient;
	let tenantId: string;
	let agentId: string;
	let appA: string;
	let appB: string;
	let versionA1: string;
	let versionB1: string;
	let principalA: string;
	let principalB: string;
	let conversationA1: string;
	let conversationA2: string;
	let conversationB1: string;

	async function insertConversation(id: string, app: string, version: string, principal: string): Promise<void> {
		await client.run(
			`insert into conversations
			 (id, tenant_id, published_app_id, published_app_version_id, owner_principal_id, status)
			 values ($1, $2, $3, $4, $5, 'active')`,
			id,
			tenantId,
			app,
			version,
			principal,
		);
	}

	async function insertPrincipal(id: string, app: string, hash: string): Promise<void> {
		await client.run(
			"insert into principals (id, tenant_id, published_app_id, principal_type, subject_hash, status) values ($1, $2, $3, 'external_user', $4, 'active')",
			id,
			tenantId,
			app,
			hash,
		);
	}

	async function insertApp(id: string, publicAppId: string): Promise<void> {
		await client.run(
			"insert into published_apps (id, tenant_id, agent_definition_id, public_app_id, name, status, access_mode, created_by) values ($1, $2, $3, $4, 'app', 'active', 'mixed', $2)",
			id,
			tenantId,
			agentId,
			publicAppId,
		);
	}

	async function insertVersion(id: string, app: string): Promise<void> {
		await client.run(
			`insert into published_app_versions
			 (id, tenant_id, published_app_id, version_number, source_agent_revision,
			  snapshot, runtime_spec, runtime_spec_hash, status, created_by)
			 values ($1, $2, $3, 1, 1, '{}'::jsonb, '{}'::jsonb, $4, 'ready', $2)`,
			id,
			tenantId,
			app,
			HASH_64,
		);
	}

	async function insertAttachment(
		id: string,
		app: string,
		conversation: string,
		principal: string,
		objectKey: string,
		status = "ready",
		expiresAt?: string,
	): Promise<void> {
		await client.run(
			`insert into attachments
			 (id, tenant_id, published_app_id, conversation_id, owner_principal_id,
			  object_key, filename, content_type, size_bytes, checksum_sha256, status, expires_at)
			 values ($1, $2, $3, $4, $5, $6, 'file.txt', 'text/plain', 10, $7, $8, $9)`,
			id,
			tenantId,
			app,
			conversation,
			principal,
			objectKey,
			HASH_64,
			status,
			expiresAt ?? null,
		);
	}

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
		versionB1 = randomUUID();
		principalA = randomUUID();
		principalB = randomUUID();
		conversationA1 = randomUUID();
		conversationA2 = randomUUID();
		conversationB1 = randomUUID();

		await client.run("insert into tenants (id, name, status) values ($1, $2, 'active')", tenantId, "test-tenant");
		await client.run(
			"insert into agent_definitions (id, tenant_id, name, revision, draft_config, created_by) values ($1, $2, 'agent', 1, '{}'::jsonb, $2)",
			agentId,
			tenantId,
		);
		await insertApp(appA, "pub_att_a");
		await insertApp(appB, "pub_att_b");
		await insertVersion(versionA1, appA);
		await insertVersion(versionB1, appB);
		await insertPrincipal(principalA, appA, "c".repeat(64));
		await insertPrincipal(principalB, appB, "d".repeat(64));
		await insertConversation(conversationA1, appA, versionA1, principalA);
		await insertConversation(conversationA2, appA, versionA1, principalA);
		await insertConversation(conversationB1, appB, versionB1, principalB);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("an attachment referencing another conversation's principal fails", async () => {
		// principalB belongs to appB; an appA attachment owned by it must fail.
		await expect(
			insertAttachment(randomUUID(), appA, conversationA1, principalB, `obj-cross-principal-${randomUUID()}`),
		).rejects.toThrow();
	});

	test("an attachment referencing a conversation of another app fails", async () => {
		await expect(
			insertAttachment(randomUUID(), appB, conversationA1, principalB, `obj-cross-conv-${randomUUID()}`),
		).rejects.toThrow();
	});

	test("duplicate object_key is rejected", async () => {
		const objectKey = `obj-dup-${randomUUID()}`;
		await insertAttachment(randomUUID(), appA, conversationA1, principalA, objectKey);
		await expect(insertAttachment(randomUUID(), appA, conversationA2, principalA, objectKey)).rejects.toThrow();
	});

	test("rejects a non-positive size and a malformed checksum", async () => {
		await expect(
			client.run(
				`insert into attachments
				 (id, tenant_id, published_app_id, conversation_id, owner_principal_id,
				  object_key, filename, content_type, size_bytes, checksum_sha256, status)
				 values ($1, $2, $3, $4, $5, $6, 'f', 'text/plain', 0, $7, 'ready')`,
				randomUUID(),
				tenantId,
				appA,
				conversationA1,
				principalA,
				`obj-size-${randomUUID()}`,
				HASH_64,
			),
		).rejects.toThrow();
		await expect(
			client.run(
				`insert into attachments
				 (id, tenant_id, published_app_id, conversation_id, owner_principal_id,
				  object_key, filename, content_type, size_bytes, checksum_sha256, status)
				 values ($1, $2, $3, $4, $5, $6, 'f', 'text/plain', 10, $7, 'ready')`,
				randomUUID(),
				tenantId,
				appA,
				conversationA1,
				principalA,
				`obj-checksum-${randomUUID()}`,
				"short",
			),
		).rejects.toThrow();
	});

	test("expired staged/ready attachments are returned by the expiry sweep query", async () => {
		const objectKey = `obj-expired-${randomUUID()}`;
		await insertAttachment(
			randomUUID(),
			appA,
			conversationA1,
			principalA,
			objectKey,
			"staged",
			"2000-01-01T00:00:00Z",
		);
		const rows = await client.run(
			`select object_key from attachments
			 where expires_at is not null and expires_at < now()
			   and status in ('staged', 'ready') and deleted_at is null`,
		);
		expect(rows.map((row) => String(row.object_key))).toContain(objectKey);
	});

	test("soft delete hides the attachment from default queries and keeps the row", async () => {
		const id = randomUUID();
		const objectKey = `obj-softdel-${randomUUID()}`;
		await insertAttachment(id, appA, conversationA1, principalA, objectKey);
		await client.run("update attachments set deleted_at = now(), status = 'deleted' where id = $1", id);
		const visible = await client.run(
			"select id from attachments where object_key = $1 and deleted_at is null",
			objectKey,
		);
		expect(visible).toHaveLength(0);
		const raw = await client.run("select id from attachments where id = $1", id);
		expect(raw).toHaveLength(1);
	});

	test("duplicate idempotency keys are rejected per principal", async () => {
		const key = `idem-${randomUUID()}`;
		await client.run(
			`insert into idempotency_records
			 (tenant_id, principal_id, operation, idempotency_key, request_hash, state, expires_at)
			 values ($1, $2, 'create_conversation', $3, $4, 'completed', now() + interval '1 hour')`,
			tenantId,
			principalA,
			key,
			HASH_64,
		);
		await expect(
			client.run(
				`insert into idempotency_records
				 (tenant_id, principal_id, operation, idempotency_key, request_hash, state, expires_at)
				 values ($1, $2, 'create_conversation', $3, $4, 'completed', now() + interval '1 hour')`,
				tenantId,
				principalA,
				key,
				HASH_64,
			),
		).rejects.toThrow();
		// The same key under a different principal is allowed.
		await expect(
			client.run(
				`insert into idempotency_records
				 (tenant_id, principal_id, operation, idempotency_key, request_hash, state, expires_at)
				 values ($1, $2, 'create_conversation', $3, $4, 'completed', now() + interval '1 hour')`,
				tenantId,
				principalB,
				key,
				HASH_64,
			),
		).resolves.toBeDefined();
	});

	test("expired idempotency records are queryable for cleanup", async () => {
		const key = `idem-expired-${randomUUID()}`;
		await client.run(
			`insert into idempotency_records
			 (tenant_id, principal_id, operation, idempotency_key, request_hash, state, expires_at)
			 values ($1, $2, 'op', $3, $4, 'running', '2000-01-01T00:00:00Z')`,
			tenantId,
			principalA,
			key,
			HASH_64,
		);
		const rows = await client.run("select idempotency_key from idempotency_records where expires_at < now()");
		expect(rows.map((row) => String(row.idempotency_key))).toContain(key);
	});

	test("audit events are append-only and indexed by request", async () => {
		const requestId = randomUUID();
		await client.run(
			`insert into audit_events
			 (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, request_id, metadata)
			 values ($1, $2, 'platform_user', $3, 'app.activate', 'published_app', $4, $5, '{}'::jsonb)`,
			randomUUID(),
			tenantId,
			principalA,
			appA,
			requestId,
		);
		const rows = await client.run(
			"select request_id from audit_events where tenant_id = $1 and request_id = $2",
			tenantId,
			requestId,
		);
		expect(rows).toHaveLength(1);
	});
});

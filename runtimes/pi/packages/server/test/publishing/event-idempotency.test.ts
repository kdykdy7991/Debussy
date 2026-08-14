/**
 * TASK-008: atomic event append and idempotency records (spec 26.2/26.3).
 *
 * Verifies that sequence allocation and event insertion share one transaction
 * (50 concurrent appends produce a contiguous 1..50 with no holes, a failed
 * insert never advances the counter), and that idempotency slots are claimed
 * atomically: replay on same hash, 409 on different hash, in_progress while
 * running, and explicit stale-lock recovery for expired running slots.
 * Requires the local test database; skipped automatically when unreachable.
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
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";

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

describe.skipIf(!pgUp)("atomic event append + idempotency", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;

	const tenantId = newTenantId();
	const agentId = newAgentDefinitionId();
	const appId = newPublishedAppId();
	const versionId = newPublishedAppVersionId();
	const principalA = newPrincipalId();
	const principalB = newPrincipalId();
	const conversationA1 = newConversationId();

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);

		await repos.tenants.upsert({
			tenantId,
			name: "tenant-evt",
			status: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await repos.agentDefinitions.insert({
			agentDefinitionId: agentId,
			tenantId,
			name: "agent-evt",
			revision: 1,
			draftConfig: { prompt: "hi" },
			sourceHash: "a".repeat(64),
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await repos.publishedApps.insert({
			publishedAppId: appId,
			tenantId,
			agentDefinitionId: agentId,
			publicAppId: "pub_evt_a",
			name: "app-evt",
			status: "active",
			accessMode: "mixed",
			currentVersionId: null,
			allowedOrigins: [],
			mutablePolicy: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await repos.publishedAppVersions.insert({
			publishedAppVersionId: versionId,
			tenantId,
			publishedAppId: appId,
			versionNumber: 1,
			sourceAgentRevision: 1,
			snapshot: { prompt: "hi" },
			runtimeSpec: { schemaVersion: 1 },
			runtimeSpecHash: "a".repeat(64),
			status: "ready",
			validationErrors: [],
			createdAt: new Date(),
		});
		for (const principalId of [principalA, principalB]) {
			await repos.principals.upsert({
				principalId,
				tenantId,
				publishedAppId: appId,
				principalType: "external_user",
				subjectHash: `${principalId}${principalId}`.slice(0, 64),
				status: "active",
				createdAt: new Date(),
				lastSeenAt: new Date(),
			});
		}
		await repos.conversations.insert({
			conversationId: conversationA1,
			tenantId,
			publishedAppId: appId,
			publishedAppVersionId: versionId,
			ownerPrincipalId: principalA,
			title: "conv-evt",
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

	const scopeA = { tenantId, publishedAppId: appId, principalId: principalA };
	const scopeB = { tenantId, publishedAppId: appId, principalId: principalB };

	test("50 concurrent appends produce contiguous sequences 1..50", async () => {
		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				repos.events.append(scopeA, {
					conversationId: conversationA1,
					eventType: "user_message",
					payload: { n: i },
				}),
			),
		);
		expect(results.every((r) => r !== undefined)).toBe(true);
		const sequences = results.map((r) => r!.sequence).sort((a, b) => a - b);
		expect(sequences).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

		const conversation = await repos.conversations.get(scopeA, conversationA1);
		expect(conversation?.lastEventSequence).toBe(50);
		const listed = await repos.events.list(scopeA, conversationA1, { limit: 100 });
		expect(listed).toHaveLength(50);
		// Incremental replay sees nothing below the first sequence and
		// everything above a given point in ascending order.
		const tail = await repos.events.list(scopeA, conversationA1, { limit: 100, afterSequence: 48 });
		expect(tail.map((e) => e.sequence)).toEqual([49, 50]);
	});

	test("append to an out-of-scope conversation is unavailable and advances nothing", async () => {
		const before = (await repos.conversations.get(scopeA, conversationA1))?.lastEventSequence;
		const result = await repos.events.append(scopeB, {
			conversationId: conversationA1,
			eventType: "user_message",
			payload: {},
		});
		expect(result).toBeUndefined();
		expect((await repos.conversations.get(scopeA, conversationA1))?.lastEventSequence).toBe(before);
		const listed = await repos.events.list(scopeB, conversationA1, { limit: 10 });
		expect(listed).toHaveLength(0);
	});

	test("a failed insert rolls back the sequence bump (no hole, no advance)", async () => {
		// Occupy the next sequence slot by hand (bypassing the repository) so
		// the append's insert collides on (conversation_id, sequence) and the
		// whole transaction — including the sequence bump — must roll back.
		const before = (await repos.conversations.get(scopeA, conversationA1))?.lastEventSequence ?? 0;
		const next = before + 1;
		await client.run(
			`insert into conversation_events
			 (id, tenant_id, published_app_id, conversation_id, sequence, event_type, payload, created_at)
			 values ($1, $2, $3, $4, $5, 'system', '{}'::jsonb, now())`,
			"00000000-0000-7000-8000-000000000001",
			tenantId,
			appId,
			conversationA1,
			next,
		);
		await expect(
			repos.events.append(scopeA, { conversationId: conversationA1, eventType: "user_message", payload: {} }),
		).rejects.toThrow();
		expect((await repos.conversations.get(scopeA, conversationA1))?.lastEventSequence).toBe(before);
	});

	test("idempotency: claimed -> complete -> replay returns the stored response", async () => {
		const key = "idem-replay-1";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000)).outcome).toBe("claimed");
		await repos.idempotency.complete(iScope, op, key, 200, { reply: "ok" });
		const result = await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000);
		expect(result.outcome).toBe("replay");
		if (result.outcome === "replay") {
			expect(result.record.responseStatus).toBe(200);
			expect(result.record.responseBody).toEqual({ reply: "ok" });
		}
	});

	test("idempotency: same key with a different request hash is a conflict", async () => {
		const key = "idem-conflict-1";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000)).outcome).toBe("claimed");
		expect((await repos.idempotency.begin(iScope, op, key, "hash-b", 60_000)).outcome).toBe("conflict");
	});

	test("idempotency: a live running slot is in_progress", async () => {
		const key = "idem-running-1";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000)).outcome).toBe("claimed");
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000)).outcome).toBe("in_progress");
	});

	test("idempotency: an expired running slot is reclaimed on retry", async () => {
		const key = "idem-stale-1";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 30)).outcome).toBe("claimed");
		await new Promise((resolve) => setTimeout(resolve, 80));
		const retry = await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000);
		expect(retry.outcome).toBe("claimed");
		// The reclaimed slot executes fresh: complete then replay works.
		await repos.idempotency.complete(iScope, op, key, 200, { reply: "second" });
		const replay = await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000);
		expect(replay.outcome).toBe("replay");
	});

	test("idempotency: sweepExpired reclaims only expired running slots", async () => {
		const keyLive = "idem-sweep-live";
		const keyStale = "idem-sweep-stale";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		await repos.idempotency.begin(iScope, op, keyLive, "hash-a", 60_000);
		await repos.idempotency.begin(iScope, op, keyStale, "hash-a", 30);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const swept = await repos.idempotency.sweepExpired(iScope);
		expect(swept).toBe(1);
		// Live slot untouched, stale slot retryable.
		expect((await repos.idempotency.begin(iScope, op, keyLive, "hash-a", 60_000)).outcome).toBe("in_progress");
		expect((await repos.idempotency.begin(iScope, op, keyStale, "hash-a", 60_000)).outcome).toBe("claimed");
	});

	test("idempotency: concurrent reclaimers of one expired slot: exactly one wins", async () => {
		const key = "idem-race-1";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 30)).outcome).toBe("claimed");
		await new Promise((resolve) => setTimeout(resolve, 80));
		const outcomes = await Promise.all([
			repos.idempotency.begin(iScope, op, key, "hash-a", 60_000),
			repos.idempotency.begin(iScope, op, key, "hash-a", 60_000),
			repos.idempotency.begin(iScope, op, key, "hash-a", 60_000),
		]);
		const claimed = outcomes.filter((o) => o.outcome === "claimed").length;
		expect(claimed).toBe(1);
		expect(outcomes.filter((o) => o.outcome === "in_progress").length).toBe(2);
	});

	test("idempotency: a failed slot can be retried with the same hash", async () => {
		const key = "idem-failed-1";
		const op = "turn.create";
		const iScope = { tenantId, principalId: principalA };
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000)).outcome).toBe("claimed");
		await repos.idempotency.fail(iScope, op, key);
		expect((await repos.idempotency.begin(iScope, op, key, "hash-a", 60_000)).outcome).toBe("claimed");
	});
});

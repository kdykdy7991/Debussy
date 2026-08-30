import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresClient } from "../src/persistence/postgres/client.ts";
import { runMigrations } from "../src/persistence/postgres/migrate.ts";
import { createDebugRepositories } from "../src/persistence/postgres/repositories/debug.ts";
import type { DebugRepositories } from "../src/publishing/debug/types.ts";
import { newDebugConversationId, newPrincipalId, newTenantId, newTurnId } from "../src/publishing/domain/ids.ts";

const SCHEMA = `pi_debug_gc_${process.pid}_${Date.now().toString(36)}`;
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

describe.skipIf(!pgUp)("DebugConversation lifecycle repository (Phase 2F)", () => {
	let client: PostgresClient;
	let repos: DebugRepositories;
	const tenantId = newTenantId();
	const owner = newPrincipalId();

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createDebugRepositories(client);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`).catch(() => {});
		await client.close();
	});

	function insertConversation(id = newDebugConversationId(), oldDays = 2) {
		const createdAt = new Date(Date.now() - oldDays * 24 * 60 * 60 * 1_000);
		return repos.conversations.insert({
			debugConversationId: id,
			tenantId,
			agentId: null,
			ownerPrincipalId: owner,
			status: "active",
			lastEventSequence: 0,
			createdAt,
			lastActiveAt: createdAt,
			deletedAt: null,
		});
	}

	it("expire-then-append: a soft-deleted conversation can no longer append (exactly one wins — GC)", async () => {
		const conv = newDebugConversationId();
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
		await repos.conversations.insert({
			debugConversationId: conv,
			tenantId,
			agentId: null,
			ownerPrincipalId: owner,
			status: "active",
			lastEventSequence: 0,
			createdAt: old,
			lastActiveAt: old,
			deletedAt: null,
		});
		const expired = await repos.conversations.expireActiveBefore(
			{ tenantId, ownerPrincipalId: owner },
			new Date(Date.now() - 24 * 60 * 60 * 1_000),
		);
		expect(expired).toContain(conv);
		const appended = await repos.events.append(
			{ tenantId, ownerPrincipalId: owner, debugConversationId: conv },
			conv,
			{
				eventType: "turn/start",
				turnId: newTurnId(),
				payload: {},
			},
		);
		expect(appended).toBeUndefined();
	});

	it("append-then-expire: a Turn that just appended is not expired (exactly one wins — Turn)", async () => {
		const conv = newDebugConversationId();
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
		await repos.conversations.insert({
			debugConversationId: conv,
			tenantId,
			agentId: null,
			ownerPrincipalId: owner,
			status: "active",
			lastEventSequence: 0,
			createdAt: old,
			lastActiveAt: old,
			deletedAt: null,
		});
		const appended = await repos.events.append(
			{ tenantId, ownerPrincipalId: owner, debugConversationId: conv },
			conv,
			{
				eventType: "turn/start",
				turnId: newTurnId(),
				payload: {},
			},
		);
		expect(appended).toBeDefined();
		// A just-appended conversation survives a cutoff that would have matched
		// its pre-Turn `last_active_at`.
		const expired = await repos.conversations.expireActiveBefore(
			{ tenantId, ownerPrincipalId: owner },
			new Date(Date.now() - 24 * 60 * 60 * 1_000),
		);
		expect(expired).not.toContain(conv);
	});

	it("physical delete removes events + row and is idempotent", async () => {
		const conv = newDebugConversationId();
		await insertConversation(conv);
		await repos.events.append({ tenantId, ownerPrincipalId: owner, debugConversationId: conv }, conv, {
			eventType: "user/message",
			turnId: newTurnId(),
			payload: { text: "hi" },
		});
		await repos.conversations.setStatus({ tenantId, ownerPrincipalId: owner, debugConversationId: conv }, "deleted");
		const deleted = await repos.conversations.deletePhysical(
			{ tenantId, ownerPrincipalId: owner, debugConversationId: conv },
			conv,
		);
		expect(deleted).toBe(true);
		expect(
			await repos.conversations.getByRef({ tenantId, ownerPrincipalId: owner, debugConversationId: conv }),
		).toBeUndefined();
		// Idempotent: second delete is a no-op.
		const again = await repos.conversations.deletePhysical(
			{ tenantId, ownerPrincipalId: owner, debugConversationId: conv },
			conv,
		);
		expect(again).toBe(false);
	});
});

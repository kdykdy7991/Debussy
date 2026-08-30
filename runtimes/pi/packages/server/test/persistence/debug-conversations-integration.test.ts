/**
 * Debug Conversation Phase 1 — real Postgres integration + cross-runtime recovery.
 *
 * Requires the local test database (same default as the migration tests); the
 * suite is skipped automatically when the DB is unreachable.
 *
 * Covers:
 *  - 0016 migration creates debug_conversations / debug_conversation_events
 *  - repository: sequence monotonic increment, last_event_sequence advance,
 *    last_active_at advance, list ordering, turn_id association, FK enforcement
 *  - cross-runtime recovery: Turn1/Turn2 on one service instance, then a NEW
 *    service instance (empty runtime cache) resumes the same conversation and
 *    Turn3's history is recovered from the DATABASE, not a shared live session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createDebugRepositories } from "../../src/persistence/postgres/repositories/debug.ts";
import { DebugConversationService } from "../../src/publishing/debug/service.ts";
import type { DebugRepositories } from "../../src/publishing/debug/types.ts";
import {
	type AgentDefinitionId,
	fromPublicId,
	newAgentDefinitionId,
	newDebugConversationId,
	newTurnId,
	type PrincipalId,
	type TenantId,
} from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";
import type { PiSessionRuntime, PromptInput } from "../../src/types.ts";

const SCHEMA = `dcint_${process.pid}_${Date.now().toString(36)}`;
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

const TENANT_ID = "11111111-1111-7111-8111-111111111111" as TenantId;
const OWNER = "22222222-2222-7222-8222-222222222222" as PrincipalId;
const AGENT_ID = (fromPublicId("AgentDefinitionId", `agent_${newAgentDefinitionId()}`) ??
	newAgentDefinitionId()) as AgentDefinitionId;
const MODEL_A = { provider: "prov", modelId: "modelA" };

const CATALOG: CapabilityCatalog = {
	tools: [],
	knowledgeBases: [],
	models: [
		{
			provider: MODEL_A.provider,
			modelId: MODEL_A.modelId,
			parameterCapabilities: {
				reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
			},
		},
	],
};

function revisionRecord(rev: number): unknown {
	return { revision: rev, draftConfig: { prompt: `system prompt rev ${rev}`, model: MODEL_A } };
}

function makeService(
	debug: DebugRepositories,
	capture: { prompts: PromptInput[]; created: number },
): DebugConversationService {
	const publishingRepos = {
		agentDefinitions: { getLatest: async () => revisionRecord(1) },
		skills: { listBindings: async () => [], get: async () => undefined, getRevision: async () => undefined },
		mcpServers: {
			listBindings: async () => [],
			get: async () => undefined,
			getRevision: async () => undefined,
			listTools: async () => [],
		},
	} as unknown as PublishingRepositories;

	return new DebugConversationService({
		repositories: publishingRepos,
		debug,
		catalog: CATALOG,
		createSession: (sessionOpts) => {
			capture.created += 1;
			return fakeSession(capture)(sessionOpts);
		},
		tenantId: TENANT_ID,
		ownerPrincipalId: OWNER,
	});
}

function fakeSession(capture: { prompts: PromptInput[] }): (opts: unknown) => PiSessionRuntime {
	return (opts: unknown) => {
		const items: Array<Record<string, unknown>> = [];
		return {
			ephemeral: true,
			snapshot: () =>
				({ id: (opts as { id: string }).id, transcript: items }) as unknown as ReturnType<
					PiSessionRuntime["snapshot"]
				>,
			getPhase: () => "idle" as never,
			async prompt(input: PromptInput) {
				capture.prompts.push(input);
				items.push({
					role: "assistant",
					status: "complete",
					content: [
						{ type: "text", text: `echo:${input.text}` },
						{ type: "thinking", redacted: false, thinking: "x" },
					],
				});
			},
			async steer() {},
			async abort() {},
			async setModel() {},
			async setThinking() {},
			subscribe: () => () => {},
			async dispose() {},
		};
	};
}

describe.skipIf(!pgUp)("DebugConversation Phase 1 — real Postgres", () => {
	let client: PostgresClient;
	let debug: DebugRepositories;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		debug = createDebugRepositories(client);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	it("runs 0016 and creates the debug tables", async () => {
		const rows = await client.run(
			"select table_name from information_schema.tables where table_schema = current_schema()",
		);
		const names = rows.map((row) => String(row.table_name));
		expect(names).toContain("debug_conversations");
		expect(names).toContain("debug_conversation_events");
	});

	it("repository: sequence monotonic, last_event_sequence + last_active_at advance, list ordering, turn_id, FK", async () => {
		const convId = newDebugConversationId();
		const t1 = newTurnId();
		const t2 = newTurnId();
		await debug.conversations.insert({
			debugConversationId: convId,
			tenantId: TENANT_ID,
			agentId: AGENT_ID,
			ownerPrincipalId: OWNER,
			status: "active",
			lastEventSequence: 0,
			createdAt: new Date(),
			lastActiveAt: new Date(),
		});

		const ref = { tenantId: TENANT_ID, debugConversationId: convId };
		const e1 = await debug.events.append(ref, convId, {
			eventType: "turn/start",
			turnId: t1,
			payload: { turnId: t1 },
		});
		const e2 = await debug.events.append(ref, convId, {
			eventType: "user/message",
			turnId: t1,
			payload: { text: "hi" },
		});
		const e3 = await debug.events.append(ref, convId, {
			eventType: "assistant/message",
			turnId: t1,
			payload: { text: "yo" },
		});
		const e4 = await debug.events.append(ref, convId, {
			eventType: "user/message",
			turnId: t2,
			payload: { text: "again" },
		});
		expect([e1?.sequence, e2?.sequence, e3?.sequence, e4?.sequence]).toEqual([1, 2, 3, 4]);

		const conv = await debug.conversations.getByRef(ref);
		expect(conv?.lastEventSequence).toBe(4);

		const lastActiveBefore = conv?.lastActiveAt.getTime();
		await debug.events.append(ref, convId, { eventType: "user/message", turnId: t2, payload: { text: "x" } });
		const conv2 = await debug.conversations.getByRef(ref);
		expect(conv2?.lastEventSequence).toBe(5);
		expect(conv2?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(lastActiveBefore ?? 0);

		const list = await debug.events.list(ref, { limit: 100, afterSequence: 0 });
		expect(list.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(list.filter((e) => e.turnId === t1)).toHaveLength(3);
		expect(list.filter((e) => e.turnId === t2)).toHaveLength(2);

		// After-sequence pagination culling.
		const page = await debug.events.list(ref, { limit: 100, afterSequence: 3 });
		expect(page.map((e) => e.sequence)).toEqual([4, 5]);

		// Append to a conversation that does not exist -> no event, no bump.
		const ghost = newDebugConversationId();
		expect(
			await debug.events.append({ tenantId: TENANT_ID, debugConversationId: ghost }, ghost, {
				eventType: "user/message",
				payload: { text: "ghost" },
			}),
		).toBeUndefined();

		// FK is enforced: an event cannot reference a non-existent conversation.
		await expect(
			client.run(
				`insert into debug_conversation_events (id, debug_conversation_id, sequence, event_type, payload)
				 values ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000098', 1, 'turn/start', '{}}'::jsonb)`,
			),
		).rejects.toThrow();

		// Deleting a conversation that has events is blocked by the FK (Phase 1
		// has no GC); soft deletion via status is the supported lifecycle op.
		await expect(client.run(`delete from debug_conversations where id = $1`, convId)).rejects.toThrow();
		expect(await debug.conversations.setStatus(ref, "deleted")).toBe(true);
	});

	it("cross-runtime recovery: a fresh service instance recovers Turn1/Turn2 history from the DB", async () => {
		const capture = { prompts: [] as PromptInput[], created: 0 };
		const svcA = makeService(debug, capture);
		const svcB = makeService(debug, capture);

		const conv = await svcA.createNew(AGENT_ID);
		const t1 = await svcA.executeTurn(conv.debugConversationId, "TurnOne", newTurnId());
		const t2 = await svcA.executeTurn(conv.debugConversationId, "TurnTwo", newTurnId());
		expect(t1.ok).toBe(true);
		expect(t2.ok).toBe(true);
		expect(capture.created).toBe(1); // svcA reused its single cached Runtime.

		// "Process restart": a NEW service instance with an empty runtime cache
		// resumes the same conversation.
		const resumed = await svcB.resume(AGENT_ID);
		expect(resumed?.debugConversationId).toBe(conv.debugConversationId);

		const t3 = await svcB.executeTurn(conv.debugConversationId, "TurnThree", newTurnId());
		expect(t3.ok).toBe(true);
		expect(capture.created).toBe(2); // svcB opened a FRESH session (empty cache).

		const prompt = capture.prompts[2]!;
		expect(prompt.text).toBe("TurnThree");
		// History came from the DB event stream, NOT a shared live transcript.
		expect(prompt.retrieval?.context).toContain("TurnOne");
		expect(prompt.retrieval?.context).toContain("echo:TurnOne");
		expect(prompt.retrieval?.context).toContain("TurnTwo");
		expect(prompt.retrieval?.context).toContain("echo:TurnTwo");
	});
});

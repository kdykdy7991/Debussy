/**
 * WB-007: in-memory unit tests for the conversation event repository.
 *
 * Verifies that:
 * - `append` returns monotonically increasing sequences with no holes;
 * - `event_count`, `event_bytes` and `turn_count` advance in lock-step
 *   with the event insert;
 * - a failed insert does not leave a phantom counter increment or
 *   `last_event_sequence` advance (transaction rollback);
 * - `payloadBytes` is recorded on the event row;
 * - sensitive keys are rejected before persistence by the protocol layer
 *   (re-asserted here against the boundary used by executeTurn).
 *
 * Uses an in-memory fake `PostgresClient` so the test does not need a live
 * database; the live schema-level constraints are covered by
 * `conversation-schema.test.ts`.
 */

import { assertEventPayloadSafe } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PostgresClient } from "../../src/persistence/postgres/client.ts";
import {
	computePayloadBytes,
	createConversationEventRepository,
} from "../../src/persistence/postgres/repositories/conversation-events.ts";
import type { ConversationEventInput, ConversationEventRecord, OwnerScope } from "../../src/publishing/repositories.ts";

interface ConversationRow {
	id: string;
	tenant_id: string;
	published_app_id: string;
	owner_principal_id: string;
	last_event_sequence: number;
	event_count: number;
	event_bytes: number;
	turn_count: number;
	deleted_at: null;
}

interface EventRow {
	id: string;
	tenant_id: string;
	published_app_id: string;
	conversation_id: string;
	sequence: number;
	event_type: string;
	event_schema_version: number;
	turn_id: string | null;
	payload: unknown;
	payload_bytes: number;
	created_at: Date;
}

class FakeClient {
	readonly conversations = new Map<string, ConversationRow>();
	readonly events: EventRow[] = [];
	readonly failNextTransaction = { value: false };

	private static clone<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T;
	}

	async run(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
		const trimmed = sql.trim();
		if (trimmed.startsWith("insert into conversation_events")) {
			const [
				id,
				tenant_id,
				published_app_id,
				conversation_id,
				sequence,
				event_type,
				event_schema_version,
				turn_id,
				payload,
				payload_bytes,
			] = params as [string, string, string, string, number, string, number, string | null, unknown, number];
			if (this.failNextTransaction.value) {
				throw new Error("simulated insert failure");
			}
			this.events.push({
				id,
				tenant_id,
				published_app_id,
				conversation_id,
				sequence,
				event_type,
				event_schema_version,
				turn_id,
				payload,
				payload_bytes,
				created_at: new Date(),
			});
			return [];
		}
		if (trimmed.startsWith("update conversations")) {
			// Replicates the production update in conversation-events.ts:
			// sequence++, event_count++, event_bytes += payloadBytes,
			// turn_count += (1 if no prior event has the same turnId else 0).
			const [conversationId, tenantId, publishedAppId, ownerPrincipalId, payloadBytes, turnId] = params as [
				string,
				string,
				string,
				string,
				number,
				string | null,
			];
			const row = this.conversations.get(conversationId);
			if (
				row === undefined ||
				row.tenant_id !== tenantId ||
				row.published_app_id !== publishedAppId ||
				row.owner_principal_id !== ownerPrincipalId
			) {
				return [];
			}
			row.last_event_sequence += 1;
			row.event_count += 1;
			row.event_bytes += payloadBytes;
			if (turnId !== null) {
				const alreadySeen = this.events.some(
					(event) => event.turn_id === turnId && event.conversation_id === conversationId,
				);
				if (!alreadySeen) row.turn_count += 1;
			}
			return [{ last_event_sequence: row.last_event_sequence }];
		}
		if (trimmed.startsWith("select")) {
			return FakeClient.clone(this.events) as unknown as Record<string, unknown>[];
		}
		return [];
	}

	async transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
		// Snapshot the affected conversation rows so a rollback can restore them.
		// Deep-clone each row so subsequent mutations don't bleed into the snapshot.
		const snapshot = new Map<string, ConversationRow>();
		for (const [k, v] of this.conversations) {
			snapshot.set(k, JSON.parse(JSON.stringify(v)) as ConversationRow);
		}
		const snapshotEvents = this.events.slice();
		try {
			const result = await work(this);
			return result;
		} catch (error) {
			// Any throw from the work function (including a simulated insert
			// failure inside `execute`) is treated as a rollback: restore the
			// state to the snapshot taken at the start of the transaction.
			this.conversations.clear();
			for (const [k, v] of snapshot) this.conversations.set(k, v);
			this.events.length = 0;
			this.events.push(...snapshotEvents);
			throw error;
		}
	}

	// postgres.js transaction handle exposes `unsafe(query, params)`; the
	// real PostgresClient also exposes `run(query, ...params)`. The repository
	// uses `txRows(tx, ...)` which calls `tx.unsafe(...)`. Expose both so the
	// repository code under test calls the same shape it would in production.
	async unsafe(sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
		return this.run(sql, ...params);
	}
}

function seedConversation(client: FakeClient, scope: OwnerScope, id: string): void {
	client.conversations.set(id, {
		id,
		tenant_id: scope.tenantId,
		published_app_id: scope.publishedAppId,
		owner_principal_id: scope.principalId,
		last_event_sequence: 0,
		event_count: 0,
		event_bytes: 0,
		turn_count: 0,
		deleted_at: null,
	});
}

function buildScope(): OwnerScope {
	return {
		tenantId: "ten_1" as never,
		publishedAppId: "app_1" as never,
		principalId: "prn_1" as never,
	};
}

describe("WB-007 conversation event repository", () => {
	let client: FakeClient;
	let scope: OwnerScope;
	let repo: ReturnType<typeof createConversationEventRepository>;

	beforeEach(() => {
		client = new FakeClient();
		scope = buildScope();
		repo = createConversationEventRepository(client as unknown as PostgresClient);
		seedConversation(client, scope, "conv_1");
	});

	afterEach(() => {
		client.failNextTransaction.value = false;
	});

	test("appends return monotonically increasing sequences with no holes", async () => {
		const r1 = await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_1" as never,
			payload: { text: "hi" },
		});
		const r2 = await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "assistant/message",
			turnId: "turn_1" as never,
			payload: { text: "hello" },
		});
		const r3 = await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_2" as never,
			payload: { text: "again" },
		});
		expect(r1?.sequence).toBe(1);
		expect(r2?.sequence).toBe(2);
		expect(r3?.sequence).toBe(3);
		expect(client.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
	});

	test("advances event_count, event_bytes and turn_count together", async () => {
		const before = JSON.parse(JSON.stringify(client.conversations.get("conv_1")!)) as ConversationRow;
		await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_1" as never,
			payload: { text: "hi" },
		});
		await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "assistant/message",
			turnId: "turn_1" as never,
			payload: { text: "hello" },
		});
		await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_2" as never,
			payload: { text: "again" },
		});
		const after = client.conversations.get("conv_1")!;
		expect(after.event_count).toBe(before.event_count + 3);
		expect(after.last_event_sequence).toBe(3);
		expect(after.turn_count).toBe(before.turn_count + 2);
		// event_bytes: each payload is JSON.stringify then utf-8 length.
		const expectedBytes =
			Buffer.byteLength(JSON.stringify({ text: "hi" }), "utf8") +
			Buffer.byteLength(JSON.stringify({ text: "hello" }), "utf8") +
			Buffer.byteLength(JSON.stringify({ text: "again" }), "utf8");
		expect(after.event_bytes).toBe(expectedBytes);
	});

	test("rolls back counters when the event insert fails", async () => {
		await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_1" as never,
			payload: { text: "ok" },
		});
		// Snapshot by value, not by reference: the repository mutates the
		// conversation row in place, so a shallow `{ ...row }` would track
		// the live mutations and defeat the assertion below.
		const before = JSON.parse(JSON.stringify(client.conversations.get("conv_1")!)) as ConversationRow;
		const eventsBefore = client.events.length;
		client.failNextTransaction.value = true;
		await expect(
			repo.append(scope, {
				conversationId: "conv_1" as never,
				eventType: "assistant/message",
				turnId: "turn_1" as never,
				payload: { text: "boom" },
			}),
		).rejects.toThrow();
		const after = client.conversations.get("conv_1")!;
		expect(after.last_event_sequence).toBe(before.last_event_sequence);
		expect(after.event_count).toBe(before.event_count);
		expect(after.event_bytes).toBe(before.event_bytes);
		expect(after.turn_count).toBe(before.turn_count);
		expect(client.events.length).toBe(eventsBefore);
	});

	test("records payloadBytes on the event row", async () => {
		const payload = { text: "hello world" };
		const record: ConversationEventRecord | undefined = await repo.append(scope, {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_1" as never,
			payload,
		});
		expect(record?.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
		expect(client.events[0]?.payload_bytes).toBe(record?.payloadBytes);
	});

	test("returns undefined when the conversation is missing", async () => {
		const result = await repo.append(scope, {
			conversationId: "conv_missing" as never,
			eventType: "user/message",
			payload: { text: "x" },
		});
		expect(result).toBeUndefined();
	});
});

describe("WB-007 payload safety at the persistence boundary", () => {
	test("computePayloadBytes matches the JSON UTF-8 byte length", () => {
		expect(computePayloadBytes({ text: "hello" })).toBe(Buffer.byteLength(JSON.stringify({ text: "hello" }), "utf8"));
	});

	test("sensitive keys are rejected before persistence", () => {
		expect(() => assertEventPayloadSafe({ adminToken: "x" }, { eventType: "user/message" })).toThrow();
		expect(() => assertEventPayloadSafe({ nested: { launchToken: "y" } }, { eventType: "user/message" })).toThrow();
	});

	test("payload schema accepts a benign WB-007 envelope", () => {
		const input: ConversationEventInput = {
			conversationId: "conv_1" as never,
			eventType: "user/message",
			turnId: "turn_1" as never,
			payload: { text: "hello", metadata: { source: "embed" } },
		};
		expect(() => assertEventPayloadSafe(input.payload, { eventType: "user/message" })).not.toThrow();
	});
});

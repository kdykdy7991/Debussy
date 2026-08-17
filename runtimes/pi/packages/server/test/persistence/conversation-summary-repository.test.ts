/**
 * WB-008: in-memory unit tests for the conversation summary repository and
 * the conversation rollover sealing path. Mirrors the pattern in
 * `conversation-event-counters.test.ts`: an in-memory fake
 * `PostgresClient` lets the repository code run against real SQL shapes
 * without needing a live database.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { createConversationSummaryRepository } from "../../src/persistence/postgres/repositories/conversation-summaries.ts";
import { createConversationRepository } from "../../src/persistence/postgres/repositories/conversations.ts";
import type { ConversationSummaryRecord, OwnerScope } from "../../src/publishing/repositories.ts";

interface ConversationRow {
	id: string;
	tenant_id: string;
	published_app_id: string;
	owner_principal_id: string;
	previous_conversation_id: string | null;
	next_conversation_id: string | null;
	rolled_over_at: Date | null;
	status: "active" | "archived" | "deleted";
	latest_summary_sequence: number;
	deleted_at: null;
}

interface SummaryRow {
	id: string;
	tenant_id: string;
	published_app_id: string;
	owner_principal_id: string;
	conversation_id: string;
	through_sequence: number;
	model_id: string;
	source_event_count: number;
	source_bytes: number;
	body: unknown;
	created_at: Date;
}

class UniqueViolation extends Error {
	readonly code = "23505";
}

class FakeClient {
	readonly conversations = new Map<string, ConversationRow>();
	readonly summaries: SummaryRow[] = [];

	private static clone<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T;
	}

	private execute(sql: string, params: readonly unknown[]): Record<string, unknown>[] {
		const trimmed = sql.trim();
		if (trimmed.startsWith("insert into conversation_summaries")) {
			const [
				id,
				tenant_id,
				published_app_id,
				owner_principal_id,
				conversation_id,
				through_sequence,
				model_id,
				source_event_count,
				source_bytes,
				body,
				created_at,
			] = params as [string, string, string, string, string, number, string, number, number, unknown, Date];
			const duplicate = this.summaries.find(
				(row) => row.conversation_id === conversation_id && row.through_sequence === through_sequence,
			);
			if (duplicate !== undefined) throw new UniqueViolation();
			this.summaries.push({
				id,
				tenant_id,
				published_app_id,
				owner_principal_id,
				conversation_id,
				through_sequence,
				model_id,
				source_event_count,
				source_bytes,
				body,
				created_at,
			});
			return [];
		}
		if (trimmed.startsWith("select * from conversation_summaries")) {
			const [conversationId, tenantId, publishedAppId, ownerPrincipalId] = params as [
				string,
				string,
				string,
				string,
			];
			const rows = this.summaries.filter(
				(row) =>
					row.conversation_id === conversationId &&
					row.tenant_id === tenantId &&
					row.published_app_id === publishedAppId &&
					row.owner_principal_id === ownerPrincipalId,
			);
			rows.sort((a, b) => b.through_sequence - a.through_sequence);
			const isLimited = trimmed.includes("limit 1");
			const out = isLimited ? rows.slice(0, 1) : rows;
			return out.map((row) => FakeClient.clone(row) as Record<string, unknown>);
		}
		if (trimmed.startsWith("update conversations")) {
			const [conversationId, tenantId, publishedAppId, ownerPrincipalId, ...rest] = params as [
				string,
				string,
				string,
				string,
				...unknown[],
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
			if (trimmed.includes("status = 'archived'")) {
				if (row.status !== "active") return [];
				const nextId = rest[0] as string;
				row.status = "archived";
				row.next_conversation_id = nextId;
				row.rolled_over_at = new Date();
				return [{ id: row.id }];
			}
			if (trimmed.includes("latest_summary_sequence = $5")) {
				const newSeq = rest[0] as number;
				if (row.latest_summary_sequence >= newSeq) return [];
				row.latest_summary_sequence = newSeq;
				return [{ id: row.id }];
			}
			return [];
		}
		return [];
	}

	async run(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
		return this.execute(sql, params);
	}

	async unsafe(sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
		return this.execute(sql, params);
	}

	async transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
		return work(this);
	}
}

function seedConversation(
	client: FakeClient,
	scope: OwnerScope,
	id: string,
	status: ConversationRow["status"] = "active",
): void {
	client.conversations.set(id, {
		id,
		tenant_id: scope.tenantId,
		published_app_id: scope.publishedAppId,
		owner_principal_id: scope.principalId,
		previous_conversation_id: null,
		next_conversation_id: null,
		rolled_over_at: null,
		status,
		latest_summary_sequence: 0,
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

function buildSummaryRecord(overrides: Partial<ConversationSummaryRecord>): ConversationSummaryRecord {
	return {
		id: "csum_1",
		tenantId: "ten_1" as never,
		publishedAppId: "app_1" as never,
		ownerPrincipalId: "prn_1" as never,
		conversationId: "conv_1" as never,
		throughSequence: 10,
		modelId: "test",
		sourceEventCount: 4,
		sourceBytes: 256,
		body: { text: "hi", keyFacts: [], openItems: [], lastUserMessage: "hi" },
		createdAt: new Date(0),
		...overrides,
	};
}

describe("WB-008 conversation summary repository", () => {
	let client: FakeClient;
	let scope: OwnerScope;

	beforeEach(() => {
		client = new FakeClient();
		scope = buildScope();
		seedConversation(client, scope, "conv_1");
	});

	afterEach(() => {
		client.summaries.length = 0;
	});

	test("inserts a summary and returns outcome inserted", async () => {
		const repo = createConversationSummaryRepository(client as unknown as PostgresClient);
		const result = await repo.insert(scope, buildSummaryRecord({ id: "csum_a" }));
		expect(result).toEqual({ outcome: "inserted" });
		expect(client.summaries).toHaveLength(1);
	});

	test("rejects duplicate (conversation, through_sequence) as outcome duplicate", async () => {
		const repo = createConversationSummaryRepository(client as unknown as PostgresClient);
		await repo.insert(scope, buildSummaryRecord({ id: "csum_a", throughSequence: 5 }));
		const second = await repo.insert(scope, buildSummaryRecord({ id: "csum_b", throughSequence: 5 }));
		expect(second).toEqual({ outcome: "duplicate" });
		expect(client.summaries).toHaveLength(1);
	});

	test("returns the latest summary for a conversation, sorted by through_sequence desc", async () => {
		const repo = createConversationSummaryRepository(client as unknown as PostgresClient);
		await repo.insert(scope, buildSummaryRecord({ id: "csum_a", throughSequence: 5 }));
		await repo.insert(scope, buildSummaryRecord({ id: "csum_b", throughSequence: 12 }));
		await repo.insert(scope, buildSummaryRecord({ id: "csum_c", throughSequence: 9 }));
		const latest = await repo.getLatest(scope, "conv_1" as never);
		expect(latest?.id).toBe("csum_b");
	});

	test("lists all summaries newest first", async () => {
		const repo = createConversationSummaryRepository(client as unknown as PostgresClient);
		await repo.insert(scope, buildSummaryRecord({ id: "csum_a", throughSequence: 5 }));
		await repo.insert(scope, buildSummaryRecord({ id: "csum_b", throughSequence: 12 }));
		const list = await repo.list(scope, "conv_1" as never);
		expect(list.map((row) => row.id)).toEqual(["csum_b", "csum_a"]);
	});

	test("returns undefined when no summary exists", async () => {
		const repo = createConversationSummaryRepository(client as unknown as PostgresClient);
		expect(await repo.getLatest(scope, "conv_1" as never)).toBeUndefined();
	});
});

describe("WB-008 conversation rollover sealing", () => {
	let client: FakeClient;
	let scope: OwnerScope;
	let repo: ReturnType<typeof createConversationRepository>;

	beforeEach(() => {
		client = new FakeClient();
		scope = buildScope();
		repo = createConversationRepository(client as unknown as PostgresClient);
		seedConversation(client, scope, "conv_old");
		seedConversation(client, scope, "conv_next");
	});

	test("sealForRollover flips status to archived and stamps next_conversation_id", async () => {
		const sealed = await repo.sealForRollover(scope, "conv_old" as never, {
			nextConversationId: "conv_next" as never,
			atSequence: 42,
		});
		expect(sealed).toBe(true);
		const row = client.conversations.get("conv_old");
		expect(row?.status).toBe("archived");
		expect(row?.next_conversation_id).toBe("conv_next");
		expect(row?.rolled_over_at).toBeInstanceOf(Date);
	});

	test("sealForRollover refuses to seal a non-active conversation", async () => {
		seedConversation(client, scope, "conv_archived", "archived");
		const sealed = await repo.sealForRollover(scope, "conv_archived" as never, {
			nextConversationId: "conv_next" as never,
			atSequence: 1,
		});
		expect(sealed).toBe(false);
		expect(client.conversations.get("conv_archived")?.status).toBe("archived");
	});

	test("updateLatestSummarySequence is monotonic", async () => {
		const ok1 = await repo.updateLatestSummarySequence(scope, "conv_old" as never, 5);
		const ok2 = await repo.updateLatestSummarySequence(scope, "conv_old" as never, 7);
		const fail = await repo.updateLatestSummarySequence(scope, "conv_old" as never, 3);
		expect(ok1).toBe(true);
		expect(ok2).toBe(true);
		expect(fail).toBe(false);
		expect(client.conversations.get("conv_old")?.latest_summary_sequence).toBe(7);
	});
});

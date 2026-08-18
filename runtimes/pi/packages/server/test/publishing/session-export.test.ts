/**
 * WB-009: streaming conversation export.
 *
 * Unit tests over the export line generator and the service streaming method
 * (no database; paging is stubbed). Covers the acceptance criteria:
 *   - continuous JSONL from event 1 through the frozen throughSequence
 *   - paging is memory-bounded (only one page held at a time)
 *   - no silent sequence gaps (throws when the page cursor breaks)
 *   - transcript mode projects only user/assistant message text
 *   - diagnostics mode redacts message bodies
 *   - `conversation.exported` audit written; cross-tenant -> not-found
 */
import { describe, expect, test } from "vitest";
import { ControlService, ConversationExportNotFound } from "../../src/publishing/control/service.ts";
import type { ConversationId, TenantId } from "../../src/publishing/domain/ids.ts";
import { newConversationId, newTenantId } from "../../src/publishing/domain/ids.ts";
import { exportSessionLines } from "../../src/publishing/export/session-export.ts";
import type {
	ConversationEventRecord,
	ConversationRecord,
	PublishingRepositories,
} from "../../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const CATALOG: CapabilityCatalog = {
	tools: [],
	models: [{ provider: "skdy", modelId: "pi-chat" }],
	knowledgeBases: [],
};
const TENANT_A: TenantId = newTenantId();
const TENANT_B: TenantId = newTenantId();
const CONV_A: ConversationId = newConversationId();
const APP_A = "app_11111111-1111-1111-1111-111111111111";

function conv(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
	return {
		conversationId: CONV_A,
		tenantId: TENANT_A,
		publishedAppId: APP_A as ConversationRecord["publishedAppId"],
		ownerPrincipalId: "prn_11111111-1111-1111-1111-111111111111" as never,
		createdByPrincipalId: "prn_11111111-1111-1111-1111-111111111111" as never,
		title: "Support ticket",
		status: "active",
		eventCount: 3,
		eventBytes: 100,
		turnCount: 1,
		lastEventSequence: 3,
		latestSummarySequence: null,
		previousConversationId: null,
		nextConversationId: null,
		rolledOverAt: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		lastActiveAt: new Date("2026-01-02T00:00:00Z"),
		...overrides,
	};
}

function evt(seq: number, eventType: string, payload: unknown, turnId: string | null = null): ConversationEventRecord {
	return {
		eventId: `evt_${seq}` as ConversationEventRecord["eventId"],
		tenantId: TENANT_A,
		publishedAppId: APP_A as ConversationEventRecord["publishedAppId"],
		conversationId: CONV_A,
		sequence: seq,
		eventType,
		eventSchemaVersion: 1,
		turnId: turnId as ConversationEventRecord["turnId"],
		payload,
		payloadBytes: JSON.stringify(payload).length,
		createdAt: new Date(`2026-01-02T00:00:0${seq}Z`),
	};
}

/** Stream the generator into a fully-resolved array for assertion. */
async function collect(input: {
	conversation: ConversationRecord;
	mode: "full" | "diagnostics" | "transcript";
	page: (after: number, limit: number) => Promise<ConversationEventRecord[]>;
}): Promise<unknown[]> {
	const lines = [];
	for await (const line of exportSessionLines(input)) lines.push(JSON.parse(line));
	return lines;
}

describe("exportSessionLines", () => {
	test("full mode yields a manifest then continuous events with bounded paging", async () => {
		const events = [
			evt(1, "user/message", { text: "hi" }),
			evt(2, "assistant/message", { text: "hello" }),
			evt(3, "turn/failed", { error: "boom" }),
		];
		let pagesRequested = 0;
		let lastLimit = -1;
		const lines = await collect({
			conversation: conv(),
			mode: "full",
			page: async (after, limit) => {
				pagesRequested += 1;
				lastLimit = limit;
				// Simulate a DB page cap of 2 rows per query.
				return events.filter((e) => e.sequence > after).slice(0, 2);
			},
		});

		const manifest = lines[0] as Record<string, unknown>;
		expect(manifest.kind).toBe("manifest");
		expect(manifest.mode).toBe("full");
		expect(manifest.throughSequence).toBe(3);
		expect(lines).toHaveLength(4);
		expect((lines[1] as Record<string, unknown>).sequence).toBe(1);
		expect((lines[3] as Record<string, unknown>).eventType).toBe("turn/failed");
		expect(pagesRequested).toBeGreaterThan(1);
		expect(lastLimit).toBeGreaterThan(0);
	});

	test("transcript mode projects only user/assistant text", async () => {
		const events = [
			evt(1, "user/message", { text: "hi" }),
			evt(2, "assistant/message", { text: "hello" }),
			evt(3, "turn/failed", { error: "boom" }),
		];
		const lines = await collect({
			conversation: conv({ lastEventSequence: 3 }),
			mode: "transcript",
			page: async (after) => events.filter((e) => e.sequence > after),
		});
		// manifest + 2 transcript lines (the turn/failed is skipped).
		expect(lines).toHaveLength(3);
		expect((lines[1] as Record<string, unknown>).role).toBe("user");
		expect((lines[1] as Record<string, unknown>).text).toBe("hi");
		expect((lines[2] as Record<string, unknown>).role).toBe("assistant");
	});

	test("diagnostics mode redacts message bodies but keeps metadata", async () => {
		const events = [evt(1, "user/message", { text: "secret", meta: 1 })];
		const lines = await collect({
			conversation: conv({ lastEventSequence: 1 }),
			mode: "diagnostics",
			page: async (after) => events.filter((e) => e.sequence > after),
		});
		const payload = (lines[1] as { payload: Record<string, unknown> }).payload;
		expect(payload.text).toBe("[redacted]");
		expect(payload.meta).toBe(1);
	});

	test("throws on a silent sequence gap", async () => {
		const events = [evt(1, "user/message", {}), evt(3, "assistant/message", {})]; // missing seq 2
		await expect(
			collect({
				conversation: conv({ lastEventSequence: 3 }),
				mode: "full",
				page: async (after) => events.filter((e) => e.sequence > after),
			}),
		).rejects.toThrow(/gap/);
	});

	test("excludes events beyond the frozen throughSequence", async () => {
		const events = [
			evt(1, "user/message", { text: "a" }),
			evt(2, "assistant/message", { text: "b" }),
			evt(3, "user/message", { text: "late" }),
		];
		const lines = await collect({
			conversation: conv({ lastEventSequence: 2 }),
			mode: "full",
			page: async (after) => events.filter((e) => e.sequence > after),
		});
		const seqs = lines.slice(1).map((l) => (l as Record<string, unknown>).sequence);
		expect(seqs).toEqual([1, 2]);
	});
});

describe("ControlService.streamConversationExport", () => {
	test("writes conversation.exported audit and streams lines", async () => {
		const auditRows: { action: string; resourceId: string }[] = [];
		const source = {
			conversations: {
				getByTenant: async () => conv({ lastEventSequence: 2 }),
			},
			events: {
				listByConversation: async (params: { afterSequence: number; limit: number }) =>
					[evt(params.afterSequence + 1, "user/message", { text: "x" })].filter(
						(e) => e.sequence <= params.afterSequence + params.limit,
					),
			},
		};
		const repos = {
			...source,
			conversations: source.conversations,
			events: source.events,
			attachments: {},
			audit: { insert: async (row: { action: string; resourceId: string }) => auditRows.push(row) },
		} as unknown as PublishingRepositories;

		const service = new ControlService({
			repositories: repos,
			catalog: CATALOG,
			embedBaseUrl: "https://embed.example.test",
		});
		const lines: string[] = [];
		for await (const line of service.streamConversationExport({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			mode: "full",
			requestId: "req_1",
		})) {
			lines.push(line);
		}
		expect(auditRows).toHaveLength(1);
		expect(auditRows[0]!.action).toBe("conversation.exported");
		expect(lines.length).toBeGreaterThan(1);
	});

	test("cross-tenant conversation throws ConversationExportNotFound", async () => {
		const repos = {
			conversations: { getByTenant: async () => undefined },
			events: { listByConversation: async () => [] },
		} as unknown as PublishingRepositories;
		const service = new ControlService({
			repositories: repos,
			catalog: CATALOG,
			embedBaseUrl: "https://embed.example.test",
		});
		const iter = service.streamConversationExport({
			tenantId: TENANT_B,
			conversationId: CONV_A,
			mode: "diagnostics",
		});
		await expect(iter.next()).rejects.toBeInstanceOf(ConversationExportNotFound);
	});
});

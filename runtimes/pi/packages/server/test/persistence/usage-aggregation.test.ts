import { describe, expect, it, vi } from "vitest";
import type { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { createConversationEventRepository } from "../../src/persistence/postgres/repositories/conversation-events.ts";
import type { TenantId } from "../../src/publishing/domain/ids.ts";

describe("conversation event usage aggregation", () => {
	it("maps tenant-scoped provider totals without estimating from message content", async () => {
		const run = vi.fn(async () => [
			{
				agent_definition_id: "11111111-1111-1111-1111-111111111111",
				agent_name: "客服 Agent",
				input_tokens: "120",
				output_tokens: "30",
				cache_read_tokens: "80",
				cache_write_tokens: "0",
				total_tokens: "150",
				request_count: "2",
			},
		]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const from = new Date("2026-08-01T00:00:00.000Z");
		const to = new Date("2026-08-08T00:00:00.000Z");
		const rows = await repository.summarizeUsage({
			scope: { tenantId: "22222222-2222-2222-2222-222222222222" as TenantId },
			from,
			to,
		});

		expect(rows).toEqual([
			{
				agentDefinitionId: "11111111-1111-1111-1111-111111111111",
				agentName: "客服 Agent",
				source: "embed",
				inputTokens: 120,
				outputTokens: 30,
				cacheReadTokens: 80,
				cacheWriteTokens: 0,
				totalTokens: 150,
				requestCount: 2,
			},
		]);
		const [query, tenantId, queryFrom, queryTo] = run.mock.calls[0] as unknown as [string, string, Date, Date];
		expect(query).toContain("e.tenant_id = $1");
		expect(query).toContain("e.event_type = 'turn/end'");
		expect(query).toContain("e.payload->'usage'");
		expect(tenantId).toBe("22222222-2222-2222-2222-222222222222");
		expect(queryFrom).toBe(from);
		expect(queryTo).toBe(to);
	});
});

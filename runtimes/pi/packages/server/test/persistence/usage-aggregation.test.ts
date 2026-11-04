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
		expect(query).toContain("e.source is distinct from 'orchestration'");
		expect(query).toContain("orchestration_work_items");
		expect(tenantId).toBe("22222222-2222-2222-2222-222222222222");
		expect(queryFrom).toBe(from);
		expect(queryTo).toBe(to);
	});

	it("aggregates orchestration runs without mixing historical partial tokens into accurate totals", async () => {
		const row = (overrides: Record<string, unknown>) => ({
			run_id: "00000000-0000-4000-8000-000000000001",
			integration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			integration_name: "工单系统",
			state: "succeeded",
			created_at: "2026-08-02T00:00:00.000Z",
			frozen_version: "orv_11111111-1111-4111-8111-111111111111",
			model: "Qwen",
			turn_count: "1",
			complete: true,
			total_tokens: "900",
			input_tokens: "800",
			output_tokens: "100",
			cache_read_tokens: "0",
			cache_write_tokens: "0",
			llm_calls: "3",
			legacy_tokens: "0",
			started_at: "2026-08-02T00:00:00.000Z",
			ended_at: "2026-08-02T00:00:12.000Z",
			...overrides,
		});
		const run = vi.fn(async () => [
			row({ run_id: "run-complete" }),
			row({
				run_id: "run-partial",
				complete: false,
				total_tokens: "0",
				input_tokens: "0",
				output_tokens: "0",
				llm_calls: "0",
				legacy_tokens: "500",
			}),
			row({
				run_id: "run-none",
				turn_count: "0",
				complete: null,
				total_tokens: "0",
				input_tokens: "0",
				output_tokens: "0",
				llm_calls: "0",
				legacy_tokens: "0",
				started_at: null,
				ended_at: null,
			}),
		]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const summary = await repository.summarizeOrchestrationUsage!({
			scope: { tenantId: "22222222-2222-2222-2222-222222222222" as TenantId },
			from: new Date("2026-08-01T00:00:00.000Z"),
			to: new Date("2026-08-08T00:00:00.000Z"),
		});
		expect(summary.byIntegration).toHaveLength(1);
		expect(summary.byIntegration[0]).toMatchObject({
			runCount: 3,
			succeeded: 3,
			completeRuns: 1,
			partialRuns: 1,
			noUsageRuns: 1,
			tokens: { totalTokens: 900, inputTokens: 800, outputTokens: 100 },
			llmCallCount: 3,
			partialTokens: 500,
			models: ["Qwen"],
			maxDurationMs: 12000,
		});
		expect(summary.coverage).toMatchObject({ completeTokens: 900, partialTokens: 500 });
		expect(summary.recentRuns.map((r) => r.tokenCoverage)).toEqual(["complete", "partial", "none"]);
		const [query] = run.mock.calls[0] as unknown as [string];
		expect(query).toContain("e.payload->'llmUsage'");
		expect(query).toContain("bool_and");
		expect(query).toContain("orchestration_work_items w");
	});
});

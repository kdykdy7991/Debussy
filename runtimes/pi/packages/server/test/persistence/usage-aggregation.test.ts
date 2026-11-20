import { describe, expect, it, vi } from "vitest";
import type { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { createConversationEventRepository } from "../../src/persistence/postgres/repositories/conversation-events.ts";
import type { TenantId } from "../../src/publishing/domain/ids.ts";

const TENANT_ID = "22222222-2222-2222-2222-222222222222" as TenantId;
const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-08T00:00:00.000Z");

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
		const rows = await repository.summarizeUsage({ scope: { tenantId: TENANT_ID }, from: FROM, to: TO });

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
		expect(tenantId).toBe(TENANT_ID);
		expect(queryFrom).toBe(FROM);
		expect(queryTo).toBe(TO);
	});

	it("aggregates orchestration runs without mixing historical partial tokens into accurate totals", async () => {
		const row = (overrides: Record<string, unknown>) => ({
			run_id: "00000000-0000-4000-8000-000000000001",
			integration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			integration_name: "工单系统",
			run_source: "legacy",
			conversation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
			cache_reported_calls: "1",
			cache_unknown_calls: "0",
			cache_hit_tokens: "0",
			cache_prompt_tokens: "800",
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
			scope: { tenantId: TENANT_ID },
			from: FROM,
			to: TO,
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

		// New detail view: full run list, per-day and per-model real aggregation.
		expect(summary.view?.runs).toHaveLength(3);
		expect(summary.view?.runs.map((r) => r.accurateTokens)).toEqual([900, null, null]);
		expect(summary.view?.runs.map((r) => r.accurateLlmCallCount)).toEqual([3, null, null]);
		expect(summary.view?.runs[1]?.partialTokens).toBe(500);
		expect(summary.view?.runs[0]?.durationMs).toBe(12000);
		expect(summary.view?.runs[2]?.durationMs).toBeNull();
		expect(summary.view?.runs[0]?.conversationId).toBe("conv_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
		expect(summary.view?.coverage).toEqual({
			runCount: 3,
			completeCount: 1,
			partialCount: 1,
			noUsageCount: 1,
			accurateTokens: 900,
			partialTokens: 500,
			llmCallCount: 3,
			cacheReportedRuns: 1,
			cacheUnknownRuns: 0,
			cacheReportedCalls: 1,
			cacheUnknownCalls: 0,
			cacheHitTokens: 0,
			cachePromptTokens: 800,
			cacheMissTokens: 800,
			cacheHitRate: 0,
		});
		expect(summary.view?.runs[0]).toMatchObject({
			cacheHitTokens: 0,
			cacheMissTokens: 800,
			cachePromptTokens: 800,
			cacheHitRate: 0,
		});
		expect(summary.view?.runs[1]?.cacheHitTokens).toBeNull();
		expect(summary.view?.byDay).toHaveLength(7);
		expect(summary.view?.byDay[1]).toMatchObject({ date: "2026-08-02", runCount: 3, accurateTokens: 900 });
		expect(summary.view?.byModel[0]).toMatchObject({
			key: "Qwen",
			runCount: 3,
			accurateTokens: 900,
			llmCallCount: 3,
			partialTokens: 500,
		});
	});

	it("includes Key-owned AaaS runs alongside legacy integrations without double counting", async () => {
		const row = (overrides: Record<string, unknown>) => ({
			run_id: "00000000-0000-4000-8000-000000000001",
			integration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			integration_name: "工单系统",
			run_source: "legacy",
			conversation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			state: "succeeded",
			created_at: "2026-08-02T00:00:00.000Z",
			frozen_version: null,
			model: "Qwen",
			turn_count: "1",
			complete: true,
			total_tokens: "900",
			input_tokens: "800",
			output_tokens: "100",
			cache_read_tokens: "0",
			cache_write_tokens: "0",
			cache_reported_calls: "1",
			cache_unknown_calls: "0",
			cache_hit_tokens: "0",
			cache_prompt_tokens: "800",
			llm_calls: "3",
			legacy_tokens: "0",
			started_at: "2026-08-02T00:00:00.000Z",
			ended_at: "2026-08-02T00:00:12.000Z",
			...overrides,
		});
		const run = vi.fn(async () => [
			row({ run_id: "legacy-run" }),
			row({
				run_id: "aaas-run",
				integration_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				integration_name: "aaas_key:test",
				run_source: "aaas_key",
				conversation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				total_tokens: "1039",
				input_tokens: "1000",
				output_tokens: "39",
				cache_prompt_tokens: "1000",
			}),
		]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const summary = await repository.summarizeOrchestrationUsage!({
			scope: { tenantId: TENANT_ID },
			from: FROM,
			to: TO,
		});
		expect(summary.byIntegration).toHaveLength(2);
		expect(summary.byIntegration.find((r) => r.source === "legacy")).toMatchObject({
			runCount: 1,
			tokens: { totalTokens: 900 },
		});
		expect(summary.byIntegration.find((r) => r.source === "aaas_key")).toMatchObject({
			integrationName: "aaas_key:test",
			runCount: 1,
			tokens: { totalTokens: 1039 },
		});
		expect(summary.view?.coverage).toMatchObject({ runCount: 2, completeCount: 2, accurateTokens: 1939 });
		expect(summary.view?.runs).toHaveLength(2);
		const [query] = run.mock.calls[0] as unknown as [string];
		expect(query).not.toContain("i.kind='legacy'");
		expect(query).toContain("case when w.key_id is not null");
		expect(query).toContain("coalesce(k.name, w.key_id::text)");
		expect(query).toContain("k.tenant_id=w.tenant_id");
		expect(summary.view?.runs.find((r) => r.id === "aaas-run")?.groupName).toBe("aaas_key:test");
	});

	it("excludes a complete run without reported cache data from the weighted hit rate", async () => {
		const row = (overrides: Record<string, unknown>) => ({
			run_id: "00000000-0000-4000-8000-000000000001",
			integration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			integration_name: "工单系统",
			run_source: "legacy",
			conversation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			state: "succeeded",
			created_at: "2026-08-02T00:00:00.000Z",
			frozen_version: null,
			model: "Qwen",
			turn_count: "1",
			complete: true,
			total_tokens: "500",
			input_tokens: "400",
			output_tokens: "100",
			cache_read_tokens: "100",
			cache_write_tokens: "0",
			cache_reported_calls: "1",
			cache_unknown_calls: "0",
			cache_hit_tokens: "100",
			cache_prompt_tokens: "500",
			llm_calls: "1",
			legacy_tokens: "0",
			started_at: "2026-08-02T00:00:00.000Z",
			ended_at: "2026-08-02T00:00:01.000Z",
			...overrides,
		});
		const run = vi.fn(async () => [
			row({ run_id: "run-reported" }),
			// Same complete usage caliber, but the provider did not report cache
			// fields. It must be unknown, never a zero-hit denominator row.
			row({
				run_id: "run-unknown-cache",
				total_tokens: "700",
				input_tokens: "600",
				cache_read_tokens: "0",
				cache_reported_calls: "0",
				cache_unknown_calls: "1",
				cache_hit_tokens: "0",
				cache_prompt_tokens: "0",
			}),
		]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const summary = await repository.summarizeOrchestrationUsage!({
			scope: { tenantId: TENANT_ID },
			from: FROM,
			to: TO,
		});
		expect(summary.view?.runs[0]).toMatchObject({
			cacheHitTokens: 100,
			cacheMissTokens: 400,
			cachePromptTokens: 500,
			cacheHitRate: 0.2,
		});
		expect(summary.view?.runs[1]).toMatchObject({
			cacheHitTokens: null,
			cacheMissTokens: null,
			cachePromptTokens: null,
			cacheHitRate: null,
		});
		expect(summary.view?.coverage).toMatchObject({
			completeCount: 2,
			cacheReportedRuns: 1,
			cacheUnknownRuns: 1,
			cacheReportedCalls: 1,
			cacheUnknownCalls: 1,
			cacheHitTokens: 100,
			cachePromptTokens: 500,
			cacheHitRate: 0.2,
		});
	});

	it("aggregates cache data per call and leaves unreported calls out of the rate", async () => {
		const row = (overrides: Record<string, unknown>) => ({
			run_id: "00000000-0000-4000-8000-000000000001",
			integration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			integration_name: "工单系统",
			run_source: "legacy",
			conversation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			state: "succeeded",
			created_at: "2026-08-02T00:00:00.000Z",
			frozen_version: null,
			model: "Qwen",
			turn_count: "1",
			complete: true,
			total_tokens: "1310",
			input_tokens: "800",
			output_tokens: "60",
			cache_read_tokens: "400",
			cache_write_tokens: "50",
			// Three calls: two reported their cache read, one did not.
			cache_reported_calls: "2",
			cache_unknown_calls: "1",
			cache_hit_tokens: "400",
			cache_prompt_tokens: "750",
			llm_calls: "3",
			legacy_tokens: "0",
			started_at: "2026-08-02T00:00:00.000Z",
			ended_at: "2026-08-02T00:00:01.000Z",
			...overrides,
		});
		const run = vi.fn(async () => [row({})]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const summary = await repository.summarizeOrchestrationUsage!({
			scope: { tenantId: TENANT_ID },
			from: FROM,
			to: TO,
		});
		expect(summary.view?.runs[0]).toMatchObject({
			cacheHitTokens: 400,
			cacheMissTokens: 350,
			cachePromptTokens: 750,
			cacheHitRate: 400 / 750,
			cacheReportedCalls: 2,
			cacheUnknownCalls: 1,
		});
		expect(summary.view?.coverage).toMatchObject({
			cacheReportedRuns: 1,
			cacheUnknownRuns: 0,
			cacheReportedCalls: 2,
			cacheUnknownCalls: 1,
			cacheHitTokens: 400,
			cachePromptTokens: 750,
		});
	});

	it("builds a Chat-only view with the same complete/partial/none caliber", async () => {
		const base = {
			event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			turn_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			conversation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			created_at: "2026-08-03T09:00:00.000Z",
			group_id: "11111111-1111-1111-1111-111111111111",
			group_name: "客服 Agent",
			model: "Qwen3.8",
		};
		const run = vi.fn(async () => [
			{
				...base,
				llm_usage_kind: "object",
				llm_partial: "false",
				accurate_tokens: "150",
				llm_calls: "2",
				cache_reported_calls: "1",
				cache_unknown_calls: "0",
				cache_hit_tokens: "30",
				cache_prompt_tokens: "150",
				legacy_tokens: "10",
			},
			{
				...base,
				turn_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				llm_usage_kind: null,
				llm_partial: null,
				accurate_tokens: null,
				llm_calls: null,
				cache_reported_calls: null,
				cache_unknown_calls: null,
				cache_hit_tokens: null,
				cache_prompt_tokens: null,
				legacy_tokens: "40",
			},
			{
				...base,
				turn_id: "12121212-1212-4121-8121-121212121212",
				model: null,
				llm_usage_kind: null,
				llm_partial: null,
				accurate_tokens: null,
				llm_calls: null,
				cache_reported_calls: null,
				cache_unknown_calls: null,
				cache_hit_tokens: null,
				cache_prompt_tokens: null,
				legacy_tokens: null,
			},
		]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const view = await repository.summarizeChatUsageView!({
			scope: { tenantId: TENANT_ID },
			from: FROM,
			to: TO,
		});
		expect(view.coverage).toEqual({
			runCount: 3,
			completeCount: 1,
			partialCount: 1,
			noUsageCount: 1,
			accurateTokens: 150,
			partialTokens: 40,
			llmCallCount: 2,
			cacheReportedRuns: 1,
			cacheUnknownRuns: 0,
			cacheReportedCalls: 1,
			cacheUnknownCalls: 0,
			cacheHitTokens: 30,
			cachePromptTokens: 150,
			cacheMissTokens: 120,
			cacheHitRate: 0.2,
		});
		expect(view.runs.map((r) => r.accurateTokens)).toEqual([150, null, null]);
		expect(view.runs.map((r) => r.tokenCoverage)).toEqual(["complete", "partial", "none"]);
		expect(view.runs[0]).toMatchObject({
			state: null,
			durationMs: null,
			conversationId: "conv_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			cacheHitTokens: 30,
			cacheMissTokens: 120,
			cachePromptTokens: 150,
			cacheHitRate: 0.2,
		});
		expect(view.byGroup[0]).toMatchObject({ label: "客服 Agent", runCount: 3, accurateTokens: 150 });
		expect(view.byModel.map((r) => r.key).sort()).toEqual(["Qwen3.8", "未记录模型"]);
		expect(view.byDay).toHaveLength(7);

		const [query, tenantId, queryFrom, queryTo] = run.mock.calls[0] as unknown as [string, string, Date, Date];
		expect(query).toContain("e.payload->'llmUsage'");
		expect(query).toContain("e.event_type in ('turn/end', 'turn/interrupted')");
		expect(query).toContain("e.source is distinct from 'orchestration'");
		expect(query).toContain("orchestration_work_items");
		expect(query).toContain("x.event_type='turn/start'");
		expect(tenantId).toBe(TENANT_ID);
		expect(queryFrom).toBe(FROM);
		expect(queryTo).toBe(TO);
	});

	it("Chat view keeps a cancelled turn's confirmed tokens as partial, not accurate", async () => {
		const base = {
			event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
			turn_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			conversation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			created_at: "2026-08-03T09:00:00.000Z",
			group_id: "11111111-1111-1111-1111-111111111111",
			group_name: "客服 Agent",
			model: "Qwen3.8",
		};
		const run = vi.fn(async () => [
			{
				...base,
				terminal_event: "turn/interrupted",
				llm_usage_kind: "object",
				llm_partial: "false",
				accurate_tokens: "55",
				llm_calls: "1",
				cache_reported_calls: null,
				cache_unknown_calls: null,
				cache_hit_tokens: null,
				cache_prompt_tokens: null,
				legacy_tokens: null,
			},
		]);
		const repository = createConversationEventRepository({ run } as unknown as PostgresClient);
		const view = await repository.summarizeChatUsageView!({
			scope: { tenantId: TENANT_ID },
			from: FROM,
			to: TO,
		});
		expect(view.runs[0]?.tokenCoverage).toBe("partial");
		expect(view.runs[0]?.state).toBe("cancelled");
		expect(view.runs[0]?.accurateTokens).toBeNull();
		// Confirmed consumption is not discarded; it stays in the partial bucket.
		expect(view.runs[0]?.partialTokens).toBe(55);
		expect(view.coverage.accurateTokens).toBe(0);
		expect(view.coverage.partialTokens).toBe(55);
		expect(view.coverage.cacheHitTokens).toBe(0);
	});
});

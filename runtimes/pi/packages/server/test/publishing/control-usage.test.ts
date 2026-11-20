/**
 * Control service assembles the two independent Usage views from the existing
 * repository contract. No database is needed: every repository method is
 * replaced with a deterministic stub, and the service only projects results.
 */
import { type AdminUsageRunRow, buildUsageViewStats } from "@earendil-works/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import { ControlService } from "../../src/publishing/control/service.ts";
import type { TenantId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const TENANT_ID = "22222222-2222-2222-2222-222222222222" as TenantId;
const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-08T00:00:00.000Z");
const PERIOD = { from: FROM.toISOString(), to: TO.toISOString() };

function run(id: string, groupId: string): AdminUsageRunRow {
	return {
		id,
		groupId,
		groupName: groupId,
		state: "succeeded",
		createdAt: "2026-08-02T00:00:00.000Z",
		model: "Qwen3.8",
		versionId: null,
		tokenCoverage: "complete",
		accurateTokens: 100,
		partialTokens: 0,
		accurateLlmCallCount: 2,
		durationMs: 1000,
		conversationId: null,
		cacheHitTokens: null,
		cacheMissTokens: null,
		cachePromptTokens: null,
		cacheHitRate: null,
	};
}

function serviceWith(events: Record<string, unknown>): ControlService {
	return new ControlService({
		repositories: { events } as unknown as PublishingRepositories,
		catalog: {} as CapabilityCatalog,
		embedBaseUrl: "http://localhost",
	});
}

describe("ControlService.getUsageSummary", () => {
	it("exposes orchestration and Chat views as separate, unmerged calibers", async () => {
		const orchestrationView = buildUsageViewStats({
			runs: [run("orchestration-run", "integration-1")],
			...PERIOD,
		});
		const chatView = buildUsageViewStats({ runs: [run("chat-turn", "agent-1")], ...PERIOD });
		const summarizeUsage = vi.fn(async () => []);
		const summarizeOrchestrationUsage = vi.fn(async () => ({
			byIntegration: [],
			recentRuns: [],
			coverage: {
				completeRuns: 1,
				partialRuns: 0,
				noUsageRuns: 0,
				completeTokens: 100,
				partialTokens: 0,
				note: "",
			},
			view: orchestrationView,
		}));
		const summarizeChatUsageView = vi.fn(async () => chatView);

		const result = await serviceWith({
			summarizeUsage,
			summarizeOrchestrationUsage,
			summarizeChatUsageView,
		}).getUsageSummary({ tenantId: TENANT_ID, from: FROM, to: TO });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.orchestration?.view).toBe(orchestrationView);
		expect(result.data.chat).toBe(chatView);
		expect(result.data.orchestration?.view?.coverage.accurateTokens).toBe(100);
		expect(result.data.chat?.coverage.accurateTokens).toBe(100);
		// Legacy Chat aggregate is untouched and is not silently mixed into the views.
		expect(result.data.totals.totalTokens).toBe(0);
		expect(result.data.bySource).toEqual([]);
		for (const call of [summarizeUsage, summarizeOrchestrationUsage, summarizeChatUsageView]) {
			expect(call).toHaveBeenCalledWith({ scope: { tenantId: TENANT_ID }, from: FROM, to: TO });
		}
	});

	it("stays compatible with repositories that do not implement the new aggregation", async () => {
		const result = await serviceWith({ summarizeUsage: vi.fn(async () => []) }).getUsageSummary({
			tenantId: TENANT_ID,
			from: FROM,
			to: TO,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.chat).toBeUndefined();
		expect(result.data.orchestration).toBeUndefined();
		expect(result.data.period).toEqual({ ...PERIOD, timezone: "UTC" });
	});
});

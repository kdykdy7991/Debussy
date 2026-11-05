import { describe, expect, it, vi } from "vitest";
import { UsageApi } from "../../src/admin/api/usage-api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

describe("UsageApi", () => {
	it("requests a bounded ISO period and returns server totals", async () => {
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		auth.connect("token");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							period: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z", timezone: "UTC" },
							totals: {
								inputTokens: 10,
								outputTokens: 5,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
								totalTokens: 15,
								requestCount: 1,
							},
							byAgent: [],
							bySource: [],
							generatedAt: "2026-08-08T00:00:00.000Z",
						},
					}),
					{ status: 200 },
				),
		);
		const api = new UsageApi({ auth, fetchImpl: fetchMock as unknown as typeof fetch });
		const result = await api.getSummary({
			from: new Date("2026-08-01T00:00:00.000Z"),
			to: new Date("2026-08-08T00:00:00.000Z"),
		});

		expect(result.totals.totalTokens).toBe(15);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("/api/control/v1/usage?");
		expect(url).toContain("from=2026-08-01T00%3A00%3A00.000Z");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
	});

	it("returns the separate orchestration and Chat view aggregation unchanged", async () => {
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		auth.connect("token");
		const view = {
			runs: [],
			byGroup: [],
			byModel: [],
			byDay: [{ date: "2026-08-01", runCount: 0, accurateTokens: 0, partialTokens: 0 }],
			coverage: {
				runCount: 0,
				completeCount: 0,
				partialCount: 0,
				noUsageCount: 0,
				accurateTokens: 0,
				partialTokens: 0,
				llmCallCount: 0,
			},
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							period: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z", timezone: "UTC" },
							totals: {
								inputTokens: 0,
								outputTokens: 0,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
								totalTokens: 0,
								requestCount: 0,
							},
							byAgent: [],
							bySource: [],
							chat: view,
							orchestration: {
								byIntegration: [],
								recentRuns: [],
								coverage: {
									completeRuns: 0,
									partialRuns: 0,
									noUsageRuns: 0,
									completeTokens: 0,
									partialTokens: 0,
									note: "",
								},
								view,
							},
							generatedAt: "2026-08-08T00:00:00.000Z",
						},
					}),
					{ status: 200 },
				),
		);
		const api = new UsageApi({ auth, fetchImpl: fetchMock as unknown as typeof fetch });
		const result = await api.getSummary({
			from: new Date("2026-08-01T00:00:00.000Z"),
			to: new Date("2026-08-08T00:00:00.000Z"),
		});
		expect(result.chat?.byDay).toHaveLength(1);
		expect(result.orchestration?.view?.coverage.runCount).toBe(0);
	});

	it("rejects when no admin token is available", async () => {
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		const api = new UsageApi({ auth, fetchImpl: vi.fn() as unknown as typeof fetch });
		await expect(
			api.getSummary({ from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-08T00:00:00.000Z") }),
		).rejects.toThrow("Admin token is not set");
	});
});

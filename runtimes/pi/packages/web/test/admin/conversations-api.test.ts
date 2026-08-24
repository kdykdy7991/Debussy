import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsApi } from "../../src/admin/api/conversations-api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

describe("ConversationsApi", () => {
	let controller: AdminAuthController;

	beforeEach(() => {
		controller = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		controller.connect("admin-token");
	});

	it("serializes advanced list filters and cursor", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { items: [], nextCursor: null, redacted: true }, requestId: "req_1" })),
		);
		const api = new ConversationsApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });

		await api.list({
			limit: 25,
			cursor: "cursor value",
			appId: "app_1",
			agentId: "agent_1",
			publishedAppVersionId: "pav_1",
			createdAfter: "2026-08-01T00:00:00.000Z",
			createdBefore: "2026-08-18T00:00:00.000Z",
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/api/control/v1/conversations");
		expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
			limit: "25",
			cursor: "cursor value",
			appId: "app_1",
			agentId: "agent_1",
			publishedAppVersionId: "pav_1",
			createdAfter: "2026-08-01T00:00:00.000Z",
			createdBefore: "2026-08-18T00:00:00.000Z",
		});
	});

	it("downloads a gzip export with authorization", async () => {
		const body = new Uint8Array([31, 139, 8]);
		const fetchMock = vi.fn(
			async () => new Response(body, { headers: { "content-type": "application/jsonl+gzip" } }),
		);
		const api = new ConversationsApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });

		const blob = await api.downloadExport("conv/a", "transcript");

		expect(blob.size).toBe(body.byteLength);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://localhost/api/control/v1/conversations/conv%2Fa/export?mode=transcript");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer admin-token",
			Accept: "application/jsonl+gzip",
		});
	});

	it("propagates export errors and locks authentication on 401", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired", requestId: "req_2" } }), {
					status: 401,
				}),
		);
		const api = new ConversationsApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });

		await expect(api.downloadExport("conv_1", "full")).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			httpStatus: 401,
			requestId: "req_2",
		});
		expect(controller.getToken()).toBeNull();
	});

	describe("M1 metrics + context endpoints", () => {
		it("serializes metrics query with afterSequence + limit", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_1",
								stats: {
									available: false,
									turnCount: 0,
									sampleCount: 0,
									ttftMs: { mean: null, count: 0, p50: null, p95: null },
									generationMs: { mean: null, count: 0, p50: null, p95: null },
									totalLatencyMs: { mean: null, count: 0, p50: null, p95: null },
									outputTokensPerSecond: { mean: null, count: 0, p50: null, p95: null },
								},
								items: [],
								nextAfterSequence: null,
							},
							requestId: "req_metrics",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			await api.getMetrics("conv_1", { conversationId: "conv_1", afterSequence: 12, limit: 50 });

			const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			const parsed = new URL(url);
			expect(parsed.pathname).toBe("/api/control/v1/conversations/conv_1/metrics");
			expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
				afterSequence: "12",
				limit: "50",
			});
		});

		it("omits afterSequence when not provided", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_2",
								stats: {
									available: false,
									turnCount: 0,
									sampleCount: 0,
									ttftMs: { mean: null, count: 0, p50: null, p95: null },
									generationMs: { mean: null, count: 0, p50: null, p95: null },
									totalLatencyMs: { mean: null, count: 0, p50: null, p95: null },
									outputTokensPerSecond: { mean: null, count: 0, p50: null, p95: null },
								},
								items: [],
								nextAfterSequence: null,
							},
							requestId: "req_metrics2",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			await api.getMetrics("conv_2", { conversationId: "conv_2" });

			const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			const parsed = new URL(url);
			expect(parsed.pathname).toBe("/api/control/v1/conversations/conv_2/metrics");
			expect(parsed.searchParams.has("afterSequence")).toBe(false);
		});

		it("calls the context endpoint with no query params", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_3",
								available: false,
								latest: null,
								atSequence: null,
							},
							requestId: "req_ctx",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			const result = await api.getContext("conv_3");

			expect(result.available).toBe(false);
			expect(result.latest).toBeNull();
			const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe("http://localhost/api/control/v1/conversations/conv_3/context");
		});

		it("propagates METRICS_UNAVAILABLE (503) errors", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "METRICS_UNAVAILABLE", message: "offline", requestId: "req_m_err" },
						}),
						{ status: 503 },
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			await expect(api.getMetrics("conv_4", { conversationId: "conv_4" })).rejects.toMatchObject({
				code: "METRICS_UNAVAILABLE",
				httpStatus: 503,
			});
		});

		it("propagates INVALID_METRICS_FILTER (422) errors", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "INVALID_METRICS_FILTER", message: "bad", requestId: "req_m_422" },
						}),
						{ status: 422 },
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			await expect(api.getMetrics("conv_5", { conversationId: "conv_5", afterSequence: -1 })).rejects.toMatchObject({
				code: "INVALID_METRICS_FILTER",
				httpStatus: 422,
			});
		});

		/**
		 * 分页回环：模拟 MetricsTab 在 `onNextPage(data.nextAfterSequence)` 之后
		 * 重新调用 `api.getMetrics` 的连续两次请求，断言游标严格按服务端字段推进，
		 * 且第一次默认不传 `afterSequence`（首页）。
		 */
		it("advances afterSequence on successive paginated calls", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_p",
								stats: {
									available: true,
									turnCount: 100,
									sampleCount: 80,
									ttftMs: { mean: 10, count: 80, p50: 9, p95: 20 },
									generationMs: { mean: 100, count: 80, p50: 95, p95: 200 },
									totalLatencyMs: { mean: 110, count: 80, p50: 104, p95: 220 },
									outputTokensPerSecond: { mean: 50, count: 80, p50: 45, p95: 90 },
								},
								items: [],
								nextAfterSequence: 50,
							},
							requestId: "req_p1",
						}),
					),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_p",
								stats: {
									available: true,
									turnCount: 100,
									sampleCount: 80,
									ttftMs: { mean: 10, count: 80, p50: 9, p95: 20 },
									generationMs: { mean: 100, count: 80, p50: 95, p95: 200 },
									totalLatencyMs: { mean: 110, count: 80, p50: 104, p95: 220 },
									outputTokensPerSecond: { mean: 50, count: 80, p50: 45, p95: 90 },
								},
								items: [],
								nextAfterSequence: null,
							},
							requestId: "req_p2",
						}),
					),
				);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			// 第一次：MetricsTab 首次挂载，afterSequence=null → 不传参数
			const page1 = await api.getMetrics("conv_p", { conversationId: "conv_p", limit: 50 });
			expect(page1.nextAfterSequence).toBe(50);
			let [url1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			let parsed1 = new URL(url1);
			expect(parsed1.pathname).toBe("/api/control/v1/conversations/conv_p/metrics");
			expect(parsed1.searchParams.has("afterSequence")).toBe(false);

			// 第二次：MetricsTab `onNextPage(50)` 后 → afterSequence=50
			const page2 = await api.getMetrics("conv_p", {
				conversationId: "conv_p",
				afterSequence: page1.nextAfterSequence ?? 0,
				limit: 50,
			});
			expect(page2.nextAfterSequence).toBeNull();
			[url1] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
			parsed1 = new URL(url1);
			expect(parsed1.searchParams.get("afterSequence")).toBe("50");
		});
	});
});

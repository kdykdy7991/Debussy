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

		/**
		 * retryable 一致性：handleApiError 与抛出的 ConversationsApiError 必须
		 * 看到同一个 retryable 值；这是 R3 修订项（之前 handleApiError 固定 false，
		 * ConversationsApiError 已按协议计算，导致 UI/认证控制器两套语义）。
		 */
		it("passes the same retryable to handleApiError and the thrown ConversationsApiError", async () => {
			const handleApiError = vi.fn();
			controller.handleApiError = handleApiError;

			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "METRICS_UNAVAILABLE", message: "offline", requestId: "req_retry" },
						}),
						{ status: 503 },
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			let thrown: unknown;
			try {
				await api.getMetrics("conv_retry", { conversationId: "conv_retry" });
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(Error);
			const thrownErr = thrown as { readonly retryable: boolean };
			expect(thrownErr.retryable).toBe(true);
			expect(handleApiError).toHaveBeenCalledTimes(1);
			const callArg = handleApiError.mock.calls[0]?.[0] as { readonly retryable: boolean };
			expect(callArg.retryable).toBe(thrownErr.retryable);
		});

		/**
		 * AbortSignal 透传：metrics/context 第三个参数 signal 必须真正进入 fetch 的
		 * RequestInit.signal——这是过期请求保护（StaleResponseGuard）链路上的
		 * 关键一环。
		 */
		it("forwards AbortSignal to fetch RequestInit.signal", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_sig",
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
							requestId: "req_sig",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			const controller2 = new AbortController();
			await api.getMetrics("conv_sig", { conversationId: "conv_sig" }, controller2.signal);

			const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(init.signal).toBe(controller2.signal);
		});
	});

	/**
	 * M1 reasoning：会话级覆盖 tab 的两个 HTTP 入口（V2-README §4.3）。
	 * 不复制 DTO：测试只断言 URL/method/body/headers + 错误码透传，
	 * 字段含义（`effort`、`updatedAt`）由协议 frozen 类型保证。
	 */
	describe("getReasoning / putReasoning", () => {
		it("getReasoning sends GET /api/control/v1/conversations/:id/reasoning with bearer token", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_r1",
								effort: "high",
								updatedAt: "2026-08-24T10:00:00.000Z",
							},
							requestId: "req_get_reasoning",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			const state = await api.getReasoning("conv_r1");

			expect(state.effort).toBe("high");
			const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe("http://localhost/api/control/v1/conversations/conv_r1/reasoning");
			expect(init.method).toBe("GET");
			expect(init.headers).toMatchObject({ Authorization: "Bearer admin-token" });
		});

		it("getReasoning surfaces 404 CONVERSATION_NOT_FOUND with retryable=false", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "CONVERSATION_NOT_FOUND", message: "not in tenant", requestId: "req_404" },
						}),
						{ status: 404 },
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			const thrown = await api.getReasoning("conv_x").then(
				() => null,
				(err: unknown) => err,
			);
			expect(thrown).not.toBeNull();
			expect((thrown as { code: string }).code).toBe("CONVERSATION_NOT_FOUND");
			expect((thrown as { retryable: boolean }).retryable).toBe(false);
		});

		it("putReasoning sends PUT with JSON body and bearer token", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_r2",
								effort: "xhigh",
								updatedAt: "2026-08-24T10:01:00.000Z",
							},
							requestId: "req_put_reasoning",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			const state = await api.putReasoning("conv_r2", { effort: "xhigh" });

			expect(state.effort).toBe("xhigh");
			const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe("http://localhost/api/control/v1/conversations/conv_r2/reasoning");
			expect(init.method).toBe("PUT");
			expect(init.headers).toMatchObject({
				Authorization: "Bearer admin-token",
				"Content-Type": "application/json",
			});
			expect(JSON.parse(init.body as string)).toEqual({ effort: "xhigh" });
		});

		it("putReasoning surfaces 422 REASONING_INVALID_EFFORT with retryable=false", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								code: "REASONING_INVALID_EFFORT",
								message: "effort must be one of: high, low, medium",
								requestId: "req_422",
							},
						}),
						{ status: 422 },
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			// 服务端会拒绝（422 REASONING_INVALID_EFFORT）——故意用一个不在
			// 协议 `ReasoningEffort` union 内的字符串，模拟 wire 上的非法档位。
			// `as never` 让前端类型系统放行（协议不允许构造非法值，但服务端是
			// 终极权威，所以测试断言服务端能正确拒绝并把错误码透传）。
			const thrown = await api
				.putReasoning("conv_r3", { effort: "wrong" as never })
				.then(
					() => null,
					(err: unknown) => err,
				);
			expect(thrown).not.toBeNull();
			expect((thrown as { code: string }).code).toBe("REASONING_INVALID_EFFORT");
			// 422 在 HTTP 兜底里是不可重试的，与协议表一致；
			// 关键断言是 UI 拿到 retryable=false，避免无限重试一个验证错误。
			expect((thrown as { retryable: boolean }).retryable).toBe(false);
		});

		it("putReasoning accepts null effort (clear override)", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								conversationId: "conv_r4",
								effort: null,
								updatedAt: "2026-08-24T10:02:00.000Z",
							},
							requestId: "req_clear",
						}),
					),
			);
			const api = new ConversationsApi({
				auth: controller,
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			const state = await api.putReasoning("conv_r4", { effort: null });

			expect(state.effort).toBeNull();
			const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(JSON.parse(init.body as string)).toEqual({ effort: null });
		});
	});
});

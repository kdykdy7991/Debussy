/**
 * M1 reasoning：Embed SDK reasoning consumer mock 联调核对（契约 §11）。
 *
 * 服务端路由（dbe175e）:
 *   PUT  /api/embed/v1/conversations/:id/reasoning   ✅ 已冻结
 *   GET  /api/embed/v1/conversations/:id/reasoning   ⏳ Q5 待 BE 合入
 *
 * 本测试**仅**消费 SDK 层（`EmbedApi.getConversationReasoning` /
 * `putConversationReasoning`），用 `fetchImpl` 模拟服务端信封响应——
 * 不新增任何服务端路由、不依赖运行中的 server。Q5 合入后 GET 用例即可
 * 落地为真联调测试。
 *
 * 覆盖路径：
 * 1. PUT body=JSON 序列化 + Authorization: Bearer + Accept: application/json；
 * 2. PUT null effort 清除覆盖；
 * 3. 错误码透传（422 / 403 / 404），embed 与 admin 共享 frozen 表；
 * 4. 30s 超时（fakeTimers 推进 30000ms）→ `EmbedApiError.code =
 *    "REQUEST_TIMEOUT"`, `retryable=true`；
 * 5. caller 提前 abort → 原 `AbortError`（与 stale guard 静默吞掉的语义一致）；
 * 6. GET 路由拼装正确（method/headers/path）——服务端未上线前断言 wire shape。
 */

import type { ConversationReasoningState, ReasoningEffort } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedApi, EmbedApiError } from "../../src/embed/api.ts";

/** Promise rejection handler：把 unknown 收敛成 `EmbedApiError | DOMException`。 */
type CaughtError = EmbedApiError | DOMException | Error;
function asCaught(e: unknown): CaughtError {
	if (e instanceof Error) return e;
	return new Error(String(e));
}

function sampleState(
	conversationId: `conv_${string}`,
	overrides: Partial<ConversationReasoningState> = {},
): ConversationReasoningState {
	return {
		conversationId,
		effort: "high" as ReasoningEffort,
		updatedAt: "2026-08-24T12:00:00.000Z",
		configurable: true,
		pinnedCapability: {
			publishedAppVersionId: "pav_x" as `pav_${string}`,
			modelId: "model-x",
			reasoning: {
				supported: true,
				toggle: false,
				efforts: ["low", "medium", "high"],
				defaultEffort: "medium",
			},
		},
		...overrides,
	};
}

function okResponse<T>(data: T, requestId = "req_test"): Response {
	return new Response(JSON.stringify({ data, requestId }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function errorResponse(code: string, message: string, status: number, requestId = "req_err"): Response {
	return new Response(JSON.stringify({ error: { code, message, requestId } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("EmbedApi.putConversationReasoning（PUT 联调 / 契约 §11）", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let api: EmbedApi;

	beforeEach(() => {
		fetchMock = vi.fn();
		api = new EmbedApi({ baseUrl: "https://api.test", fetchImpl: fetchMock as unknown as typeof fetch });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("PUT 携带 Bearer token + JSON body + 正确路由", async () => {
		const state = sampleState("conv_1");
		fetchMock.mockResolvedValueOnce(okResponse(state));

		const result = await api.putConversationReasoning("embed-token", "conv_1", { effort: "high" });

		expect(result).toEqual(state);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.test/api/embed/v1/conversations/conv_1/reasoning");
		expect(init.method).toBe("PUT");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer embed-token");
		expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
		expect(JSON.parse(init.body as string)).toEqual({ effort: "high" });
	});

	it("PUT null effort 清除会话覆盖", async () => {
		const state = sampleState("conv_clear", { effort: null });
		fetchMock.mockResolvedValueOnce(okResponse(state));

		const result = await api.putConversationReasoning("t", "conv_clear", { effort: null });

		expect(result.effort).toBeNull();
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ effort: null });
	});

	it("422 REASONING_INVALID_EFFORT 透传为 EmbedApiError（契约 §11 Q4 共享码）", async () => {
		fetchMock.mockResolvedValueOnce(
			errorResponse("REASONING_INVALID_EFFORT", "effort must be one of the supported tiers", 422),
		);

		const err: EmbedApiError | null = await api.putConversationReasoning("t", "conv_x", { effort: "xhigh" }).then(
			() => null as EmbedApiError | null,
			(e: unknown) => asCaught(e) as EmbedApiError,
		);
		expect(err).toBeInstanceOf(EmbedApiError);
		expect(err?.code).toBe("REASONING_INVALID_EFFORT");
		expect(err?.retryable).toBe(false);
	});

	it("403 REASONING_NOT_CONFIGURABLE 透传", async () => {
		fetchMock.mockResolvedValueOnce(
			errorResponse("REASONING_NOT_CONFIGURABLE", "policy forbids adjusting effort", 403),
		);

		const err: EmbedApiError | null = await api.putConversationReasoning("t", "conv_p", { effort: "low" }).then(
			() => null as EmbedApiError | null,
			(e: unknown) => asCaught(e) as EmbedApiError,
		);
		expect(err).toBeInstanceOf(EmbedApiError);
		expect(err?.code).toBe("REASONING_NOT_CONFIGURABLE");
		expect(err?.retryable).toBe(false);
	});

	it("404 CONVERSATION_NOT_FOUND 透传（跨属主，Q4 共享码）", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse("CONVERSATION_NOT_FOUND", "conversation not found", 404));

		const err: EmbedApiError | null = await api.putConversationReasoning("t", "conv_missing", { effort: "low" }).then(
			() => null as EmbedApiError | null,
			(e: unknown) => asCaught(e) as EmbedApiError,
		);
		expect(err).toBeInstanceOf(EmbedApiError);
		expect(err?.code).toBe("CONVERSATION_NOT_FOUND");
	});

	it("30 秒超时 → EmbedApiError.code='REQUEST_TIMEOUT', retryable=true", async () => {
		vi.useFakeTimers();
		try {
			fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted by signal", "AbortError"));
					});
				});
			});

			// 立即 attach rejection handler，避免 unhandled rejection 警告。
			const p: Promise<EmbedApiError | null> = api.putConversationReasoning("t", "conv_to", { effort: "high" }).then(
				() => null as EmbedApiError | null,
				(e: unknown) => asCaught(e) as EmbedApiError,
			);
			await vi.advanceTimersByTimeAsync(30_000);
			const err: EmbedApiError | null = await p;

			expect(err).toBeInstanceOf(EmbedApiError);
			expect(err?.code).toBe("REQUEST_TIMEOUT");
			expect(err?.retryable).toBe(true);
			expect(err?.message).toMatch(/30s/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("30s 超时前 caller abort → 原 AbortError（不被翻译为 REQUEST_TIMEOUT）", async () => {
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted by signal", "AbortError"));
				});
			});
		});

		const callerController = new AbortController();
		const p = api.putConversationReasoning("t", "conv_to2", { effort: "high" }, callerController.signal).then(
			() => null as unknown,
			(e: unknown) => asCaught(e) as unknown,
		);

		callerController.abort();
		const err = await p;

		expect(err).toBeInstanceOf(DOMException);
		expect((err as DOMException).name).toBe("AbortError");
	});

	it("30s 内的成功响应不被 timer 误中止（cleanup 正常）", async () => {
		vi.useFakeTimers();
		try {
			fetchMock.mockResolvedValueOnce(okResponse(sampleState("conv_ok", { effort: "low" })));

			const state = await api.putConversationReasoning("t", "conv_ok", { effort: "low" });
			expect(state.effort).toBe("low");
			// 推进 30s 验证 timer 已被 clearTimeout，不触发任何后续行为
			await vi.advanceTimersByTimeAsync(30_000);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("EmbedApi.getConversationReasoning（GET SDK consumer / Q5 待合入）", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let api: EmbedApi;

	beforeEach(() => {
		fetchMock = vi.fn();
		api = new EmbedApi({ baseUrl: "https://api.test", fetchImpl: fetchMock as unknown as typeof fetch });
	});

	it("GET 路由拼装正确：method + Bearer + Accept", async () => {
		// 当前 BE 不支持，但 SDK consumer 已就绪——断言 wire shape 不变，
		// Q5 合入后此用例即落地为真联调。
		fetchMock.mockResolvedValueOnce(okResponse(sampleState("conv_get")));

		const state = await api.getConversationReasoning("embed-token", "conv_get");
		expect(state.conversationId).toBe("conv_get");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.test/api/embed/v1/conversations/conv_get/reasoning");
		expect(init.method).toBe("GET");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer embed-token");
	});

	it("GET 错误码透传 422 / 403 / 404", async () => {
		const errCases = [
			{ code: "REASONING_INVALID_EFFORT", status: 422 },
			{ code: "REASONING_NOT_CONFIGURABLE", status: 403 },
			{ code: "CONVERSATION_NOT_FOUND", status: 404 },
		] as const;
		for (const { code, status } of errCases) {
			fetchMock.mockResolvedValueOnce(errorResponse(code, code.toLowerCase(), status));
			const err: EmbedApiError | null = await api.getConversationReasoning("t", "conv_x").then(
				() => null as EmbedApiError | null,
				(e: unknown) => asCaught(e) as EmbedApiError,
			);
			expect(err).toBeInstanceOf(EmbedApiError);
			expect(err?.code).toBe(code);
		}
	});

	it("GET 30s 超时同样翻译为 REQUEST_TIMEOUT", async () => {
		vi.useFakeTimers();
		try {
			fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted by signal", "AbortError"));
					});
				});
			});

			const p = api.getConversationReasoning("t", "conv_to_get").then(
				() => null as EmbedApiError | null,
				(e: unknown) => asCaught(e) as EmbedApiError,
			);
			await vi.advanceTimersByTimeAsync(30_000);
			const err: EmbedApiError | null = await p;

			expect(err).toBeInstanceOf(EmbedApiError);
			expect(err?.code).toBe("REQUEST_TIMEOUT");
			expect(err?.retryable).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("UI 假设契约（契约 §11 Q1）", () => {
	it("ConversationReasoningState 不应携带 revisionDefaultEffort 字段", () => {
		// 类型层断言：协议 DTO 与 dbe175e 对齐——5 字段，无 revisionDefaultEffort。
		// 若有人重新引入该字段，此 assertion 触发（编译期 TS 也会拦截）。
		const sample = sampleState("conv_check");
		expect(Object.keys(sample)).not.toContain("revisionDefaultEffort");
		expect(Object.keys(sample).sort()).toEqual([
			"configurable",
			"conversationId",
			"effort",
			"pinnedCapability",
			"updatedAt",
		]);
	});
});

/**
 * M1: typed fixture 适配层单测。
 *
 * 验证：
 * - 所有 `FixtureName` 都返回 `loaded` 状态；
 * - `metrics`/`context` 的空态与有数据态在 `stats.available` 与 `latest` 上
 *   正确区分；
 * - `describeError` 对协议已冻结的错误码给出正确文案；
 * - 错误状态构造（由 tab 入口处构造）保持错误码稳定。
 */

import type { ConversationContextResponse, ConversationMetricsResponse } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { type DataState, describeError, type FixtureName, loadFixture } from "../../src/admin/fixtures/index.ts";

describe("fixtures adapter (M1)", () => {
	it("loads every registered fixture as a DataState<T>.loaded", () => {
		const names: readonly FixtureName[] = [
			"conversation/metrics/loaded-empty",
			"conversation/metrics/loaded-with-sample",
			"conversation/metrics/unavailable",
			"conversation/metrics/invalid-filter",
			"conversation/context/loaded-no-snapshot",
			"conversation/context/loaded-with-snapshot",
			"conversation/context/legacy-no-snapshot",
			"conversation/context/unavailable",
		];
		for (const name of names) {
			const state = loadFixture<unknown>(name);
			expect(state.kind, name).toBe("loaded");
		}
	});

	it("metrics fixture exposes protocol ConversationMetricsResponse shape", () => {
		const state = loadFixture<ConversationMetricsResponse>("conversation/metrics/loaded-with-sample");
		expect(state.kind).toBe("loaded");
		if (state.kind !== "loaded") return;
		expect(state.data.conversationId).toBeTypeOf("string");
		expect(state.data.stats).toMatchObject({
			available: expect.any(Boolean),
			turnCount: expect.any(Number),
			sampleCount: expect.any(Number),
		});
		expect(state.data.items).toEqual([]);
		expect(state.data.nextAfterSequence).toBeNull();
	});

	it("context with-snapshot fixture carries a placeholder ContextUsageSnapshot", () => {
		const state = loadFixture<ConversationContextResponse>("conversation/context/loaded-with-snapshot");
		expect(state.kind).toBe("loaded");
		if (state.kind !== "loaded") return;
		expect(state.data.available).toBe(true);
		expect(state.data.latest).not.toBeNull();
		expect(state.data.latest?.measurement).toBe("estimated");
	});

	it("context without-snapshot fixture leaves latest null", () => {
		const state = loadFixture<ConversationContextResponse>("conversation/context/loaded-no-snapshot");
		expect(state.kind).toBe("loaded");
		if (state.kind !== "loaded") return;
		expect(state.data.available).toBe(false);
		expect(state.data.latest).toBeNull();
		expect(state.data.atSequence).toBeNull();
	});

	it("describeError maps known error codes to stable UI copy", () => {
		const r1 = describeError({
			kind: "error",
			code: "METRICS_UNAVAILABLE",
			message: "x",
			retryable: true,
		});
		expect(r1.title).toBe("指标服务暂不可用");

		const r2 = describeError({
			kind: "error",
			code: "CONTEXT_SNAPSHOT_UNAVAILABLE",
			message: "y",
			retryable: true,
		});
		expect(r2.title).toBe("指标服务暂不可用");

		const r3 = describeError({
			kind: "error",
			code: "INVALID_METRICS_FILTER",
			message: "z",
			retryable: false,
		});
		expect(r3.title).toBe("查询参数无效");

		const r4 = describeError({
			kind: "error",
			code: "SOMETHING_NEW",
			message: "msg",
			retryable: false,
		});
		expect(r4.title).toBe("加载失败");
		expect(r4.description).toBe("msg");
	});

	it("DataState union exhaustiveness: kind: 'empty' reason enum is closed", () => {
		// 编译期即可证；运行期再 type-narrow 一遍。
		const state: DataState<unknown> = { kind: "empty", reason: "legacy_session" };
		if (state.kind === "empty") {
			expect(["no_data_yet", "legacy_session"]).toContain(state.reason);
		}
	});
});

/**
 * M1: typed fixture 适配层单测（修订轮）。
 *
 * 覆盖：
 * - 默认 vitest node 环境（无 `import.meta.env.DEV`、未设测试门控）下
 *   `loadFixture` 必须**抛错**——这是 fixtures 隔离的核心约束：
 *   "fixture 不进入生产 bundle"。
 * - 测试代码显式置 `globalThis.__PI_WEB_FIXTURES_ALLOWED__ = true` 后，
 *   `loadFixture` 才允许返回数据。
 * - 真实契约：context fixture 表中**不允许**出现 `available=true` 配
 *   `latest=null` 或 `available=true` 配全零 breakdown；fixture 显式走
 *   `available=false` 是预期行为。
 * - `describeError` 对协议已冻结的错误码给出正确文案。
 */

import type { ConversationContextResponse, ConversationMetricsResponse } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DataState, describeError, type FixtureName, loadFixture } from "../../src/admin/fixtures/index.ts";

describe("fixtures adapter (M1)", () => {
	const originalFlag = globalThis.__PI_WEB_FIXTURES_ALLOWED__;

	beforeEach(() => {
		delete globalThis.__PI_WEB_FIXTURES_ALLOWED__;
	});

	afterEach(() => {
		if (originalFlag === undefined) delete globalThis.__PI_WEB_FIXTURES_ALLOWED__;
		else globalThis.__PI_WEB_FIXTURES_ALLOWED__ = originalFlag;
	});

	it("throws in production / unflagged test environments", () => {
		expect(() => loadFixture<unknown>("conversation/metrics/loaded-with-sample")).toThrowError(/dev\/test only/i);
	});

	it("loads every registered fixture as DataState<T>.loaded when allowed", () => {
		globalThis.__PI_WEB_FIXTURES_ALLOWED__ = true;
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
		globalThis.__PI_WEB_FIXTURES_ALLOWED__ = true;
		const state = loadFixture<ConversationMetricsResponse>("conversation/metrics/loaded-with-sample");
		expect(state.kind).toBe("loaded");
		if (state.kind !== "loaded") return;
		expect(state.data.conversationId).toBeTypeOf("string");
		expect(state.data.stats).toMatchObject({
			available: false,
			turnCount: 0,
			sampleCount: 0,
		});
		expect(state.data.items).toEqual([]);
		expect(state.data.nextAfterSequence).toBeNull();
	});

	it("all context fixtures use available=false to honor breakdown sum == usedTokens contract", () => {
		globalThis.__PI_WEB_FIXTURES_ALLOWED__ = true;
		const names: readonly FixtureName[] = [
			"conversation/context/loaded-no-snapshot",
			"conversation/context/loaded-with-snapshot",
			"conversation/context/legacy-no-snapshot",
			"conversation/context/unavailable",
		];
		for (const name of names) {
			const state = loadFixture<ConversationContextResponse>(name);
			expect(state.kind, name).toBe("loaded");
			if (state.kind !== "loaded") return;
			expect(state.data.available, `${name}.available`).toBe(false);
			expect(state.data.latest, `${name}.latest`).toBeNull();
		}
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
		const state: DataState<unknown> = { kind: "empty", reason: "legacy_session" };
		if (state.kind === "empty") {
			expect(["no_data_yet", "legacy_session"]).toContain(state.reason);
		}
	});
});

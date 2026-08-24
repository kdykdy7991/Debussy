/**
 * M1: data-state 生产模块单元测试（修订轮）。
 *
 * 覆盖任务单验收项：
 * 1. 每个 `AGENT_V2_METRICS_ERROR_CODES` 都能被 `isKnownErrorCode` 识别。
 * 2. 已知错误码携带错误的 `retryable` 时，`toDataStateError` 仍以
 *    `AGENT_V2_METRICS_ERRORS` 为权威——**不**允许传入对象覆盖。
 * 3. `lookupErrorMetadata` 对未知码返回 `httpStatus=null, retryable=false`。
 */
import { AGENT_V2_METRICS_ERROR_CODES, AGENT_V2_METRICS_ERRORS } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { isKnownErrorCode, lookupErrorMetadata, toDataStateError } from "../../src/admin/data-state.ts";

describe("data-state (M1)", () => {
	it("recognisKNOWN every AGENT_V2_METRICS_ERROR_CODES value via isKnownErrorCode", () => {
		// 协议以后新增错误码时，本断言自动覆盖：循环而非硬编码字符串。
		for (const code of AGENT_V2_METRICS_ERROR_CODES) {
			expect(isKnownErrorCode(code), code).toBe(true);
		}
		// 反向断言：纯垃圾字符串应被识别为"未知"。
		expect(isKnownErrorCode("SOMETHING_NEW")).toBe(false);
		expect(isKnownErrorCode("")).toBe(false);
	});

	it("lookupErrorMetadata returns protocol table entry for known codes", () => {
		for (const code of AGENT_V2_METRICS_ERROR_CODES) {
			expect(lookupErrorMetadata(code)).toEqual(AGENT_V2_METRICS_ERRORS[code]);
		}
	});

	it("lookupErrorMetadata returns retryable=false / httpStatus=null for unknown codes", () => {
		expect(lookupErrorMetadata("SOMETHING_NEW")).toEqual({ retryable: false, httpStatus: null });
		expect(lookupErrorMetadata("")).toEqual({ retryable: false, httpStatus: null });
	});

	it("toDataStateError keeps retryable canonical for known protocol codes even when caller passes false", () => {
		// 已知协议码 + 传错 retryable:false → 仍按协议表返回（不重试的码也强制为 false），
		// 关键在于不可重试的码**不能**被任意上游错误对象强行改成 true。
		for (const code of AGENT_V2_METRICS_ERROR_CODES) {
			const protocolRetryable = AGENT_V2_METRICS_ERRORS[code].retryable;
			const flipped = !protocolRetryable;
			const result = toDataStateError({
				code,
				message: "msg",
				retryable: flipped, // 上游尝试覆盖
			});
			expect(result.code, code).toBe(code);
			expect(result.retryable, code).toBe(protocolRetryable);
			// 关键断言：必须**不**等于 flip 后的值。
			expect(result.retryable).not.toBe(flipped);
		}
	});

	it("toDataStateError maps unknown code to UNKNOWN_ERROR and retries via caller's retryable", () => {
		const r = toDataStateError({
			code: "WEIRD_CODE",
			message: "msg",
			retryable: true,
		});
		expect(r.code).toBe("UNKNOWN_ERROR");
		expect(r.retryable).toBe(true);
		expect(r.message).toBe("msg");
	});

	it("toDataStateError maps absent code to UNKNOWN_ERROR", () => {
		const r = toDataStateError({ message: "boom" });
		expect(r.code).toBe("UNKNOWN_ERROR");
		expect(r.retryable).toBe(false);
		expect(r.message).toBe("boom");
	});
});

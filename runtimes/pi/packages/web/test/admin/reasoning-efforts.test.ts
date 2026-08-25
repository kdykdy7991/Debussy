import type { ReasoningEffort } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { productReasoningEfforts } from "../../src/admin/agents/reasoning-efforts.ts";

describe("productReasoningEfforts", () => {
	test("原样透传模型声明的 6 档 reasoning effort", () => {
		const input: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
		expect(productReasoningEfforts(input)).toEqual([
			{ value: "minimal", label: "minimal" },
			{ value: "low", label: "low" },
			{ value: "medium", label: "medium" },
			{ value: "high", label: "high" },
			{ value: "xhigh", label: "xhigh" },
			{ value: "max", label: "max" },
		]);
	});

	test("保留入参顺序：仅返回模型声明的子集", () => {
		expect(productReasoningEfforts(["low", "medium", "xhigh"])).toEqual([
			{ value: "low", label: "low" },
			{ value: "medium", label: "medium" },
			{ value: "xhigh", label: "xhigh" },
		]);
	});

	test("unsupported 模型（efforts=[]）→ 返回空数组，UI 渲染 unsupported 状态", () => {
		expect(productReasoningEfforts([])).toEqual([]);
	});

	test("不做产品语义翻译（6 档字面量都出现）", () => {
		const out = productReasoningEfforts(["minimal", "low", "medium", "high", "xhigh", "max"]);
		// 旧 M0 实现会拍成 低/中/高；M1 R3 不再做这种映射。
		const labels = out.map((item) => item.label);
		expect(labels).not.toContain("低");
		expect(labels).not.toContain("中");
		expect(labels).not.toContain("高");
	});
});
import { describe, expect, test } from "vitest";
import { productReasoningEfforts } from "../../src/admin/agents/reasoning-efforts.ts";

describe("productReasoningEfforts", () => {
	test("never leaks six provider levels into product values", () => {
		expect(productReasoningEfforts(["minimal", "low", "medium", "high", "xhigh", "max"])).toEqual([
			{ label: "低", value: "low" },
			{ label: "中", value: "medium" },
			{ label: "高", value: "high" },
		]);
	});

	test("uses the same three semantic values for every supported model", () => {
		expect(productReasoningEfforts(["low", "medium", "xhigh"])).toEqual([
			{ label: "低", value: "low" },
			{ label: "中", value: "medium" },
			{ label: "高", value: "high" },
		]);
	});
});

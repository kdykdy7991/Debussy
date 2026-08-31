import type { AgentModelParameters } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	modelParameterCapabilities,
	resolveModelStreamOptions,
	validateModelParameters,
	withConversationEffort,
} from "../src/model-parameters.ts";

describe("model parameters", () => {
	const qwen = modelParameterCapabilities({
		id: "Qwen3.8-Agent",
		api: "openai-completions",
		reasoning: true,
	});

	test("uses the configured reasoning flag without model-name hardcoding", () => {
		expect(qwen.reasoning).toMatchObject({
			supported: true,
			toggle: true,
			efforts: ["low", "medium", "high"],
		});
		expect(Object.keys(qwen)).toEqual(["reasoning"]);
	});

	test("generic reasoning models expose only three product effort tiers", () => {
		const generic = modelParameterCapabilities({ id: "generic-reasoner", api: "openai-responses", reasoning: true });
		expect(generic.reasoning).toEqual({
			supported: true,
			toggle: true,
			efforts: ["low", "medium", "high"],
		});
	});

	test("accepts product tiers but rejects provider-specific efforts", () => {
		expect(validateModelParameters({ reasoning: { effort: "high" } }, qwen)).not.toContain(
			"parameters.reasoning.effort must be one of: low, medium, high",
		);
		expect(validateModelParameters({ reasoning: { effort: "xhigh" } }, qwen)).toContain(
			"parameters.reasoning.effort must be one of: low, medium, high",
		);
		const unsupported = { sampling: { topP: 0.9 } } as unknown as AgentModelParameters;
		expect(validateModelParameters(unsupported, qwen)).toContain("parameters.sampling is not supported");
	});

	test("resolves reasoning without accepting request-level sampling options", () => {
		const resolved = resolveModelStreamOptions({ reasoning: { enabled: true, effort: "medium" } });
		expect(resolved.thinkingLevel).toBe("medium");
		expect(resolved.streamOptions).toEqual({});
	});

	test("disabled reasoning maps to off", () => {
		const resolved = resolveModelStreamOptions({ reasoning: { enabled: false } });
		expect(resolved.thinkingLevel).toBe("off");
		expect(resolved.streamOptions).toEqual({});
	});

	test("keeps the stable high product tier when thinking is enabled without an explicit effort", () => {
		expect(resolveModelStreamOptions({ reasoning: { enabled: true } }, "Qwen3.8-Agent").thinkingLevel).toBe("high");
	});

	test("does not infer reasoning or sampling presets from a model name", () => {
		const resolved = resolveModelStreamOptions({}, "Qwen3.8-Agent");
		expect(resolved.thinkingLevel).toBeUndefined();
		expect(resolved.streamOptions).toEqual({});
	});

	test("does not infer instruction sampling from a model name", () => {
		const resolved = resolveModelStreamOptions({ reasoning: { enabled: false } }, "Qwen3.8-Agent");
		expect(resolved.streamOptions).toEqual({});
	});

	test("keeps product tiers model-independent until the provider request is built", () => {
		expect(
			resolveModelStreamOptions({ reasoning: { enabled: true, effort: "high" } }, "Qwen3.8-Agent").thinkingLevel,
		).toBe("high");
		expect(
			resolveModelStreamOptions({ reasoning: { enabled: true, effort: "high" } }, "generic-reasoner").thinkingLevel,
		).toBe("high");
	});

	test("rejects reasoning parameters for a model that does not support reasoning", () => {
		const plain = modelParameterCapabilities({ id: "gpt-4", api: "openai-completions", reasoning: false });
		expect(plain.reasoning.supported).toBe(false);
		expect(plain.reasoning.efforts).toEqual([]);
		expect(validateModelParameters({ reasoning: { enabled: true } }, plain)).toContain(
			"parameters.reasoning is not supported by this model",
		);
		expect(validateModelParameters({ reasoning: { effort: "high" } }, plain)).toContain(
			"parameters.reasoning is not supported by this model",
		);
	});

	test("rejects unknown top-level and nested reasoning fields", () => {
		const unknownTop = { reasoning: { effort: "high" }, temperature: 0.9 } as unknown as AgentModelParameters;
		expect(validateModelParameters(unknownTop, qwen)).toContain("parameters.temperature is not supported");
		const unknownNested = { reasoning: { effort: "high", budget_tokens: 100 } } as unknown as AgentModelParameters;
		expect(validateModelParameters(unknownNested, qwen)).toContain(
			"parameters.reasoning.budget_tokens is not supported",
		);
	});

	test("conversation effort override takes precedence over Revision config and default", () => {
		// 会话覆盖为 null → 回落 Revision 参数（未改动原对象）。
		expect(withConversationEffort({ reasoning: { effort: "low" } }, null)).toEqual({ reasoning: { effort: "low" } });
		expect(withConversationEffort({}, null)).toEqual({});
		// 会话覆盖非 null → 强制 enabled + effort，忽略 Revision 里的档位。
		expect(withConversationEffort({ reasoning: { enabled: false, effort: "low" } }, "high")).toEqual({
			reasoning: { enabled: true, effort: "high" },
		});
		// 会话覆盖在默认之上的效果：`{}`(默认) + 会话 high → 解析出 thinkingLevel high。
		expect(resolveModelStreamOptions(withConversationEffort({}, "high"), "generic-reasoner").thinkingLevel).toBe(
			"high",
		);
		// 会话覆盖压过 Revision 配置：Revision low 被会话 high 覆盖。
		expect(
			resolveModelStreamOptions(withConversationEffort({ reasoning: { effort: "low" } }, "high"), "generic-reasoner")
				.thinkingLevel,
		).toBe("high");
		// 会话只保存产品档位；provider 在构建请求时按当前模型映射。
		expect(resolveModelStreamOptions(withConversationEffort({}, "high"), "Qwen3.8-Agent").thinkingLevel).toBe("high");
	});

	test("withConversationEffort refuses nothing and only shapes reasoning fields", () => {
		// sample/gen 覆盖不可经会话 effort 引入：输出仍只含 reasoning。
		const effective = withConversationEffort({}, "medium");
		expect(Object.keys(effective)).toEqual(["reasoning"]);
		expect(Object.keys(effective.reasoning ?? {})).toEqual(["enabled", "effort"]);
	});
});

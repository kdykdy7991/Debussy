import type { AgentModelParameters } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	modelParameterCapabilities,
	resolveModelStreamOptions,
	resolveReasoningEffort,
	validateModelParameters,
} from "../src/model-parameters.ts";

describe("model parameters", () => {
	const qwen = modelParameterCapabilities({
		id: "Qwen3.8-Agent",
		api: "openai-completions",
		reasoning: true,
	});

	test("Qwen3.8 exposes only model-specific reasoning capabilities", () => {
		expect(qwen.reasoning).toMatchObject({
			supported: true,
			toggle: true,
			efforts: ["low", "medium", "high"],
			defaultEffort: "high",
		});
		expect(Object.keys(qwen)).toEqual(["reasoning"]);
	});

	test("generic reasoning models expose only three product effort tiers", () => {
		const generic = modelParameterCapabilities({ id: "generic-reasoner", api: "openai-responses", reasoning: true });
		expect(generic.reasoning.efforts).toEqual(["low", "medium", "high"]);
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

	test("uses Qwen3.8 xhigh when thinking is enabled without an explicit effort", () => {
		expect(resolveModelStreamOptions({ reasoning: { enabled: true } }, "Qwen3.8-Agent").thinkingLevel).toBe("xhigh");
	});

	test("uses the complete Qwen3.8 thinking preset by default", () => {
		const resolved = resolveModelStreamOptions({}, "Qwen3.8-Agent");
		expect(resolved.thinkingLevel).toBe("xhigh");
		expect(resolved.streamOptions).toMatchObject({
			temperature: 1,
			samplingParams: {
				top_p: 0.95,
				top_k: 20,
				min_p: 0,
				presence_penalty: 0,
				repetition_penalty: 1,
			},
		});
	});

	test("uses fixed Qwen3.8 instruction sampling when thinking is disabled", () => {
		const resolved = resolveModelStreamOptions({ reasoning: { enabled: false } }, "Qwen3.8-Agent");
		expect(resolved.streamOptions).toMatchObject({
			temperature: 0.7,
			samplingParams: { top_p: 0.8, top_k: 20, presence_penalty: 1.5 },
		});
	});

	test("maps the stable high product tier to Qwen3.8 xhigh", () => {
		expect(
			resolveModelStreamOptions({ reasoning: { enabled: true, effort: "high" } }, "Qwen3.8-Agent").thinkingLevel,
		).toBe("xhigh");
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

	test("resolveReasoningEffort maps stable tiers to concrete model levels", () => {
		expect(resolveReasoningEffort("high", "Qwen3.8-Agent")).toBe("xhigh");
		expect(resolveReasoningEffort("minimal", "Qwen3.8-Agent")).toBe("low");
		expect(resolveReasoningEffort("max", "Qwen3.8-Agent")).toBe("xhigh");
		expect(resolveReasoningEffort("high", "generic-reasoner")).toBe("high");
		expect(resolveReasoningEffort("medium", "generic-reasoner")).toBe("medium");
	});
});

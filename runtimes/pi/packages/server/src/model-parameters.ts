import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
	AgentModelParameters,
	ModelParameterCapabilities,
	ReasoningEffort,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";

const PRODUCT_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

const QWEN38_THINKING_SAMPLING = {
	temperature: 1,
	samplingParams: { top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repetition_penalty: 1 },
} as const;
const QWEN38_INSTRUCTION_SAMPLING = {
	temperature: 0.7,
	samplingParams: { top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, repetition_penalty: 1 },
} as const;

export function modelParameterCapabilities(input: {
	readonly id: string;
	readonly api: string;
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: Readonly<Record<string, unknown>>;
}): ModelParameterCapabilities {
	const qwen38 = isQwen38(input.id);
	const efforts = input.reasoning || qwen38 ? PRODUCT_EFFORTS : [];
	return {
		reasoning: {
			supported: input.reasoning || qwen38,
			toggle: qwen38,
			efforts,
			...(qwen38 ? { defaultEffort: "high" as const } : {}),
		},
	};
}

function isQwen38(modelId: string): boolean {
	return /qwen[\s._-]*3[\s._-]*8/i.test(modelId);
}

export function validateModelParameters(
	parameters: AgentModelParameters,
	capabilities: ModelParameterCapabilities,
): readonly string[] {
	const errors: string[] = [];
	const allowedTop = new Set(["reasoning"]);
	for (const key of Object.keys(parameters))
		if (!allowedTop.has(key)) errors.push(`parameters.${key} is not supported`);
	const reasoning = parameters.reasoning;
	if (reasoning) {
		const allowedReasoning = new Set(["enabled", "effort"]);
		for (const key of Object.keys(reasoning))
			if (!allowedReasoning.has(key)) errors.push(`parameters.reasoning.${key} is not supported`);
		if (!capabilities.reasoning.supported) errors.push("parameters.reasoning is not supported by this model");
		if (reasoning.enabled !== undefined && !capabilities.reasoning.toggle)
			errors.push("parameters.reasoning.enabled is not supported by this model");
		if (reasoning.effort !== undefined && !capabilities.reasoning.efforts.includes(reasoning.effort))
			errors.push(`parameters.reasoning.effort must be one of: ${capabilities.reasoning.efforts.join(", ")}`);
	}
	return errors;
}

export function resolveModelStreamOptions(
	parameters: AgentModelParameters,
	modelId = "",
): {
	readonly thinkingLevel?: ThinkingLevel;
	readonly streamOptions: Pick<
		SimpleStreamOptions,
		"temperature" | "samplingParams" | "maxTokens" | "thinkingBudgets"
	>;
} {
	const reasoning = parameters.reasoning;
	const qwen38 = isQwen38(modelId);
	const fixedStreamOptions = qwen38
		? reasoning?.enabled === false
			? QWEN38_INSTRUCTION_SAMPLING
			: QWEN38_THINKING_SAMPLING
		: {};
	const configuredEffort =
		reasoning?.effort ??
		(reasoning?.enabled === true || (qwen38 && reasoning?.enabled !== false) ? "high" : undefined);
	return {
		...(reasoning?.enabled === false
			? { thinkingLevel: "off" as const }
			: configuredEffort !== undefined
				? { thinkingLevel: configuredEffort as ThinkingLevel }
				: {}),
		streamOptions: fixedStreamOptions,
	};
}

/**
 * Overlay a conversation-level effort override onto the Agent Revision's frozen
 * parameters (V2-README §4.3). Fixed precedence: **会话覆盖 > Revision 配置 > 默认**.
 *
 * - `effort === null` → 清除会话覆盖，直接采用 Revision 参数（回落到 Revision 默认）。
 * - `effort` 为合法档位 → 强制 `reasoning.enabled = true` 并把 `reasoning.effort`
 *   覆盖为该档位（无论 Revision 里写的是什么）。
 *
 * 该函数是纯函数（不触库/不发请求），调用方先取会话固定版本的参数再叠加此覆盖，
 * 供 `resolveModelStreamOptions` → Provider wire payload 使用。
 */
export function withConversationEffort(
	base: AgentModelParameters,
	effort: ReasoningEffort | null,
): AgentModelParameters {
	if (effort === null) return base;
	return {
		reasoning: {
			enabled: true,
			effort,
		},
	};
}

/** 冻结能力的运行时默认档位（不可关闭思考的模型必须有显式档位）。 */
export function capabilityDefaultEffort(
	parameterCapabilities: ModelParameterCapabilities | undefined,
): ReasoningEffort | undefined {
	const reasoning = parameterCapabilities?.reasoning;
	if (reasoning === undefined || !reasoning.supported) return undefined;
	if (reasoning.defaultEffort !== undefined) return reasoning.defaultEffort;
	if (!reasoning.toggle) return reasoning.efforts[0];
	return undefined;
}

/** 从 `params` 读取合法 legacy thinkingLevel；缺失/非法返回 undefined。 */
export function legacyThinkingLevelFrom(params: AgentModelParameters | undefined): ThinkingLevel | undefined {
	if (params === undefined || typeof params !== "object" || params === null) return undefined;
	const raw = (params as Record<string, unknown>).thinkingLevel;
	if (typeof raw !== "string" || !LEGACY_THINKING_LEVELS.has(raw as ThinkingLevel)) return undefined;
	return raw as ThinkingLevel;
}

const LEGACY_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Effective model options with the single Production precedence:
 *
 *   explicit `params.reasoning.{enabled,effort}`
 *     → legacy `params.thinkingLevel`
 *     → model capability `defaultEffort` (non-toggle models fall back to efforts[0])
 *     → off/none
 *
 * Production and Debug conversations share this one resolver so a given Agent
 * Revision + model + config yields the same reasoning behaviour in both.
 */
export function resolveEffectiveModelOptions(input: {
	readonly params: AgentModelParameters | undefined;
	readonly modelId: string;
	readonly parameterCapabilities?: ModelParameterCapabilities;
	readonly conversationEffort?: ReasoningEffort | null;
}): {
	readonly thinkingLevel?: ThinkingLevel;
	readonly streamOptions: Pick<
		SimpleStreamOptions,
		"temperature" | "samplingParams" | "maxTokens" | "thinkingBudgets"
	>;
} {
	const base = input.params ?? {};
	let resolved = resolveModelStreamOptions(
		withConversationEffort(base, input.conversationEffort ?? null),
		input.modelId,
	);
	const legacy = legacyThinkingLevelFrom(input.params);
	if (resolved.thinkingLevel === undefined && legacy === undefined) {
		const fallbackEffort = capabilityDefaultEffort(input.parameterCapabilities);
		if (fallbackEffort !== undefined) {
			resolved = resolveModelStreamOptions(withConversationEffort(base, fallbackEffort), input.modelId);
		}
	}
	const thinkingLevel = resolved.thinkingLevel ?? legacy;
	return {
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		streamOptions: resolved.streamOptions,
	};
}

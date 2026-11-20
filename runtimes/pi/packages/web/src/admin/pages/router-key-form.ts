import type { RouterCapabilities } from "../api/aaas-keys-api.ts";

type ModelParameters = RouterCapabilities["model"]["parameters"];
export const maxRouterMcpServers = 8;
export const maxRouterMcpTools = 128;

export function updateMcpToolAllowlist(current: readonly string[], tools: readonly string[], checked: boolean) {
	return checked ? [...new Set([...current, ...tools])] : current.filter((tool) => !tools.includes(tool));
}

export const modelParameterFields = [
	{ key: "temperature", label: "温度", aliases: [], integer: false },
	{ key: "maxTokens", label: "最大输出 Token", aliases: ["max_tokens"], integer: true },
	{ key: "topP", label: "Top P", aliases: ["top_p"], integer: false },
	{ key: "presencePenalty", label: "话题惩罚", aliases: [], integer: false },
	{ key: "frequencyPenalty", label: "频率惩罚", aliases: [], integer: false },
] as const;

export type ModelParameterEdits = Partial<Record<(typeof modelParameterFields)[number]["key"], string>>;

export function parameterKey(parameters: ModelParameters, field: (typeof modelParameterFields)[number]): string {
	return [field.key, ...field.aliases].find((key) => Object.hasOwn(parameters, key)) ?? field.key;
}

export function readModelParameters(
	current: ModelParameters,
	edits: ModelParameterEdits,
	advanced: string | null,
): { parameters: ModelParameters; error?: never } | { parameters?: never; error: string } {
	if (advanced !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(advanced);
		} catch {
			return { error: "模型参数须为合法的 JSON 对象。" };
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			return { error: "模型参数须为 JSON 对象。无参数时可填 {}。" };
		for (const [key, value] of Object.entries(parsed)) {
			if (!modelParameterFields.some((field) => field.key === key || field.aliases.some((alias) => alias === key)))
				return { error: `模型参数不支持「${key}」。` };
			if (
				value !== null &&
				typeof value !== "string" &&
				typeof value !== "boolean" &&
				(typeof value !== "number" || !Number.isFinite(value))
			) {
				return { error: "模型参数的值须为数字、字符串、布尔值或 null。" };
			}
		}
		return { parameters: parsed as ModelParameters };
	}
	const parameters = { ...current };
	for (const field of modelParameterFields) {
		const value = edits[field.key]?.trim();
		if (value === undefined) continue;
		if (value === "") {
			for (const key of [field.key, ...field.aliases]) delete parameters[key];
			continue;
		}
		const numeric = Number(value);
		if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(numeric))
			return { error: `「${field.label}」须填写有效数字。` };
		if (field.integer && (!Number.isInteger(numeric) || numeric < 1))
			return { error: `「${field.label}」须填写正整数。` };
		parameters[parameterKey(parameters, field)] = numeric;
	}
	return { parameters };
}

export function sameKeyConfiguration(saved: RouterCapabilities, draft: RouterCapabilities): boolean {
	const stable = (value: RouterCapabilities) =>
		JSON.stringify({ ...value, local_tools: value.local_tools ?? [] }, (_key, child: unknown) =>
			child !== null && typeof child === "object" && !Array.isArray(child)
				? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)))
				: child,
		);
	return stable(saved) === stable(draft);
}

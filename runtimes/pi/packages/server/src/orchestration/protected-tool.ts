import { type TSchema, Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCredentialBinding } from "@earendil-works/pi-protocol";
import { OrchestrationError } from "./contracts.ts";

/** Validate the deliberately narrow top-level binding supported by the first adapter. */
export function modelToolSchema(schema: Readonly<Record<string, unknown>>, bindings: readonly ToolCredentialBinding[]) {
	if (bindings.length === 0) return schema;
	const allowed = new Set([
		"type",
		"properties",
		"required",
		"additionalProperties",
		"description",
		"title",
		"$schema",
	]);
	if (
		schema.type !== "object" ||
		Object.keys(schema).some((key) => !allowed.has(key)) ||
		!schema.properties ||
		typeof schema.properties !== "object" ||
		Array.isArray(schema.properties)
	) {
		throw new OrchestrationError(400, "UNSUPPORTED_BINDING", "凭据绑定只支持简单对象的顶层字符串参数");
	}
	const properties = { ...(schema.properties as Record<string, unknown>) };
	const parameters = new Set<string>();
	for (const binding of bindings) {
		const field = properties[binding.parameter] as { type?: unknown } | undefined;
		if (!field || field.type !== "string" || parameters.has(binding.parameter)) {
			throw new OrchestrationError(400, "INVALID_BINDING", "凭据参数缺失、类型错误或重复");
		}
		parameters.add(binding.parameter);
		delete properties[binding.parameter];
	}
	return {
		...schema,
		properties,
		required: Array.isArray(schema.required) ? schema.required.filter((key) => !parameters.has(String(key))) : [],
	};
}

/** The model sees only business arguments; the transport alone receives credentials. */
export function protectTool(
	tool: ToolDefinition,
	schema: Readonly<Record<string, unknown>>,
	bindings: readonly ToolCredentialBinding[],
	load: () => Promise<Readonly<Record<string, string>>>,
): ToolDefinition {
	if (bindings.length === 0) return tool;
	return {
		...tool,
		parameters: Type.Unsafe<Record<string, unknown>>(modelToolSchema(schema, bindings) as TSchema),
		execute: async (id, params, signal, onUpdate, context) => {
			const credentials = await load();
			const secrets = Object.values(credentials);
			const clean = (value: unknown): unknown => {
				const json = JSON.stringify(value);
				if (json === undefined) return value;
				let text = json;
				for (const secret of secrets) text = text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
				return JSON.parse(text) as unknown;
			};
			try {
				if (params === null || typeof params !== "object" || Array.isArray(params))
					throw new Error("Invalid arguments");
				const args: Record<string, unknown> = { ...params };
				for (const binding of bindings) {
					const value = credentials[binding.credential];
					if (!value) throw new Error("Missing tool credential");
					args[binding.parameter] = value;
				}
				const validated: unknown = validateToolArguments(
					{ name: tool.name, description: tool.description, parameters: Type.Unsafe(schema as TSchema) },
					{ type: "toolCall", id, name: tool.name, arguments: args },
				);
				const result = await tool.execute(
					id,
					validated as Record<string, unknown>,
					signal,
					onUpdate ? (update) => onUpdate(clean(update) as typeof update) : undefined,
					context,
				);
				return clean(result) as typeof result;
			} catch {
				throw new Error("受保护工具调用失败，请检查任务凭据、工具参数或服务状态");
			}
		},
	};
}

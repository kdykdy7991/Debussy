import { asRecord, INTERNAL_TRIGGER_MESSAGE, readString, safeJson } from "./session-view-helpers.ts";

export const CONTEXT_CATEGORIES = ["system", "tools", "user", "assistant", "tool", "other"] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];
export const CONTEXT_LABELS: Record<ContextCategory, string> = {
	system: "系统提示词",
	tools: "工具定义",
	user: "用户消息",
	assistant: "助手消息",
	tool: "工具结果",
	other: "其他内容",
};

export interface ContextEntry {
	readonly key: string;
	readonly category: ContextCategory;
	readonly label: string;
	readonly position: number | null;
	readonly text: string;
	readonly value: unknown;
}

/** Preserve block order and unknown block types; never hide non-text content. */
export function readableContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return safeJson(value) ?? "（无内容）";
	return value
		.map((part: unknown) => {
			const block = asRecord(part);
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return `思考\n${block.thinking}`;
			if (block.type === "toolCall")
				return `调用工具 · ${readString(block, "name")} · ${readString(block, "id")}\n${safeJson(block.arguments) ?? "（无参数）"}`;
			return safeJson(part) ?? "（无内容）";
		})
		.join("\n\n");
}

/** Project only the persisted pi Context shape. Unknown fields stay browsable. */
export function contextEntries(request: unknown): readonly ContextEntry[] {
	const record = asRecord(request);
	const entries: ContextEntry[] = [];
	if (record.systemPrompt !== undefined && record.systemPrompt !== "")
		entries.push({
			key: "system",
			category: "system",
			label: "System",
			position: null,
			text: readableContent(record.systemPrompt),
			value: record.systemPrompt,
		});
	if (Array.isArray(record.tools))
		record.tools.forEach((value: unknown, index: number) => {
			entries.push({
				key: `tool-${index}`,
				category: "tools",
				label: readString(asRecord(value), "name") || `工具 ${index + 1}`,
				position: null,
				text: safeJson(value),
				value,
			});
		});
	if (Array.isArray(record.messages))
		record.messages.forEach((value: unknown, index: number) => {
			const message = asRecord(value);
			const role = readString(message, "role");
			const category: ContextCategory =
				role === "user" ? "user" : role === "assistant" ? "assistant" : role === "toolResult" ? "tool" : "other";
			const name = readString(message, "toolName");
			const id = readString(message, "toolCallId");
			const text = readableContent(message.content ?? value);
			entries.push({
				key: `message-${index}`,
				category,
				label:
					role === "user" && text === INTERNAL_TRIGGER_MESSAGE
						? "内部触发消息 · user"
						: [role || "未知角色", name, id].filter(Boolean).join(" · "),
				position: index + 1,
				text,
				value,
			});
		});
	for (const [key, value] of Object.entries(record)) {
		if (key === "systemPrompt" || key === "tools" || key === "messages") {
			if (key === "systemPrompt" || Array.isArray(value)) continue;
		}
		entries.push({
			key: `other-${key}`,
			category: "other",
			label: key,
			position: null,
			text: safeJson(value),
			value,
		});
	}
	if (entries.length === 0 && (typeof request !== "object" || request === null || Array.isArray(request)))
		entries.push({
			key: "unknown",
			category: "other",
			label: "原始请求",
			position: null,
			text: readableContent(request),
			value: request,
		});
	return entries;
}

/** Exact comparison only: a changed history is not assumed to be append-only. */
export function compareContexts(previous: unknown, current: unknown): string {
	const before = asRecord(previous);
	const after = asRecord(current);
	const notes: string[] = [];
	if (safeJson(before.systemPrompt) !== safeJson(after.systemPrompt)) notes.push("系统提示词已变化");
	if (safeJson(before.tools) !== safeJson(after.tools)) notes.push("工具定义已变化");
	if (Array.isArray(before.messages) && Array.isArray(after.messages)) {
		let prefix = 0;
		while (
			prefix < before.messages.length &&
			prefix < after.messages.length &&
			safeJson(before.messages[prefix]) === safeJson(after.messages[prefix])
		)
			prefix += 1;
		if (prefix === before.messages.length && prefix === after.messages.length) notes.push("消息内容一致");
		else if (prefix === before.messages.length) notes.push(`消息末尾新增 ${after.messages.length - prefix} 条`);
		else
			notes.push(
				`前 ${prefix} 条消息一致，此后内容变化（上次 ${before.messages.length} 条 → 本次 ${after.messages.length} 条）`,
			);
	} else notes.push("消息结构无法比较");
	const extraFields = (record: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(record).filter(([key]) => key !== "systemPrompt" && key !== "tools" && key !== "messages"),
		);
	if (safeJson(extraFields(before)) !== safeJson(extraFields(after))) notes.push("其他请求字段已变化");
	return notes.join("；");
}

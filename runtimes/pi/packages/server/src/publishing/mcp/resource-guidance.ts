import type { McpResourceReferences } from "./resource-content.ts";

export const MCP_RESOURCE_GUIDANCE = `[MCP 图片与资源使用规则]
用户要求查看图片时，先检索相关内容，再获取关联资源并读取。存在 search_chunks 时优先使用它；query_knowledge_hub 的文字或 [IMAGE: ...] 标记不代表可读取的资源地址，应继续获取文档或片段详情。
只使用工具返回的 resources.read_tool 和 resources.items[].uri，原样传递 URI；不得根据文件名、图片 ID、历史回答或本地目录猜测、拼接 file://、Windows 路径或其他资源地址。
每份资源只属于返回它的 MCP 服务，不要换用其他服务的资源读取工具。读取失败时，严格按错误中的 next_action 补充查询或重试；不要把同一个错误地址轮流发给其他服务。
仅读取与问题相关的图片，避免附带无关 Logo。成功读取的图片由平台自动展示，不必再生成本地图片链接。未成功读取时不要声称已经看过图片。`;

export interface McpResourceBinding {
	readonly serverName: string;
	readonly serverId: string;
	readonly readTool: string;
	readonly toolNames: readonly string[];
	readonly references: McpResourceReferences;
}

export function mcpToolDescription(binding: McpResourceBinding, name: string, description: string | null): string {
	const source = `MCP 服务：${JSON.stringify(binding.serverName)}；服务 ID：${binding.serverId}。`;
	if (name === binding.readTool) {
		return `${source}\n读取此服务已经返回的图片或资源。先用此服务的检索/文档工具获取 resources，再使用 resources.items 中的确切 URI。不要猜测本地路径、file:// 地址或自行拼接图片地址，不要读取其他 MCP 服务的资源。资源未发现时按错误中的 next_action 操作，不要盲目切换服务。成功读取的图片由平台自动展示。`;
	}
	const instructions = [`${source}\n${description ?? name}`];
	if (name === "search_chunks")
		instructions.push(
			"检索文档时优先使用本工具。需要图片时，选择返回的关联资源，并按 resources.read_tool 读取对应 resources.items[].uri。",
		);
	if (name === "query_knowledge_hub")
		instructions.push(
			`本工具只返回检索文字，不提供完整图片资源引用。需要图片时${binding.toolNames.includes("search_chunks") ? "优先使用 search_chunks，或" : ""}继续获取文档/片段详情；不要将 [IMAGE: ...] 当作图片地址。`,
		);
	if (name === "get_document" || name === "get_chunk")
		instructions.push(
			"图片关联资源及所属读取工具由平台附在 resources 中，取图时原样使用，不能根据图片 ID 拼接本地路径。",
		);
	return instructions.join("\n");
}

function documentRecovery(
	binding: McpResourceBinding,
	references: McpResourceReferences,
): Readonly<Record<string, unknown>> {
	const documents = references.documents();
	const tool = binding.toolNames.includes("get_document")
		? "get_document"
		: binding.toolNames.includes("search_chunks")
			? "search_chunks"
			: undefined;
	return {
		...(tool ? { tool } : {}),
		...(tool === "get_document" && documents.length === 1
			? { arguments: { document_id: documents[0]!.document_id } }
			: {}),
		instruction:
			"先获取此服务的文档/片段详情或重新检索，拿到关联资源后再读取；不要从 [IMAGE: ...] 标记或文件名猜测地址。",
	};
}

export function mcpResultGuidance(
	binding: McpResourceBinding,
	references: McpResourceReferences,
): Readonly<Record<string, unknown>> {
	const items = references.items();
	const documents = references.documents();
	const source = { service_name: binding.serverName, mcp_server_id: binding.serverId };
	if (items.length > 0) {
		return {
			source,
			resources: {
				read_tool: binding.readTool,
				items: items.slice(0, 16),
				truncated: items.length > 16,
				next_action: "选择与问题相关的资源，将其 uri 原样传给 read_tool；不要使用其他 MCP 服务或本地文件地址。",
			},
		};
	}
	if (documents.length > 0) {
		return {
			source,
			resource_guidance: {
				documents: documents.slice(0, 8),
				truncated: documents.length > 8,
				next_action: documentRecovery(binding, references),
			},
		};
	}
	return { source };
}

export function mcpResourceReadError(
	binding: McpResourceBinding,
	uri: unknown,
	bindings: readonly McpResourceBinding[],
): Error {
	const owner = typeof uri === "string" ? bindings.find((candidate) => candidate.references.has(uri)) : undefined;
	if (owner !== undefined && owner !== binding) {
		return new Error(
			`MCP_RESOURCE_WRONG_SERVER: 资源属于 ${JSON.stringify(owner.serverName)}，不能通过 ${JSON.stringify(binding.serverName)} 读取。\n${JSON.stringify({ next_action: { tool: owner.readTool, arguments: { uri } } })}`,
		);
	}
	const localPath = typeof uri === "string" && (/^file:/i.test(uri) || /^[A-Za-z]:[\\/]/.test(uri));
	const fallback = mcpResultGuidance(binding, binding.references);
	return new Error(
		`MCP_RESOURCE_NOT_DISCOVERED: resource was not discovered in this session. ${localPath ? "传入的是本地文件地址，不能将它当作尚未发现的 MCP 资源。" : "此地址尚未由当前 MCP 服务返回。"} 不要重复提交此地址，也不要换其他服务尝试。\n${JSON.stringify({ ...fallback, next_action: binding.references.items().length > 0 ? { instruction: "从 resources.items 选择服务已返回的确切 URI，使用 resources.read_tool 读取。" } : documentRecovery(binding, binding.references) })}`,
	);
}

import type { TranscriptMessage } from "../../types.ts";
import type { McpResourceBinding } from "./resource-guidance.ts";

/** Replays only successful, paired MCP results from this runtime's authorized conversation history. */
export function restoreMcpResourceReferences(
	bindings: readonly McpResourceBinding[],
	transcript: readonly TranscriptMessage[],
): void {
	const calls = new Map<string, string>();
	for (const message of transcript) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.toolCallId, block.toolName);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const calledTool = calls.get(message.toolCallId);
		calls.delete(message.toolCallId);
		if (message.isError || calledTool !== message.toolName) continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			let envelope: unknown;
			try {
				envelope = JSON.parse(block.text);
			} catch {
				continue; // Plain text, summaries, and truncated JSON cannot authorize a resource.
			}
			if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) continue;
			const row = envelope as Record<string, unknown>;
			const source =
				row.source !== null && typeof row.source === "object" ? (row.source as Record<string, unknown>) : undefined;
			const resources =
				row.resources !== null && typeof row.resources === "object"
					? (row.resources as Record<string, unknown>)
					: undefined;
			const readTool = resources?.read_tool ?? resources?.tool;
			const binding = bindings.find(
				(candidate) =>
					(message.toolName === candidate.readTool || candidate.toolNames.includes(message.toolName)) &&
					(source?.mcp_server_id === candidate.serverId ||
						(source?.mcp_server_id === undefined && readTool === candidate.readTool)) &&
					(readTool === undefined || readTool === candidate.readTool),
			);
			if (!binding) continue;
			binding.references.discover(row);
			// The initial platform envelope used a plain string URI list.
			if (Array.isArray(resources?.uris)) {
				for (const uri of resources.uris.slice(-256)) {
					if (typeof uri === "string") binding.references.discover({ uri });
				}
			}
			// MCP servers may serialize their structured payload into text blocks.
			if (Array.isArray(row.content)) {
				for (const entry of row.content) {
					if (
						entry === null ||
						typeof entry !== "object" ||
						entry.type !== "text" ||
						typeof entry.text !== "string"
					)
						continue;
					try {
						binding.references.discover(JSON.parse(entry.text));
					} catch {
						/* Plain text is not a descriptor. */
					}
				}
			}
		}
	}
}

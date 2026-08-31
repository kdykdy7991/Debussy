/**
 * Map the server's structured restore transcript to the coding-agent's native
 * `AgentMessage` sequence so the next prompt's model request contains real
 * `assistant(toolCall)` + `toolResult` turns.
 *
 * The mapping builds Pi's own message shapes (UserMessage / AssistantMessage /
 * ToolResultMessage) from the durable Postgres-derived transcript. It is pure:
 * given a transcript it returns the native messages, so it is trivially
 * testable and shared by Production + Debug restores.
 */
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { TranscriptContentBlock, TranscriptMessage } from "../types.ts";

/** Conservative zero-cost usage so injected assistant messages never trigger compaction on `usage`. */
function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toTextOrImage(block: TranscriptContentBlock): TextContent | ImageContent | null {
	if (block.type === "text") return { type: "text", text: block.text };
	if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
	return null; // toolCall never lands in user/text content
}

export interface ToAgentMessagesOptions {
	/** Effective model for reconstructed assistant messages. */
	readonly provider?: string;
	readonly model?: string;
	/** Current wall-clock used to normalise missing timestamps. */
	readonly now?: number;
}

export type HistoryAgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage;

export function toAgentMessages(
	transcript: readonly TranscriptMessage[],
	options: ToAgentMessagesOptions = {},
): HistoryAgentMessage[] {
	const now = options.now ?? Date.now();
	const provider = options.provider ?? "pi";
	const model = options.model ?? "";
	const out: HistoryAgentMessage[] = [];

	for (const item of transcript) {
		if (item.role === "user") {
			const content: (TextContent | ImageContent)[] = [];
			for (const block of item.content) {
				const c = toTextOrImage(block);
				if (c !== null) content.push(c);
			}
			out.push({ role: "user", content, timestamp: now });
		} else if (item.role === "assistant") {
			const hasToolCall = item.content.some((block) => block.type === "toolCall");
			const content: Array<TextContent | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> =
				[];
			for (const block of item.content) {
				if (block.type === "toolCall") {
					content.push({
						type: "toolCall",
						id: block.toolCallId,
						name: block.toolName,
						arguments: (block.input ?? {}) as Record<string, unknown>,
					});
				} else if (block.type === "text") {
					content.push({ type: "text", text: block.text });
				}
				// image / other blocks are not valid assistant content; skipped.
			}
			out.push({
				role: "assistant",
				content,
				api: provider,
				provider,
				model,
				usage: zeroUsage(),
				stopReason: hasToolCall ? "toolUse" : "stop",
				timestamp: now,
			});
		} else if (item.role === "toolResult") {
			const content: (TextContent | ImageContent)[] = [];
			for (const block of item.content) {
				const c = toTextOrImage(block);
				if (c !== null) content.push(c);
			}
			out.push({
				role: "toolResult",
				toolCallId: item.toolCallId,
				toolName: item.toolName,
				content,
				isError: item.isError,
				timestamp: now,
			});
		}
	}
	return out;
}
/**
 * Shared tool-event payload builder (Production embed + Debug).
 *
 * Phase-1 + 2.5: the persisted tool events must carry every piece of the model
 * history that is actually part of the model context, so that a Postgres-only
 * rebuild can restore it byte-for-byte. That means:
 *
 * - `tool/call` persists the exact model-generated `arguments` (`item.input`)
 *   as JSONB — never dropping args and never second-truncating them.
 * - `tool/result` persists the exact content the model saw at runtime
 *   (`item.content`), which is already bounded by the MCP `toolResultMaxBytes`
 *   read path. The event applies NO additional independent truncation, so a
 *   Postgres-restored result is identical to what the model saw even when the
 *   operator raises `toolResultMaxBytes`. Only the runtime's own truncation
 *   marker is mirrored via `truncated`.
 *
 * Persisting the full args/content is safe because tool events append through
 * the conversation-event repository's bare `jsonb` path (toast-backed), not
 * through `assertEventPayloadSafe`'s inline ceiling; the only real runtime
 * bound is `toolResultMaxBytes` (platform-capped) on the result side.
 *
 * The builders are pure (no I/O, no DB) so both conversation services share
 * one behaviour and it is trivially testable.
 */
import type { JsonValue, ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { type DebugToolType, deriveToolType } from "../publishing/runtime/tool-type.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";

export interface ToolCallEventPayload {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolType: DebugToolType;
	readonly status: "running";
	readonly startedAt: number;
	/** The exact model-generated arguments handed to the tool, preserved as JSON (not flattened to text). */
	readonly input?: JsonValue;
}

export interface ToolResultEventPayload {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolType: DebugToolType;
	readonly status: "complete";
	readonly finishedAt: number;
	/** The content that actually entered the model context (runtime-bounded, persisted verbatim). */
	readonly content: readonly ToolResultContentBlock[];
	/** Mirrors the runtime's `ToolTranscriptItem.isError`. */
	readonly isError: boolean;
	/** True when the runtime itself truncated the model-visible content (MCP `details.resultTruncated`). */
	readonly truncated: boolean;
	/** Tool usage (tokens) recorded by the runtime, if any. */
	readonly usage?: unknown;
}

export type ToolResultContentBlock =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly data: string;
			readonly mimeType: string;
	  };

/** True when the runtime recorded a truncation marker on the tool item (MCP `details.resultTruncated`). */
function runtimeTruncated(item: ToolTranscriptItem): boolean {
	if (item.details === null || item.details === undefined || typeof item.details !== "object") return false;
	const details = item.details as { resultTruncated?: unknown };
	return details.resultTruncated === true;
}

/**
 * Build the `tool/call` event payload. `item` must be the running
 * (`item_started`) tool item so `item.input` holds the real arguments. The full
 * arguments are persisted as JSON so a Postgres-only rebuild reconstructs the
 * exact tool call; no size-based drop is applied here.
 */
export function toToolCallEventPayload(spec: RuntimeSpec, item: ToolTranscriptItem): ToolCallEventPayload {
	return {
		toolCallId: item.toolCallId,
		toolName: item.toolName,
		toolType: deriveToolType(spec, item.toolName),
		status: "running",
		startedAt: item.timestamp,
		...(item.input !== null && item.input !== undefined ? { input: item.input } : {}),
	};
}

/**
 * Build the `tool/result` event payload. `item` must be the finished
 * (`item_finished`) tool item so `item.content` / `item.isError` are final.
 * `item.content` is already the bounded, model-visible content (MCP
 * `toolResultMaxBytes`), so it is persisted verbatim with no independent
 * second truncation — Event persistence can never lose more than the model saw.
 */
export function toToolResultEventPayload(spec: RuntimeSpec, item: ToolTranscriptItem): ToolResultEventPayload {
	const contentBlocks = item.content.filter(
		(block): block is ToolResultContentBlock => block.type === "text" || block.type === "image",
	);
	return {
		toolCallId: item.toolCallId,
		toolName: item.toolName,
		toolType: deriveToolType(spec, item.toolName),
		status: "complete",
		finishedAt: item.timestamp,
		content: contentBlocks,
		isError: item.isError === true,
		truncated: runtimeTruncated(item),
		...(item.usage !== undefined ? { usage: item.usage } : {}),
	};
}

/** Extract a string error from a finished error tool item's text content. */
export function deriveToolError(item: ToolTranscriptItem): string {
	if (item.status !== "error") return "tool error";
	for (const part of item.content) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "tool error";
}

export interface ToolErrorEventPayload {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolType: DebugToolType;
	readonly status: "error";
	readonly error: string;
	readonly isError: true;
	readonly usage?: unknown;
	readonly finishedAt: number;
}

/**
 * Map one runtime tool-transcript progress update to its durable event
 * descriptor (event type + payload). This is the single source of truth used
 * by BOTH the Production embed conversation service and the Debug service, so
 * the two paths are provably identical in what they persist for tool turns:
 *
 *   item_started (running)  -> tool/call   (with arguments)
 *   item_updated            -> (nothing)
 *   item_finished complete  -> tool/result (with model-visible content)
 *   item_finished error     -> tool/error  (with message + isError:true)
 *
 * Returns `null` for progress updates that must not produce an event.
 */
export function toToolProgressEvent(
	spec: RuntimeSpec,
	progressType: "item_started" | "item_updated" | "item_finished",
	item: ToolTranscriptItem,
): { eventType: "tool/call" | "tool/result" | "tool/error"; payload: unknown } | null {
	if (progressType === "item_started") {
		if (item.status !== "running") return null;
		return { eventType: "tool/call", payload: toToolCallEventPayload(spec, item) };
	}
	if (progressType === "item_updated") return null;
	// item_finished.
	if (item.status === "complete") {
		return { eventType: "tool/result", payload: toToolResultEventPayload(spec, item) };
	}
	if (item.status === "error") {
		return {
			eventType: "tool/error",
			payload: {
				toolCallId: item.toolCallId,
				toolName: item.toolName,
				toolType: deriveToolType(spec, item.toolName),
				status: "error",
				error: deriveToolError(item),
				isError: true,
				...(item.usage !== undefined ? { usage: item.usage } : {}),
				finishedAt: item.timestamp,
			} satisfies ToolErrorEventPayload,
		};
	}
	return null;
}

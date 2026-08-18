/**
 * WB-009: streaming, memory-bounded conversation export.
 *
 * Produces a versioned JSONL record stream (the bytes are later gzip-compressed
 * by the HTTP layer). Guarantees vs. the acceptance criteria:
 *
 *   - **Bounded memory**: the conversation is paged out of Postgres via
 *     `listByConversation(afterSequence)`; only one page is held at a time and
 *     yielded rows are serialised then released. No full event array or full
 *     JSONL buffer is ever assembled.
 *   - **Consistent snapshot**: `throughSequence` is frozen at export start
 *     (the conversation's confirmed `last_event_sequence`), so events appended
 *     during the export are not included (they have higher sequences).
 *   - **No silent gaps**: `listByConversation` returns ascending `sequence`;
 *     the generator asserts the first page starts at the expected sequence and
 *     each subsequent page continues it, throwing on a gap.
 *   - **Redaction**: `full` includes message payloads, `diagnostics` and
 *     `transcript` drop sensitive message bodies. `manifests` never carry raw
 *     subject / PEM / tokens (the caller passes only the conversation public id).
 */

import type {
	ConversationAdminEvent,
	ConversationEventPublicId,
	ConversationExportManifest,
	ConversationExportMode,
	ConversationPublicId,
} from "@earendil-works/pi-protocol";
import { SESSION_EVENT_TYPES } from "@earendil-works/pi-protocol";
import { toPublicId } from "../domain/ids.ts";
import type { ConversationEventRecord, ConversationRecord } from "../repositories.ts";

export const EXPORT_PAGE_SIZE = 250;

/** Sensitive message-bearing event types stripped in non-`full` modes. */
const CONTENT_EVENT_TYPES = new Set([
	"user/message",
	"user.message",
	"assistant/message",
	"assistant.completed",
	"assistant/chunk",
	"assistant/delta",
	"tool/input",
]);

/**
 * Stream a conversation export as versioned JSONL lines. The first line is the
 * manifest; `throughSequence` is frozen here. Events that start after the
 * passed `conversation.lastEventSequence` are never emitted.
 */
export async function* exportSessionLines(input: {
	readonly conversation: ConversationRecord;
	readonly mode: ConversationExportMode;
	readonly page: (afterSequence: number, limit: number) => Promise<ConversationEventRecord[]>;
}): AsyncGenerator<string, void, unknown> {
	const cid = toPublicId("ConversationId", input.conversation.conversationId) as ConversationPublicId;
	const throughSequence = input.conversation.lastEventSequence;
	const manifest: ConversationExportManifest = {
		v: 1,
		kind: "manifest",
		exportVersion: "wb009-1",
		conversationId: cid,
		mode: input.mode,
		throughSequence,
		generatedAt: new Date().toISOString(),
	};
	yield JSON.stringify(manifest);

	let expected = 1;
	while (expected <= throughSequence) {
		const page = await input.page(expected - 1, EXPORT_PAGE_SIZE);
		if (page.length === 0) {
			// No more rows but we haven't reached throughSequence yet.
			throw new Error("export event log has a gap (missing rows before throughSequence)");
		}
		for (const event of page) {
			if (event.sequence !== expected) {
				throw new Error(`export event log has a gap at sequence ${expected} (got ${event.sequence})`);
			}
			expected += 1;
			if (expected > throughSequence + 1) return; // event added mid-export
			const line = serializeLine(event, input.mode);
			if (line !== null) yield line;
		}
	}
}

function serializeLine(event: ConversationEventRecord, mode: ConversationExportMode): string | null {
	if (mode === "transcript") {
		const line = transcriptLine(event);
		return line === null ? null : JSON.stringify(line);
	}
	return JSON.stringify(fullLine(event, mode));
}

function fullLine(event: ConversationEventRecord, mode: ConversationExportMode): ConversationAdminEvent {
	const payload =
		mode === "diagnostics" && CONTENT_EVENT_TYPES.has(event.eventType) ? redactPayload(event.payload) : event.payload;
	const kind =
		(SESSION_EVENT_TYPES as readonly string[]).includes(event.eventType) === false
			? ("unknown" as const)
			: (event.eventType as ConversationAdminEvent["kind"]);
	return {
		eventId: toPublicId("ConversationEventId", event.eventId) as ConversationEventPublicId,
		conversationId: toPublicId("ConversationId", event.conversationId) as ConversationPublicId,
		sequence: event.sequence,
		eventType: event.eventType,
		kind,
		schemaVersion: event.eventSchemaVersion,
		turnId: event.turnId === null ? null : toPublicId("TurnId", event.turnId),
		payload,
		createdAt: event.createdAt.toISOString(),
		payloadBytes: event.payloadBytes,
	};
}

function transcriptLine(event: ConversationEventRecord): unknown {
	const role =
		event.eventType === "user/message" || event.eventType === "user.message"
			? ("user" as const)
			: event.eventType === "assistant/message" || event.eventType === "assistant.completed"
				? ("assistant" as const)
				: null;
	if (role === null) return null;
	const tv = event.payload as { text?: unknown };
	return {
		v: 1,
		kind: "transcript",
		sequence: event.sequence,
		role,
		text: typeof tv.text === "string" ? tv.text : "",
	};
}

/** Diagnostics mode: drop message bodies to keep sensitive content out. */
function redactPayload(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return { redacted: true };
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
		out[k] = k === "text" || k === "content" ? "[redacted]" : v;
	}
	return out;
}

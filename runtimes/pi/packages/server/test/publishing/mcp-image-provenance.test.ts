import { encodeServerMessage, type ImageContent } from "@earendil-works/pi-protocol";
import { expect, it } from "vitest";
import { toAgentMessages } from "../../src/coding-agent/history-mapper.ts";
import { __testing as progress } from "../../src/coding-agent/progress-adapter.ts";
import { __testing } from "../../src/coding-agent/snapshot-adapter.ts";
import { toProtocolToolResultMessage } from "../../src/protocol.ts";
import type { ConversationEventRecord } from "../../src/publishing/repositories.ts";
import { restoreContext } from "../../src/runtime/context-restore.ts";

it("keeps document provenance through durable restore, native history, progress, snapshots, and the wire codec", () => {
	const image: ImageContent = {
		type: "image",
		data: "aGVsbG8=",
		mimeType: "image/png",
		provenance: { documentTitle: "客户问题处理管理办法.docx", title: "处理流程图" },
	};
	const events = [
		{ eventType: "user/message", payload: { text: "查看流程图" } },
		{ eventType: "tool/call", payload: { toolCallId: "read-1", toolName: "read_resource", input: {} } },
		{
			eventType: "tool/result",
			payload: {
				toolCallId: "read-1",
				toolName: "read_resource",
				content: progress.extractToolContent({ content: [image] }),
			},
		},
		{ eventType: "assistant/message", payload: { text: "流程图如下" } },
	].map((event) => ({ ...event, eventSchemaVersion: 1, turnId: "turn-1" })) as unknown as ConversationEventRecord[];
	const restored = restoreContext(events, { maxContextTokens: 10_000 });
	const messages = toAgentMessages(restored.transcript);
	const result = messages.find((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("missing restored result");
	expect(result.content).toEqual([image]);
	expect(__testing.toToolContent(result.content[0]!)).toEqual(image);
	const item = toProtocolToolResultMessage(result, {
		id: "tool-1",
		call: { type: "toolCall", id: "read-1", name: "read_resource", arguments: {} },
	});
	expect(item.content).toEqual([image]);
	if (item.status === "running") throw new Error("expected completed result");
	expect(() =>
		encodeServerMessage({
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				progress: { type: "item_finished", item },
			},
		}),
	).not.toThrow();
});

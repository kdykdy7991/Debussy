import type { ConversationEvent, ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolImages } from "../../src/conversation/tool-images.tsx";
import { messagesFromEvents } from "../../src/embed/conversation-controller.ts";

const image = {
	type: "image" as const,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=",
	mimeType: "image/png",
};

function event(sequence: number, eventType: string, payload: unknown): ConversationEvent {
	return {
		id: `event-${sequence}`,
		sequence,
		eventType,
		payload,
		turnId: "turn-1",
		createdAt: "2026-10-26T00:00:00Z",
	};
}

describe("tool images in conversation history", () => {
	it("restores images into the right reply and does not leak them into the next turn", () => {
		const messages = messagesFromEvents([
			event(1, "user/message", { text: "查看标志" }),
			event(2, "tool/result", { toolCallId: "read-1", toolName: "read_image", content: [image] }),
			event(3, "assistant/message", { text: "这是 Logo" }),
			event(4, "user/message", { text: "下一个问题" }),
			event(5, "assistant/message", { text: "下一条回答" }),
		]);
		expect(messages[1]?.tools?.[0]?.images).toEqual([image]);
		expect(messages[3]?.tools).toBeUndefined();
	});

	it("does not display failed tool images", () => {
		const messages = messagesFromEvents([
			event(1, "user/message", { text: "问题" }),
			event(2, "tool/result", { toolCallId: "read-1", toolName: "read_image", isError: true, content: [image] }),
			event(3, "assistant/message", { text: "读取失败" }),
		]);
		expect(messages[1]?.tools?.[0]?.images).toEqual([]);
	});

	it("shows deduplicated images and hides internal tool names when the source is missing", () => {
		const tool: ToolTranscriptItem = {
			id: "tool-1",
			role: "tool",
			toolCallId: "call-1",
			toolName: "read_image",
			input: {},
			status: "complete",
			isError: false,
			timestamp: 0,
			content: [image, image],
		};
		const html = renderToStaticMarkup(<ToolImages tools={[tool]} />);
		expect(html.match(/<img /g)).toHaveLength(1);
		expect(html).toContain(`data:image/png;base64,${image.data}`);
		expect(html).toContain("放大图片 1");
		expect(html).not.toContain("read_image");
		expect(html).not.toContain("来源：");
		const sourced = { ...image, provenance: { documentTitle: "客户问题处理管理办法.docx", title: "处理流程图" } };
		const sourcedHtml = renderToStaticMarkup(<ToolImages tools={[{ ...tool, content: [sourced] }]} />);
		expect(sourcedHtml).toContain("来源：《客户问题处理管理办法.docx》");
		expect(sourcedHtml).toContain('alt="处理流程图"');
		expect(sourcedHtml).not.toContain("read_image");
		expect(renderToStaticMarkup(<ToolImages tools={[{ ...tool, status: "error", isError: true }]} />)).toBe("");
	});

	it("keeps image provenance when restoring a conversation", () => {
		const sourced = { ...image, provenance: { documentTitle: "管理办法.docx" } };
		const messages = messagesFromEvents([
			event(1, "user/message", { text: "查看流程图" }),
			event(2, "tool/result", { toolCallId: "read-1", toolName: "mcp_read_resource_internal", content: [sourced] }),
			event(3, "assistant/message", { text: "流程图如下" }),
		]);
		expect(messages[1]?.tools?.[0]?.images).toEqual([sourced]);
	});
});

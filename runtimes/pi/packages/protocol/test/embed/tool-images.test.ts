import { describe, expect, it } from "vitest";
import { decodeServerEvent, toolImagesFromContent } from "../../src/embed/realtime.ts";

const image = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=",
	mimeType: "image/png",
};
const base = {
	conversationId: "conv_1",
	sequence: 0,
	turnId: "turn_1",
	eventId: "evt_1",
	timestamp: "2026-10-26T00:00:00Z",
	type: "tool.completed",
	tool: "read_resource",
	toolCallId: "call_1",
	ok: true,
};

describe("live tool image decoding", () => {
	it("preserves bounded document provenance through live and persisted decoding", () => {
		const sourced = {
			...image,
			provenance: { documentTitle: "客户问题处理管理办法.docx", title: "客户问题处理流程图" },
		};
		expect(decodeServerEvent({ ...base, images: [sourced] })).toEqual({
			ok: true,
			value: { ...base, images: [sourced] },
		});
		expect(toolImagesFromContent([sourced])).toEqual([sourced]);
		expect(toolImagesFromContent([{ ...image, provenance: { documentTitle: {}, title: " " } }])).toEqual([image]);
	});
	it("keeps image bytes and stable tool call IDs", () => {
		expect(decodeServerEvent({ ...base, images: [image] })).toEqual({
			ok: true,
			value: { ...base, images: [image] },
		});
	});
	it.each([
		[{ ...image, mimeType: "image/svg+xml" }],
		[{ ...image, data: "not base64" }],
		[{ ...image, data: "A".repeat(1_398_108) }],
		Array.from({ length: 5 }, () => image),
		"not an array",
	])("rejects malformed or unbounded image events", (images) => {
		expect(decodeServerEvent({ ...base, images }).ok).toBe(false);
	});
	it("ignores non-image blocks when restoring persisted tool content", () => {
		expect(toolImagesFromContent([{ type: "text", text: "metadata" }, image])).toEqual([image]);
	});
});

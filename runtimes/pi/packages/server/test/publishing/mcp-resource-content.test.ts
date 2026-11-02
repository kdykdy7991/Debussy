import { describe, expect, it } from "vitest";
import { McpResourceReferences, mcpResultContent } from "../../src/publishing/mcp/resource-content.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=";

describe("MCP image and resource boundary", () => {
	it("attaches the matching document source to each image without mixing documents", () => {
		const references = new McpResourceReferences();
		references.discover({
			evidence: [
				{ document_id: "a", source_name: "管理办法.docx", asset_ids: ["flow"] },
				{ document_id: "b", source_name: "其他文档.docx", asset_ids: ["logo"] },
			],
		});
		references.discover({
			document_id: "a",
			presentation: { related_assets: [{ asset_id: "flow", caption: "处理流程图" }] },
		});
		const result = mcpResultContent(
			{
				contents: [
					{ uri: "rag://documents/a/assets/flow", blob: png, mimeType: "image/png" },
					{ uri: "rag://documents/b/assets/logo", blob: png, mimeType: "image/png" },
					{ uri: "unknown://image", blob: png, mimeType: "image/png" },
				],
			},
			16,
			undefined,
			references,
		);
		expect(result.content[1]).toMatchObject({ provenance: { documentTitle: "管理办法.docx", title: "处理流程图" } });
		expect(result.content[2]).toMatchObject({ provenance: { documentTitle: "其他文档.docx" } });
		expect(result.content[3]).not.toHaveProperty("provenance");
	});
	it("keeps image bytes intact even when accompanying text is truncated", () => {
		const result = mcpResultContent(
			{
				content: [
					{ type: "text", text: "x".repeat(1000) },
					{ type: "image", data: png, mimeType: "image/png" },
				],
			},
			32,
		);
		expect(result.truncated).toBe(true);
		expect(result.content[1]).toEqual({ type: "image", data: png, mimeType: "image/png" });
		expect(result.content[0]?.type === "text" && result.content[0].text).not.toContain(png);
	});

	it("reads blob resources and embedded resource images as native images", () => {
		const resource = { uri: "rag://documents/doc/assets/logo", blob: png, mimeType: "image/png" };
		expect(mcpResultContent({ contents: [resource] }, 1024).content[1]).toMatchObject({ type: "image", data: png });
		expect(mcpResultContent({ content: [{ type: "resource", resource }] }, 1024).content[1]).toMatchObject({
			type: "image",
			data: png,
		});
	});

	it.each([
		{ type: "image", data: png, mimeType: "image/svg+xml" },
		{ type: "image", data: "not base64!", mimeType: "image/png" },
		{ type: "image", data: Buffer.from("<html>not a PNG</html>").toString("base64"), mimeType: "image/png" },
		{ type: "image", data: "A".repeat(1_398_108), mimeType: "image/png" },
	])("rejects invalid, mismatched, or oversized images", (block) => {
		expect(() => mcpResultContent({ content: [block] }, 1024)).toThrow();
	});

	it("rejects too many images without returning partial base64", () => {
		expect(() =>
			mcpResultContent(
				{ content: Array.from({ length: 5 }, () => ({ type: "image", data: png, mimeType: "image/png" })) },
				1024,
			),
		).toThrow("budget");
	});

	it("discovers RAG evidence and resource links with server-local ownership", () => {
		const a = new McpResourceReferences();
		const b = new McpResourceReferences();
		a.discover({
			evidence: [{ document_id: "doc/1", asset_ids: ["4999eeb922c90bfd_0"] }],
			content: [{ type: "resource_link", uri: "test://logo" }],
		});
		expect(a.has("rag://documents/doc%2F1/assets/4999eeb922c90bfd_0")).toBe(true);
		expect(a.has("test://logo")).toBe(true);
		expect(a.has("file:///etc/passwd")).toBe(false);
		expect(b.has("test://logo")).toBe(false);
	});

	it("discovers document presentation assets and keeps accepting new references after the cache fills", () => {
		const references = new McpResourceReferences();
		references.discover({ document_id: "doc-1", presentation: { related_assets: [{ asset_id: "logo" }] } });
		expect(references.has("rag://documents/doc-1/assets/logo")).toBe(true);
		for (let index = 0; index < 300; index++) references.discover({ uri: `test://image/${index}` });
		expect(references.list()).toHaveLength(256);
		expect(references.has("test://image/299")).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { McpResourceReferences } from "../../src/publishing/mcp/resource-content.ts";
import {
	type McpResourceBinding,
	mcpResourceReadError,
	mcpResultGuidance,
	mcpToolDescription,
} from "../../src/publishing/mcp/resource-guidance.ts";

function binding(name: string): McpResourceBinding {
	return {
		serverName: name,
		serverId: `mcp-${name}`,
		readTool: `read-${name}`,
		toolNames: ["query_knowledge_hub", "search_chunks", "get_document"],
		references: new McpResourceReferences(),
	};
}

describe("MCP resource guidance", () => {
	it("turns legacy text-only evidence into an exact document lookup instead of guessing an image URI", () => {
		const server = binding("知识库");
		server.references.discover({
			evidence: [{ document_id: "doc-1", source: "客户问题.docx", text: "[IMAGE: image-3]" }],
		});
		const guidance = mcpResultGuidance(server, server.references);
		expect(guidance).toMatchObject({
			resource_guidance: {
				documents: [{ document_id: "doc-1", title: "客户问题.docx" }],
				next_action: { tool: "get_document", arguments: { document_id: "doc-1" } },
			},
		});
		expect(guidance.resources).toBeUndefined();
		expect(server.references.has("rag://documents/doc-1/assets/image-3")).toBe(false);
		const error = mcpResourceReadError(server, "file:///C:/Users/test/_images/image-3.png", [server]);
		expect(error.message).toContain("本地文件地址");
		expect(JSON.parse(error.message.split("\n")[1]!)).toMatchObject({
			next_action: { tool: "get_document", arguments: { document_id: "doc-1" } },
		});
		expect(error.message).not.toContain("C:/Users/test");
	});

	it("returns the owning read tool and image caption, including an exact recovery for the wrong service", () => {
		const rag = binding("知识库");
		const ticket = binding("工单");
		rag.references.discover({
			document_id: "doc-1",
			source: "客户问题.docx",
			presentation: { related_assets: [{ asset_id: "image-3", caption: "业务运营流程图" }] },
		});
		const uri = "rag://documents/doc-1/assets/image-3";
		expect(mcpResultGuidance(rag, rag.references)).toMatchObject({
			resources: {
				read_tool: rag.readTool,
				items: [{ uri, description: "业务运营流程图", document_title: "客户问题.docx" }],
			},
		});
		const error = mcpResourceReadError(ticket, uri, [rag, ticket]);
		expect(error.message).toContain("MCP_RESOURCE_WRONG_SERVER");
		expect(JSON.parse(error.message.split("\n")[1]!)).toEqual({
			next_action: { tool: rag.readTool, arguments: { uri } },
		});
		expect(ticket.references.has(uri)).toBe(false);
	});

	it("offers known resources after a bad URI without promoting the guessed URI", () => {
		const server = binding("知识库");
		server.references.discover({ document_id: "doc-1", asset_ids: ["image-3"] });
		const error = mcpResourceReadError(server, "file:///C:/guessed.png", [server]);
		const recovery = JSON.parse(error.message.split("\n")[1]!);
		expect(recovery.resources.read_tool).toBe(server.readTool);
		expect(recovery.resources.items[0].uri).toBe("rag://documents/doc-1/assets/image-3");
		expect(server.references.has("file:///C:/guessed.png")).toBe(false);
	});

	it("identifies the service in tool descriptions while preserving the original remote instructions", () => {
		const server = binding("时空道宇知识库");
		expect(mcpToolDescription(server, "search_chunks", "Original tool description")).toContain(
			"Original tool description",
		);
		expect(mcpToolDescription(server, server.readTool, null)).toContain("时空道宇知识库");
		expect(mcpToolDescription(server, "query_knowledge_hub", null)).toContain("search_chunks");
		const withoutSearch = { ...server, toolNames: ["query_knowledge_hub", "get_document"] };
		expect(mcpToolDescription(withoutSearch, "query_knowledge_hub", null)).not.toContain("search_chunks");
	});

	it("preserves caption metadata when a resource read returns only its URI", () => {
		const cached = new McpResourceReferences();
		cached.discover({
			document_id: "doc-1",
			source: "文档.docx",
			related_assets: [{ asset_id: "image-3", caption: "流程图" }],
		});
		const response = new McpResourceReferences();
		response.discover({
			contents: [{ uri: "rag://documents/doc-1/assets/image-3", mimeType: "image/png", blob: "ignored" }],
		});
		cached.merge(response);
		expect(cached.items()[0]).toMatchObject({ description: "流程图", document_title: "文档.docx" });
	});
});

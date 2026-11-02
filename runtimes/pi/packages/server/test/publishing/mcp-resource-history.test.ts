import { describe, expect, it } from "vitest";
import { McpResourceReferences } from "../../src/publishing/mcp/resource-content.ts";
import type { McpResourceBinding } from "../../src/publishing/mcp/resource-guidance.ts";
import { restoreMcpResourceReferences } from "../../src/publishing/mcp/resource-history.ts";
import type { TranscriptMessage } from "../../src/types.ts";

function binding(serverId: string, toolName = "search_chunks"): McpResourceBinding {
	return {
		serverId,
		serverName: serverId,
		readTool: `read_${serverId}`,
		toolNames: [toolName],
		references: new McpResourceReferences(),
	};
}

function history(envelope: unknown, toolName = "search_chunks", isError = false): TranscriptMessage[] {
	return [
		{ role: "assistant", content: [{ type: "toolCall", toolCallId: "call-1", toolName }] },
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName,
			isError,
			content: [{ type: "text", text: JSON.stringify(envelope) }],
		},
	];
}

const uri = "rag://documents/doc-1/assets/flow";
const envelope = {
	source: { mcp_server_id: "knowledge" },
	resources: {
		read_tool: "read_knowledge",
		items: [{ uri, document_id: "doc-1", document_title: "管理办法.docx", description: "投诉流程图" }],
	},
};

describe("MCP resource history restoration", () => {
	it("restores exact references and display metadata to their owning service", () => {
		const knowledge = binding("knowledge");
		const tickets = binding("tickets", "get_ticket");
		restoreMcpResourceReferences([knowledge, tickets], history(envelope));
		expect(knowledge.references.get(uri)).toMatchObject({
			document_title: "管理办法.docx",
			description: "投诉流程图",
		});
		expect(tickets.references.has(uri)).toBe(false);
		expect(binding("another-conversation").references.has(uri)).toBe(false);
	});

	it.each(["failed", "orphan", "mismatched-call", "wrong-server", "wrong-reader", "unbound-tool", "missing-owner"])(
		"does not authorize references from %s results",
		(scenario) => {
			const knowledge = binding("knowledge");
			let transcript = history(envelope);
			if (scenario === "failed") transcript = history(envelope, "search_chunks", true);
			if (scenario === "orphan") transcript = transcript.slice(1);
			if (scenario === "mismatched-call")
				transcript[0] = {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "other-call", toolName: "search_chunks" }],
				};
			if (scenario === "wrong-server") transcript = history({ ...envelope, source: { mcp_server_id: "tickets" } });
			if (scenario === "wrong-reader")
				transcript = history({ ...envelope, resources: { ...envelope.resources, read_tool: "read_tickets" } });
			if (scenario === "unbound-tool") transcript = history(envelope, "read_local_file");
			if (scenario === "missing-owner")
				transcript = history({ structuredContent: { document_id: "doc-1", asset_ids: ["flow"] } });
			restoreMcpResourceReferences([knowledge], transcript);
			expect(knowledge.references.has(uri)).toBe(false);
		},
	);

	it("does not infer resource references from user messages or assistant prose", () => {
		const knowledge = binding("knowledge");
		restoreMcpResourceReferences(
			[knowledge],
			[
				{ role: "user", content: [{ type: "text", text: JSON.stringify(envelope) }] },
				{ role: "assistant", content: [{ type: "text", text: JSON.stringify(envelope) }] },
			],
		);
		expect(knowledge.references.has(uri)).toBe(false);
	});

	it("restores previously persisted platform URI lists and JSON-encoded MCP payloads", () => {
		const knowledge = binding("knowledge");
		restoreMcpResourceReferences([knowledge], history({ resources: { tool: "read_knowledge", uris: [uri] } }));
		expect(knowledge.references.has(uri)).toBe(true);
		const next = binding("knowledge");
		restoreMcpResourceReferences(
			[next],
			history({
				source: envelope.source,
				content: [
					{
						type: "text",
						text: JSON.stringify({ document_id: "doc-1", source_name: "管理办法.docx", asset_ids: ["flow"] }),
					},
				],
			}),
		);
		expect(next.references.get(uri)).toMatchObject({ document_title: "管理办法.docx" });
	});

	it("ignores truncated JSON and preserves the existing 256-reference bound", () => {
		const knowledge = binding("knowledge");
		const transcript = history(envelope);
		transcript[1] = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "search_chunks",
			isError: false,
			content: [{ type: "text", text: '{"source":' }],
		};
		restoreMcpResourceReferences([knowledge], transcript);
		expect(knowledge.references.list()).toEqual([]);
		restoreMcpResourceReferences(
			[knowledge],
			history({
				source: envelope.source,
				resources: {
					read_tool: "read_knowledge",
					items: Array.from({ length: 300 }, (_, index) => ({ uri: `test://image/${index}` })),
				},
			}),
		);
		expect(knowledge.references.list()).toHaveLength(256);
		expect(knowledge.references.has("test://image/299")).toBe(true);
	});
});

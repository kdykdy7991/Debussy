import type { McpServerDetail, SkillSummary } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentExtensionsSection } from "../../src/admin/agents/agent-extensions-section.tsx";

const skill: SkillSummary = {
	id: "skill_example",
	name: "Web search",
	kind: "file",
	currentRevision: 3,
	enabled: true,
	updatedAt: "2026-08-27T00:00:00.000Z",
};

const mcp: McpServerDetail = {
	id: "mcp_example",
	name: "Search MCP",
	status: "enabled",
	currentRevision: 2,
	transport: "streamable_http",
	toolCount: 2,
	secretConfigured: true,
	updatedAt: "2026-08-27T00:00:00.000Z",
	boundAgents: [],
	lastTest: null,
	revisions: [
		{
			revision: 2,
			config: { transport: "streamable_http", endpoint: "https://mcp.example.com", authentication: "bearer" },
			tools: [
				{ id: "tool_1", name: "search", description: null, inputSchema: {}, inputSchemaHash: "hash-1" },
				{ id: "tool_2", name: "fetch", description: null, inputSchema: {}, inputSchemaHash: "hash-2" },
			],
			createdAt: "2026-08-27T00:00:00.000Z",
		},
	],
};

describe("AgentExtensionsSection", () => {
	test("renders MCP Server selection without revision or Tool controls", () => {
		const html = renderToStaticMarkup(
			<AgentExtensionsSection
				catalog={{ skills: [skill], mcpServers: [mcp] }}
				skills={[{ skillId: skill.id, revision: 2 }]}
				mcpServers={[{ mcpServerId: mcp.id, revision: 2, toolNames: ["search"] }]}
				onSkillsChange={() => {}}
				onMcpServersChange={() => {}}
				loading={false}
			/>,
		);
		expect(html).toContain("Web search");
		expect(html).toContain("Revision 2");
		expect(html).toContain("Search MCP");
		expect(html).not.toContain("固定 Revision");
		expect(html).not.toContain("Tool allowlist");
		expect(html).not.toContain("fetch");
		expect(html).toContain('checked=""');
	});
});

import type {
	AgentConfigSnapshot,
	AgentDefinitionRevision,
	AgentPublicId,
	LlmAvailableModel,
} from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AgentForm, EDITABLE_CAPABILITIES, MAX_SYSTEM_PROMPT_CHARS } from "../../src/admin/agents/agent-form.tsx";
import { loadRevisionDetail } from "../../src/admin/agents/revision-list.tsx";

const model: LlmAvailableModel = {
	provider: "oneapi",
	id: "Qwen",
	name: "Qwen",
	api: "openai-completions",
	reasoning: true,
	parameterCapabilities: {
		reasoning: { supported: true, toggle: false, efforts: ["low", "medium", "high"] },
	},
};

function draft(patch: Partial<AgentConfigSnapshot> = {}): AgentConfigSnapshot {
	return {
		modelId: model.id,
		systemPrompt: "help",
		parameters: {},
		toolIds: [],
		knowledgeBaseIds: [],
		capabilities: {
			liveSpeech: false,
			avatar: false,
			attachments: false,
			citations: true,
			realtime: true,
			webSearch: true,
		},
		...patch,
	};
}

describe("Agent workspace rebuild boundaries", () => {
	test("only exposes capabilities that the save path persists", () => {
		expect(EDITABLE_CAPABILITIES.map((item) => item.key)).toEqual(["attachments", "avatar", "liveSpeech"]);
		const html = renderToStaticMarkup(<AgentForm draft={draft()} models={[model]} onEdit={() => {}} />);
		expect(html).not.toContain(">引用检索</span>");
		expect(html).not.toContain(">Realtime</span>");
		expect(html).not.toContain(">Web 搜索</span>");
	});

	test("shows existing tool and knowledge references without arbitrary text inputs", () => {
		const html = renderToStaticMarkup(
			<AgentForm
				draft={draft({ toolIds: ["tool.real"], knowledgeBaseIds: ["kb.real"] })}
				models={[model]}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("tool.real");
		expect(html).toContain("kb.real");
		expect(html).toContain("移除 工具 tool.real");
		expect(html).toContain("移除 知识库 kb.real");
		expect(html).not.toContain('type="text"');
	});

	test("uses the RuntimeSpec system prompt limit instead of an invented UI limit", () => {
		expect(MAX_SYSTEM_PROMPT_CHARS).toBe(65_536);
		const html = renderToStaticMarkup(
			<AgentForm
				draft={draft({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1) })}
				models={[model]}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain(`超过 ${MAX_SYSTEM_PROMPT_CHARS} 字符上限`);
		expect(html).not.toContain("超过 8000 字符上限");
	});

	test("keeps an unavailable model visible while allowing a replacement", () => {
		const html = renderToStaticMarkup(
			<AgentForm draft={draft({ modelId: "retired-model" })} models={[model]} onEdit={() => {}} />,
		);
		expect(html).toContain("retired-model（已下架 — 保留原值）");
		expect(html).toContain("可以从上方目录选择替代模型");
		expect(html).not.toMatch(/<select[^>]*disabled/);
	});
});

describe("Revision detail cache", () => {
	test("does not request an already loaded revision again", async () => {
		const revision: AgentDefinitionRevision = {
			id: "agent_00000000-0000-0000-0000-000000000001" as AgentPublicId,
			revision: 2,
			sourceHash: "hash",
			changeSummary: "changed prompt",
			createdBy: "admin",
			createdAt: "2026-08-25T00:00:00.000Z",
			configSnapshot: draft(),
			diffFromPrevious: {
				changedFields: ["systemPrompt"],
				promptDelta: "changed",
				parametersDelta: {},
				toolsAdded: [],
				toolsRemoved: [],
				knowledgeAdded: [],
				knowledgeRemoved: [],
				capabilitiesChanged: [],
			},
			associatedVersionIds: [],
		};
		const getRevision = vi.fn(async () => revision);
		const cache = new Map<number, AgentDefinitionRevision>();
		const agentId = revision.id;

		await expect(loadRevisionDetail(cache, { getRevision }, agentId, 2)).resolves.toBe(revision);
		await expect(loadRevisionDetail(cache, { getRevision }, agentId, 2)).resolves.toBe(revision);
		expect(getRevision).toHaveBeenCalledTimes(1);
	});
});

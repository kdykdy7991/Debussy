import type { AgentConfigSnapshot, LlmAvailableModel } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AgentForm } from "../../src/admin/agents/agent-form.tsx";

const qwen: LlmAvailableModel = {
	provider: "local",
	id: "Qwen3.8-Agent",
	name: "Qwen3.8 Agent",
	api: "openai-completions",
	reasoning: true,
	parameterCapabilities: {
		reasoning: {
			supported: true,
			toggle: true,
			efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
			defaultEffort: "high",
		},
	},
};

const draft: AgentConfigSnapshot = {
	modelId: qwen.id,
	systemPrompt: "help",
	parameters: {},
	toolIds: [],
	knowledgeBaseIds: [],
	capabilities: {
		liveSpeech: false,
		avatar: false,
		attachments: false,
		citations: false,
		realtime: false,
		webSearch: false,
	},
};

describe("AgentForm model parameters", () => {
	test("renders only model-specific thinking controls", () => {
		const onEdit = vi.fn();
		const html = renderToStaticMarkup(<AgentForm draft={draft} models={[qwen]} onEdit={onEdit} />);
		expect(html).toContain('value="low"');
		expect(html).toContain('value="medium"');
		expect(html).toContain('value="high"');
		expect(html).not.toContain('value="xhigh"');
		expect(html).not.toContain('value="minimal"');
		expect(html).not.toContain('value="max"');
		expect(html).toContain("低 (low)");
		expect(html).toContain("中 (medium)");
		expect(html).toContain("高 (high)");
		expect(html).toContain("模型默认 (high)");
		expect(html).not.toContain("Temperature");
		expect(html).not.toContain("最大输出 Token");
		expect(html).toContain("由服务端代码固定");
		expect(onEdit).not.toHaveBeenCalled();
	});
});

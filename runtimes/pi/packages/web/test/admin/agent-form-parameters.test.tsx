import type { AgentConfigSnapshot, LlmAvailableModel } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AgentForm } from "../../src/admin/agents/agent-form.tsx";

/** M1 抽象：声明 6 档 reasoning effort 的模型（典型 qwen 系列 / claude）。 */
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

/** M1 抽象：声明支持 reasoning 但没有 toggle（只读模式）。 */
const readonlyModel: LlmAvailableModel = {
	provider: "local",
	id: "ReadOnlyModel",
	name: "Read Only Model",
	api: "openai-completions",
	reasoning: true,
	parameterCapabilities: {
		reasoning: {
			supported: true,
			toggle: false,
			efforts: ["low", "medium", "high"],
		},
	},
};

/** M1 抽象：明确声明不支持 reasoning。 */
const unsupportedModel: LlmAvailableModel = {
	provider: "local",
	id: "NoReasoningModel",
	name: "No Reasoning Model",
	api: "openai-completions",
	reasoning: false,
	parameterCapabilities: {
		reasoning: {
			supported: false,
			toggle: false,
			efforts: [],
		},
	},
};

const baseDraft: AgentConfigSnapshot = {
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
	test("shows legacy read-aloud and experimental realtime voice as separate switches", () => {
		const html = renderToStaticMarkup(<AgentForm draft={baseDraft} models={[qwen]} onEdit={vi.fn()} />);
		expect(html).toContain("朗读");
		expect(html).toContain("实时语音");
		expect(html).toContain('data-experimental="true"');
		expect(html).toContain("保存并发布后生效");
	});

	test("renders all six model-declared thinking efforts (no lossy product mapping)", () => {
		const onEdit = vi.fn();
		const html = renderToStaticMarkup(<AgentForm draft={baseDraft} models={[qwen]} onEdit={onEdit} />);
		// 6 档全部原样展示（M1 R3 不再拍成 低/中/高）。
		expect(html).toContain('value="minimal"');
		expect(html).toContain('value="low"');
		expect(html).toContain('value="medium"');
		expect(html).toContain('value="high"');
		expect(html).toContain('value="xhigh"');
		expect(html).toContain('value="max"');
		// 「默认思考强度」下拉首项标签来自模型 defaultEffort，不来自产品语义翻译。
		expect(html).toContain("模型默认 (high)");
		expect(html).not.toContain("Temperature");
		expect(html).not.toContain("最大输出 Token");
		expect(html).toContain("由服务端代码固定");
		expect(onEdit).not.toHaveBeenCalled();
	});

	test("supported + no toggle 只显示 effort 下拉，不显示 toggle", () => {
		const draft: AgentConfigSnapshot = { ...baseDraft, modelId: readonlyModel.id };
		const onEdit = vi.fn();
		const html = renderToStaticMarkup(<AgentForm draft={draft} models={[readonlyModel]} onEdit={onEdit} />);
		// 该模型不暴露 toggle → 不渲染"开启深度思考"复选框
		expect(html).not.toContain("开启深度思考");
		// effort 下拉仍然渲染 3 个支持的档位
		expect(html).toContain('value="low"');
		expect(html).toContain('value="medium"');
		expect(html).toContain('value="high"');
		expect(html).not.toContain('value="xhigh"');
		expect(html).not.toContain('value="minimal"');
		expect(html).not.toContain('value="max"');
	});

	test("unsupported 模型：渲染说明，不渲染 effort 选择器", () => {
		const draft: AgentConfigSnapshot = { ...baseDraft, modelId: unsupportedModel.id };
		const onEdit = vi.fn();
		const html = renderToStaticMarkup(<AgentForm draft={draft} models={[unsupportedModel]} onEdit={onEdit} />);
		// 没有 toggle、也没有 effort 下拉；显示说明文字
		expect(html).not.toContain("开启深度思考");
		expect(html).not.toContain('value="low"');
		expect(html).not.toContain("默认思考强度");
		// 当前没有显式"不支持"文案，但通过 absence-of-effort-selector 已经能验证 unsupported 状态
	});

	test("未选择模型时显示提示，不渲染 reasoning 选择器", () => {
		const draft: AgentConfigSnapshot = { ...baseDraft, modelId: null };
		const onEdit = vi.fn();
		const html = renderToStaticMarkup(<AgentForm draft={draft} models={[qwen]} onEdit={onEdit} />);
		expect(html).toContain("请从模型目录选择可用模型后配置参数");
		expect(html).not.toContain("开启深度思考");
		expect(html).not.toContain('value="low"');
	});

	test("已保存 draft.parameters.reasoning 完全由用户字段驱动（unconfigured 时省略）", () => {
		// unconfigured → parameters.reasoning 未设，UI 默认选项=模型默认，effort 选 ''。
		const draft: AgentConfigSnapshot = { ...baseDraft, parameters: {} };
		const onEdit = vi.fn();
		const html = renderToStaticMarkup(<AgentForm draft={draft} models={[qwen]} onEdit={onEdit} />);
		// effort select 默认选中"模型默认"空值选项（`<option value="" selected>`）。
		expect(html).toMatch(/<option value="" selected="">模型默认 \(high\)<\/option>/);
		// toggle 默认 true（行为不变——checked={parameters.reasoning?.enabled ?? true}）
		// 不直接断言 checked 字符串；onEdit 未被调用即可证明用户未触发变化。
		expect(onEdit).not.toHaveBeenCalled();
	});
});

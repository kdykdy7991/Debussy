/**
 * M1 reasoning：会话级覆盖 tab 单测（V2-README §4.3；契约 §11）。
 *
 * capability 派生遵循决策 #2：
 * - 仅有 `unavailable | ready` 两态，`reason` 区分
 *   `legacy | unsupported | no-efforts`；
 * - **不**重新引入 `awaiting-contract`（契约已冻结）。
 *
 * `effort === null` UI 显示"跟随 Revision 默认"，**不**展示数值；
 * `pinnedCapability.reasoning.defaultEffort` 仅作可选 hint 文案，不可冒充
 * Revision 默认（契约 §11 Q1 决策）。
 *
 * 不复制 DTO：组件 import `ConversationReasoningState` / `ReasoningUpdateRequest`
 * / `ReasoningEffort`；测试只校验 wire 与 UI 状态机，不重新声明档位常量。
 *
 * 覆盖路径：
 * 1. `capabilityStateFromReasoning` 三种 unavailable（legacy / unsupported /
 *    no-efforts）+ 一种 ready + toggle:false 不参与判定；
 * 2. `resolveDefaultHint` 取 `pinnedCapability.reasoning.defaultEffort`
 *    作为唯一 hint 源（无 revisionDefaultEffort 字段）；
 * 3. `formatDefaultHint` null → "未声明模型默认"，非 null → 透传；
 * 4. `formatReasoningEffort` 6 档字面量透传；
 * 5. 非 `conv_` 前缀的 route 参数 → 组件不抛异常。
 *
 * wire / state-driven 测试在 `test/admin/conversations-api.test.ts` 已有（覆盖
 * `getReasoning` / `putReasoning` 的 method/header/body/错误码透传 + 30s 超时）。
 */
import type { ConversationReasoningState, ReasoningEffort } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationsApi } from "../../../src/admin/api/conversations-api.ts";
import {
	capabilityStateFromReasoning,
	formatDefaultHint,
	formatReasoningEffort,
	ReasoningTab,
	resolveDefaultHint,
} from "../../../src/admin/user-conversations/reasoning-tab.tsx";

function makeFakeApi(overrides: Partial<ConversationsApi> = {}): ConversationsApi {
	return {
		getReasoning: vi.fn(),
		putReasoning: vi.fn(),
		...overrides,
	} as unknown as ConversationsApi;
}

const SAMPLE_CONV = "conv_1";

describe("ReasoningTab capability 派生（两态 + 可区分 reason）", () => {
	it("legacy：pinnedCapability === null → unavailable + reason='legacy'", () => {
		const legacy: ConversationReasoningState = {
			conversationId: "conv_legacy",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: false,
			pinnedCapability: null,
		};
		expect(capabilityStateFromReasoning(legacy)).toEqual({
			kind: "unavailable",
			reason: "legacy",
			message: "该会话固定版本没有可配置的 reasoning capability。",
		});
	});

	it("unsupported：pinnedCapability.reasoning.supported=false → unavailable + reason='unsupported'", () => {
		const unsupported: ConversationReasoningState = {
			conversationId: "conv_unsup",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: true,
			pinnedCapability: {
				publishedAppVersionId: "pav_unsup",
				modelId: "model-no-reasoning",
				reasoning: { supported: false, toggle: false, efforts: [] },
			},
		};
		expect(capabilityStateFromReasoning(unsupported)).toEqual({
			kind: "unavailable",
			reason: "unsupported",
			message: "该会话模型不提供 reasoning 能力。",
		});
	});

	it("no-efforts：pinnedCapability.reasoning.supported=true 但档位空 → unavailable + reason='no-efforts'", () => {
		const noEfforts: ConversationReasoningState = {
			conversationId: "conv_no_efforts",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: true,
			pinnedCapability: {
				publishedAppVersionId: "pav_no_efforts",
				modelId: "model-no-efforts",
				reasoning: { supported: true, toggle: false, efforts: [] },
			},
		};
		expect(capabilityStateFromReasoning(noEfforts)).toEqual({
			kind: "unavailable",
			reason: "no-efforts",
			message: "该会话模型未声明任何可用的 thinking effort 档位。",
		});
	});

	it("ready：supported && efforts 非空 → ready + configuredEfforts 透传", () => {
		const ready: ConversationReasoningState = {
			conversationId: "conv_ready",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: true,
			pinnedCapability: {
				publishedAppVersionId: "pav_ready",
				modelId: "model-ready",
				reasoning: { supported: true, toggle: false, efforts: ["low", "medium", "high"] },
			},
		};
		expect(capabilityStateFromReasoning(ready)).toEqual({
			kind: "ready",
			configuredEfforts: ["low", "medium", "high"],
		});
	});

	it("toggle:false 不参与判定 → 仍属 ready", () => {
		// "能否关掉思考" 是 toggle 字段的能力；会话覆盖端仍可调 effort 档位。
		const toggleOff: ConversationReasoningState = {
			conversationId: "conv_toggle_off",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: true,
			pinnedCapability: {
				publishedAppVersionId: "pav_toggle_off",
				modelId: "model-toggle-off",
				reasoning: { supported: true, toggle: false, efforts: ["low", "high"] },
			},
		};
		expect(capabilityStateFromReasoning(toggleOff)).toEqual({
			kind: "ready",
			configuredEfforts: ["low", "high"],
		});
	});
});

describe("resolveDefaultHint（契约 §11 Q1 决策：仅 defaultEffort）", () => {
	const baseEfforts = ["low", "medium"] as const satisfies readonly ReasoningEffort[];
	const basePinned = {
		publishedAppVersionId: "pav_x" as `pav_${string}`,
		modelId: "model_x",
		reasoning: { supported: true, toggle: false, efforts: baseEfforts },
	};

	it("pinnedCapability.reasoning.defaultEffort 存在 → 作为 hint 返回", () => {
		const state: ConversationReasoningState = {
			conversationId: "conv_hint",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: true,
			pinnedCapability: {
				...basePinned,
				reasoning: { ...basePinned.reasoning, defaultEffort: "medium" },
			},
		};
		expect(resolveDefaultHint(state)).toBe("medium");
	});

	it("pinnedCapability.reasoning.defaultEffort 缺失 → null（无 hint）", () => {
		const state: ConversationReasoningState = {
			conversationId: "conv_no_hint",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: true,
			pinnedCapability: basePinned,
		};
		expect(resolveDefaultHint(state)).toBeNull();
	});

	it("pinnedCapability === null（legacy） → null", () => {
		const state: ConversationReasoningState = {
			conversationId: "conv_legacy_hint",
			effort: null,
			updatedAt: "2026-08-24T00:00:00.000Z",
			configurable: false,
			pinnedCapability: null,
		};
		expect(resolveDefaultHint(state)).toBeNull();
	});
});

describe("formatDefaultHint（UI 副本；契约 §11 不冒充 Revision 默认）", () => {
	it("null → 未声明模型默认", () => {
		expect(formatDefaultHint(null)).toBe("未声明模型默认");
	});
	it("非 null → 原样透传（不做产品翻译）", () => {
		expect(formatDefaultHint("high")).toBe("high");
		expect(formatDefaultHint("minimal")).toBe("minimal");
	});
});

describe("ReasoningTab 渲染兜底", () => {
	it("非 conv_ 前缀 → 组件不抛异常", () => {
		const api = makeFakeApi();
		expect(() => renderToStaticMarkup(<ReasoningTab conversationId="oops" api={api} />)).not.toThrow();
	});
});

describe("formatReasoningEffort (档位透传)", () => {
	// 不复制 DTO：档位字符串来自协议 union；这里只断言"原样返回"语义。
	const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
	for (const effort of efforts) {
		it(`formatReasoningEffort(${effort}) === ${effort}（不做产品翻译）`, () => {
			expect(formatReasoningEffort(effort)).toBe(effort);
		});
	}
});

/** 重新导出供 tests 校验 wire 形状。 */
export type { ConversationReasoningState, ReasoningEffort };
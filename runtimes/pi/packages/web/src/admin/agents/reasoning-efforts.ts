import type { ReasoningEffort } from "@earendil-works/pi-protocol";

/**
 * 模型声明的 reasoning effort 档位（M1 R3：6 档透传）。
 *
 * 该映射把协议 `ReasoningEffort` union 字面量原样暴露给 UI，**不**做产品语义
 * 压缩——M0 早期版本曾把 6 档（minimal/low/medium/high/xhigh/max）拍成
 * 「低/中/高」三档，会丢掉 `minimal` / `xhigh` / `max`，违反「只展示模型
 * 声明支持的档位」的硬约束。前端不再推导 Provider 参数；档位字面量
 * 既是显示文案，也是 `SaveAgentRevisionRequest.parameters.reasoning.effort`
 * 的 wire 值。
 */
export interface ProductReasoningEffort {
	/** 显示标签；M1 直接使用档位字面量，附括号显示 `value` 便于排查。 */
	readonly label: string;
	/** `ReasoningEffort` union 字面量；wire 值，与协议一致。 */
	readonly value: ReasoningEffort;
}

/**
 * 把模型能力目录中声明的 `efforts: ReasoningEffort[]` 透传给 UI。
 * 入参是模型支持档位的有序列表；返回相同顺序、相同档位的 `ProductReasoningEffort`。
 * 不做去重 / 排序 / 翻译——前端只反映后端契约。
 */
export function productReasoningEfforts(efforts: readonly ReasoningEffort[]): readonly ProductReasoningEffort[] {
	return efforts.map((effort) => ({ value: effort, label: effort }));
}
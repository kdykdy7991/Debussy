import type { ReasoningEffort } from "@earendil-works/pi-protocol";

export interface ProductReasoningEffort {
	readonly label: "低" | "中" | "高";
	readonly value: "low" | "medium" | "high";
}

/** UI values are stable product semantics; provider enums never leak into form state. */
export function productReasoningEfforts(efforts: readonly ReasoningEffort[]): readonly ProductReasoningEffort[] {
	if (efforts.length === 0) return [];
	return [
		{ label: "低", value: "low" },
		{ label: "中", value: "medium" },
		{ label: "高", value: "high" },
	];
}

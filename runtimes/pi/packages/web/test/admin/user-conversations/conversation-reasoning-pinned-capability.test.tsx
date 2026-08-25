import type { ConversationReasoningState, ReasoningEffort } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { capabilityStateFromReasoning } from "../../../src/admin/user-conversations/reasoning-tab.tsx";

function state(
	conversationId: `conv_${string}`,
	versionId: `pav_${string}`,
	efforts: readonly ReasoningEffort[],
): ConversationReasoningState {
	return {
		conversationId,
		effort: null,
		updatedAt: "2026-08-24T00:00:00.000Z",
		configurable: true,
		pinnedCapability: {
			publishedAppVersionId: versionId,
			modelId: `model-${versionId}`,
			reasoning: { supported: true, toggle: false, efforts },
		},
	};
}

describe("conversation pinned reasoning capability", () => {
	it("v1 conversation keeps v1 efforts after an Agent v2 is published", () => {
		const v1 = capabilityStateFromReasoning(state("conv_v1", "pav_v1", ["low", "medium", "high"]));
		const v2 = capabilityStateFromReasoning(state("conv_v2", "pav_v2", ["high", "max"]));
		expect(v1).toEqual({ kind: "ready", configuredEfforts: ["low", "medium", "high"] });
		expect(v2).toEqual({ kind: "ready", configuredEfforts: ["high", "max"] });
	});

	it("capability comes from the same reasoning state response", () => {
		const response = state("conv_same_dto", "pav_v1", ["low", "high"]);
		expect(capabilityStateFromReasoning(response)).toEqual({
			kind: "ready",
			configuredEfforts: response.pinnedCapability?.reasoning.efforts,
		});
	});

	it("legacy published versions without a snapshot are read-only", () => {
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
			message: expect.any(String) as unknown as string,
		});
	});

	it("model without reasoning support maps to unavailable + reason='unsupported'", () => {
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
		const cap = capabilityStateFromReasoning(unsupported);
		expect(cap.kind).toBe("unavailable");
		if (cap.kind === "unavailable") {
			expect(cap.reason).toBe("unsupported");
		}
	});

	it("model with supported=true but empty efforts maps to unavailable + reason='no-efforts'", () => {
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
		const cap = capabilityStateFromReasoning(noEfforts);
		expect(cap.kind).toBe("unavailable");
		if (cap.kind === "unavailable") {
			expect(cap.reason).toBe("no-efforts");
		}
	});
});
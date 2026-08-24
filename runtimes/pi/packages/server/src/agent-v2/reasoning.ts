/**
 * Agent V2 reasoning shared operation (frozen contract §4.3).
 *
 * Both the control-admin and embed-owner surfaces reuse the SAME effort-apply
 * logic: capability resolution, effort validation and the transactional
 * fact-source + audit write. Capability is resolved deterministically from the
 * conversation's PINNED Published App Version runtimeSpec (never the live LLM
 * catalog), so an old conversation's allowed efforts do not drift when the
 * catalog or the current Agent config changes.
 */
import {
	AGENT_V2_REASONING_AUDIT_ACTION,
	type ConversationPublicId,
	type ConversationReasoningState,
	type ModelParameterCapabilities,
	type ReasoningPrincipal,
	type ReasoningUpdateRequest,
} from "@earendil-works/pi-protocol";
import { modelParameterCapabilities, validateModelParameters } from "../model-parameters.ts";
import {
	type ConversationId,
	newAuditEventId,
	newRequestId,
	type PrincipalId,
	type PublishedAppId,
	type PublishedAppVersionId,
	type RequestId,
	toPublicId,
} from "../publishing/domain/ids.ts";
import type { ConversationReasoningStateRecord, PublishingRepositories } from "../publishing/repositories.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";

export type ReasoningApplyErrorCode = "REASONING_NOT_CONFIGURABLE" | "REASONING_INVALID_EFFORT";

export type ReasoningApplyResult =
	| { readonly ok: true; readonly data: ConversationReasoningState }
	| {
			readonly ok: false;
			readonly code: ReasoningApplyErrorCode;
			readonly status: number;
			readonly message: string;
	  };

export interface ApplyConversationReasoningInput {
	readonly repos: PublishingRepositories;
	readonly tenantId: ConversationReasoningStateRecord["tenantId"];
	readonly publishedAppId: PublishedAppId;
	readonly publishedAppVersionId: PublishedAppVersionId;
	readonly ownerPrincipalId: PrincipalId;
	readonly conversationId: ConversationId;
	readonly request: ReasoningUpdateRequest;
	readonly principal: ReasoningPrincipal;
	/** When false, a legal owner is still forbidden from adjusting effort (403). */
	readonly configurable: boolean;
	readonly requestId?: RequestId;
}

/**

/**
 * Shared effort apply: validates against the pinned version's FROZEN capability
 * and atomically upserts the fact source + appends the reasoning-updated audit
 * row in one transaction.
 */
export async function applyConversationReasoning(
	input: ApplyConversationReasoningInput,
): Promise<ReasoningApplyResult> {
	if (!input.configurable) {
		return {
			ok: false,
			code: "REASONING_NOT_CONFIGURABLE",
			status: 403,
			message: "policy forbids adjusting reasoning effort for this conversation",
		};
	}
	const capabilities = await reasoningCapabilitiesForVersion(
		input.repos,
		{ tenantId: input.tenantId, publishedAppId: input.publishedAppId },
		input.publishedAppVersionId,
	);
	const after = input.request.effort;
	if (after !== null) {
		const errors = validateModelParameters({ reasoning: { enabled: true, effort: after } }, capabilities);
		if (errors.length > 0) {
			return { ok: false, code: "REASONING_INVALID_EFFORT", status: 422, message: errors.join("; ") };
		}
	}
	const now = new Date();
	const requestId = input.requestId ?? newRequestId();
	const publicId = toPublicId("ConversationId", input.conversationId) as ConversationPublicId;
	await input.repos.conversationReasoning.setEffortWithAudit({
		state: {
			conversationId: input.conversationId,
			tenantId: input.tenantId,
			publishedAppId: input.publishedAppId,
			ownerPrincipalId: input.ownerPrincipalId,
			effort: after,
			updatedBy: `${input.principal.type}:${input.principal.id}`,
			requestId,
			updatedAt: now,
		},
		audit: (before) => ({
			auditEventId: newAuditEventId(),
			tenantId: input.tenantId,
			actorType: "platform_admin",
			actorId: input.tenantId,
			action: AGENT_V2_REASONING_AUDIT_ACTION,
			resourceType: "conversation",
			resourceId: input.conversationId,
			requestId,
			metadata: {
				conversationId: publicId,
				principal: input.principal,
				before: before?.effort ?? null,
				after,
				requestedAt: now.toISOString(),
			},
			createdAt: now,
		}),
	});
	return {
		ok: true,
		data: { conversationId: publicId, effort: after, updatedAt: now.toISOString() },
	};
}

/**
 * Resolve the reasoning capability set for a conversation from its PINNED
 * Published App Version's model, deterministically (frozen). The live LLM
 * catalog is deliberately NOT consulted so that catalog changes cannot alter
 * an existing conversation's allowed efforts.
 */
export async function reasoningCapabilitiesForVersion(
	repos: PublishingRepositories,
	versionScope: {
		readonly tenantId: ConversationReasoningStateRecord["tenantId"];
		readonly publishedAppId: PublishedAppId;
	},
	versionId: PublishedAppVersionId,
): Promise<ModelParameterCapabilities> {
	const version = await repos.publishedAppVersions.get(
		{ tenantId: versionScope.tenantId, publishedAppId: versionScope.publishedAppId },
		versionId,
	);
	let modelId = "";
	if (version !== undefined) {
		const parsed = parseRuntimeSpec(version.runtimeSpec);
		if (parsed.ok) modelId = parsed.spec.agent.model.modelId;
	}
	return modelParameterCapabilities({
		id: modelId,
		api: "openai-completions",
		reasoning: /qwen[\s._-]*3[\s._-]*8/i.test(modelId),
	});
}

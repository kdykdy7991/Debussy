import type { PrincipalId, TenantId, TurnId } from "../../publishing/domain/ids.ts";
import type { ConversationRecord, OwnerScope, PublishingRepositories } from "../../publishing/repositories.ts";
import type { EmbedAuthContext } from "../middleware/authenticate.ts";

/** A task service identity is bound to an Integration, never disguised as a Chat app. */
export interface OrchestrationPrincipal {
	readonly tenantId: TenantId;
	readonly publishedAppId: null;
	readonly integrationId: string;
	readonly principalId: PrincipalId;
	readonly tokenId: string;
}
export type ExecutionPrincipal = EmbedAuthContext | OrchestrationPrincipal;
export interface ExecutionConfiguration {
	readonly runtimeSpec: unknown;
	readonly runtimeSpecHash: string | null;
	readonly versionKey: string;
	readonly source: {
		readonly kind: "chat" | "orchestration" | "legacy_orchestration";
		readonly ownerId: string;
		readonly versionId: string;
	};
	readonly audit: Readonly<Record<string, unknown>>;
	readonly text?: string;
}
export type ExecutionConfigResolver = (
	scope: OwnerScope,
	record: ConversationRecord,
	turnId: TurnId,
) => Promise<ExecutionConfiguration | undefined>;

/** Default Chat behavior remains a frozen published version. */
export function chatExecutionConfigResolver(repos: PublishingRepositories): ExecutionConfigResolver {
	return async (scope, record) => {
		if (record.source === "orchestration" || scope.integrationId !== undefined) return undefined;
		if (scope.publishedAppId === null || record.publishedAppId === null || record.publishedAppVersionId === null)
			return undefined;
		const appScope = { tenantId: scope.tenantId, publishedAppId: scope.publishedAppId };
		const version = await repos.publishedAppVersions.get(appScope, record.publishedAppVersionId);
		if (!version) return undefined;
		const agentId = (await repos.publishedApps.get(appScope, record.publishedAppId))?.agentDefinitionId;
		return {
			runtimeSpec: version.runtimeSpec,
			runtimeSpecHash: version.runtimeSpecHash,
			versionKey: record.publishedAppVersionId,
			source: { kind: "chat", ownerId: record.publishedAppId, versionId: record.publishedAppVersionId },
			audit: { agentRevisionId: version.sourceAgentRevision, ...(agentId ? { agentId } : {}) },
		};
	};
}

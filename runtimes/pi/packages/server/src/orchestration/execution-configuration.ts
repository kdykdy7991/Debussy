import type { ExecutionConfigResolver } from "../embed/conversations/execution-configuration.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { OrchestrationError } from "./contracts.ts";
import type { OrchestrationStore } from "./store.ts";

/** Resolve the exact owned, running assignment and its frozen configuration before context preparation. */
export function orchestrationExecutionConfigResolver(
	store: OrchestrationStore,
	repos: PublishingRepositories,
): ExecutionConfigResolver {
	return async (scope, record, turnId) => {
		const [work] = await store.client.run(
			`select w.* from orchestration_work_items w
		 join orchestration_assignments a on a.tenant_id=w.tenant_id and a.work_item_id=w.id and a.integration_id=w.integration_id
		 where w.tenant_id=$1 and w.conversation_id=$2 and w.principal_id=$3 and a.turn_id=$4
		 and a.state='running' and w.state='running'`,
			scope.tenantId,
			record.conversationId,
			scope.principalId,
			turnId,
		);
		if (!work) return undefined;
		let runtimeSpec: unknown;
		let hash: string | null;
		let versionKey: string;
		const independent = work.orchestration_version_id !== null;
		if (independent) {
			if (
				record.source !== "orchestration" ||
				scope.publishedAppId !== null ||
				scope.integrationId !== String(work.integration_id) ||
				record.orchestrationVersionId !== String(work.orchestration_version_id) ||
				record.configurationId !== String(work.configuration_id)
			)
				return undefined;
			const frozen = await store.configurations.getVersion(
				scope.tenantId,
				String(work.orchestration_version_id),
				String(work.configuration_id),
			);
			if (!frozen) return undefined;
			runtimeSpec = frozen.runtimeSpec;
			hash = frozen.runtimeSpecHash;
			versionKey = `orv_${frozen.id}`;
		} else {
			// Historical configuration fact only: no Chat current-version or active-status gate.
			if (scope.publishedAppId === null || record.publishedAppVersionId !== String(work.published_app_version_id))
				return undefined;
			const frozen = await repos.publishedAppVersions.get(
				{ tenantId: scope.tenantId, publishedAppId: scope.publishedAppId },
				record.publishedAppVersionId,
			);
			if (!frozen || frozen.status !== "ready") return undefined;
			runtimeSpec = frozen.runtimeSpec;
			hash = frozen.runtimeSpecHash;
			versionKey = frozen.publishedAppVersionId;
		}
		const parsed = parseRuntimeSpec(runtimeSpec);
		if (
			!parsed.ok ||
			(hash !== null && sha256Hex(canonicalJson(parsed.spec)) !== hash) ||
			(independent && parsed.spec.publishedAppVersionId !== versionKey)
		)
			throw new OrchestrationError(409, "INVALID_EXECUTION_SPEC", "冻结配置或 hash 不一致");
		const contract = String(work.request_contract);
		if (!["input_v1", "legacy_prompt", "legacy_input", "orchestration_event"].includes(contract))
			throw new OrchestrationError(409, "UNKNOWN_REQUEST_CONTRACT", "任务契约无法解释");
		// 动态 Prompt 契约：本次请求的完整 Prompt 覆盖编排版本的 System Prompt，是该 Run 的执行规则。
		const promptOverride = contract === "legacy_prompt";
		if (promptOverride && typeof work.task_prompt !== "string")
			throw new OrchestrationError(409, "INVALID_REQUEST_CONTRACT", "请求提示词快照缺失");
		const effective = promptOverride
			? { ...parsed.spec, agent: { ...parsed.spec.agent, systemPrompt: String(work.task_prompt) } }
			: parsed.spec;
		return {
			runtimeSpec: effective,
			runtimeSpecHash: sha256Hex(canonicalJson(effective)),
			versionKey,
			source: {
				kind: independent ? "orchestration" : "legacy_orchestration",
				ownerId: String(work.integration_id),
				versionId: independent ? versionKey : `pav_${versionKey}`,
			},
			audit: {
				requestContract: contract,
				configurationRevision: Number(work.configuration_revision),
				...(independent ? { configurationId: String(work.configuration_id) } : {}),
				baseRuntimeSpecHash: hash,
			},
			...(promptOverride ? { text: "执行当前系统提示词指定的任务。" } : {}),
		};
	};
}

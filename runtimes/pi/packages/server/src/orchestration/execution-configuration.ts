import type { ExecutionConfigResolver } from "../embed/conversations/execution-configuration.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { canonicalJson, sha256Hex } from "../publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { type CapabilitySnapshot, parseCapabilitySnapshot } from "./api-key-contracts.ts";
import { OrchestrationError } from "./contracts.ts";
import type { OrchestrationStore } from "./store.ts";

const invalidSpec = (message: string) => new OrchestrationError(409, "INVALID_EXECUTION_SPEC", message);

/**
 * Assemble the effective RuntimeSpec of a Key-owned Run from its frozen base
 * spec and its own capability snapshot. Only the snapshot's Servers and Tools
 * survive; every other capability comes from the base spec unchanged.
 */
export function assembleSnapshotRuntimeSpec(base: RuntimeSpec, snapshot: CapabilitySnapshot): RuntimeSpec {
	const servers: RuntimeSpec["capabilities"]["mcpServers"] = [];
	for (const snapshotServer of snapshot.servers) {
		const baseServer = base.capabilities.mcpServers.find((server) => server.mcpServerId === snapshotServer.serverId);
		if (!baseServer) throw invalidSpec("能力快照引用了冻结配置中不存在的 MCP Server");
		if (baseServer.revision !== snapshotServer.revision) throw invalidSpec("MCP Server 修订与能力快照不一致");
		if (baseServer.authentication !== snapshotServer.authentication)
			throw invalidSpec("MCP Server 认证方式与能力快照不一致");
		const tools: typeof baseServer.tools = [];
		for (const snapshotTool of snapshotServer.tools) {
			const baseTool = baseServer.tools.find((tool) => tool.name === snapshotTool.name);
			if (!baseTool) throw invalidSpec("能力快照引用了冻结配置中不存在的 MCP Tool");
			if (canonicalJson(baseTool.inputSchema) !== canonicalJson(snapshotTool.inputSchema))
				throw invalidSpec("MCP Tool 参数与能力快照不一致");
			// The base tool carries description and inputSchemaHash, which the
			// snapshot does not hold and the runtime needs for revision checks.
			tools.push(baseTool);
		}
		// A RuntimeSpec Server always exposes at least one Tool.
		if (tools.length === 0) throw invalidSpec("能力快照中的 MCP Server 不含任何工具");
		servers.push({ ...baseServer, tools });
	}
	return { ...base, capabilities: { ...base.capabilities, mcpServers: servers } };
}

/** Read and verify the Run's own frozen capability snapshot before it is used. */
function readCapabilitySnapshot(work: Record<string, unknown>): CapabilitySnapshot {
	const raw = work.capability_snapshot;
	if (raw === null || raw === undefined) throw invalidSpec("能力快照缺失");
	const expected = work.capability_snapshot_hash;
	if (typeof expected !== "string" || expected.length === 0) throw invalidSpec("能力快照摘要缺失");
	if (sha256Hex(canonicalJson(raw)) !== expected) throw invalidSpec("能力快照摘要不一致");
	const snapshot = parseCapabilitySnapshot(raw);
	if (!snapshot) throw invalidSpec("能力快照格式无效");
	return snapshot;
}

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
		let baseHash: string | null;
		let versionKey: string;
		let snapshotHash: string | null = null;
		const independent = work.orchestration_version_id !== null;
		// A Key-owned Run executes only the capabilities frozen in its own snapshot.
		const keyOwned = work.key_id !== null && work.key_id !== undefined;
		if (keyOwned) {
			// The carrier owns the conversation, and its ids may legitimately differ
			// from the snapshot's version ids, so the conversation is checked against
			// the work item's own carrier columns.
			if (
				record.source !== "orchestration" ||
				scope.publishedAppId !== null ||
				scope.integrationId !== String(work.integration_id) ||
				record.orchestrationVersionId !== String(work.orchestration_version_id) ||
				record.configurationId !== String(work.configuration_id)
			)
				return undefined;
			const snapshot = readCapabilitySnapshot(work);
			// The snapshot names the frozen platform version, not the carrier's own
			// (possibly older) version.
			const frozen = await store.configurations.getVersion(
				scope.tenantId,
				snapshot.orchestrationVersionId,
				snapshot.configurationId,
			);
			if (!frozen) throw invalidSpec("能力快照引用的编排版本不存在");
			const base = parseRuntimeSpec(frozen.runtimeSpec);
			if (!base.ok || sha256Hex(canonicalJson(base.spec)) !== frozen.runtimeSpecHash)
				throw invalidSpec("冻结配置或 hash 不一致");
			versionKey = `orv_${snapshot.orchestrationVersionId}`;
			if (base.spec.publishedAppVersionId !== versionKey) throw invalidSpec("冻结配置或 hash 不一致");
			runtimeSpec = assembleSnapshotRuntimeSpec(base.spec, snapshot);
			// The base hash was verified above; the assembled spec carries its own hash.
			hash = null;
			baseHash = frozen.runtimeSpecHash;
			snapshotHash = String(work.capability_snapshot_hash);
		} else if (independent) {
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
			baseHash = frozen.runtimeSpecHash;
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
			baseHash = frozen.runtimeSpecHash;
			versionKey = frozen.publishedAppVersionId;
		}
		const parsed = parseRuntimeSpec(runtimeSpec);
		if (
			!parsed.ok ||
			(hash !== null && sha256Hex(canonicalJson(parsed.spec)) !== hash) ||
			(independent && parsed.spec.publishedAppVersionId !== versionKey)
		)
			throw invalidSpec("冻结配置或 hash 不一致");
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
				kind: independent || keyOwned ? "orchestration" : "legacy_orchestration",
				ownerId: String(work.integration_id),
				versionId: independent || keyOwned ? versionKey : `pav_${versionKey}`,
			},
			audit: {
				requestContract: contract,
				configurationRevision: Number(work.configuration_revision),
				...(independent ? { configurationId: String(work.configuration_id) } : {}),
				baseRuntimeSpecHash: baseHash,
				...(snapshotHash !== null ? { capabilitySnapshotHash: snapshotHash } : {}),
			},
			...(promptOverride ? { text: "执行当前系统提示词指定的任务。" } : {}),
		};
	};
}

/**
 * Single Agent → ResolvedAgentConfig resolver (WB-Agent 简化 / Publish what
 * was debugged).
 *
 * The ONE place that turns an immutable Agent Revision into the resolved set
 * of runtime inputs consumed by `compileRuntimeSpec`:
 *
 * ```text
 * Agent Revision
 *   ↓ resolveAgentRevisionConfig()
 * ResolvedAgentConfig { agent, skills, mcpServers }
 *   ↓ compileRuntimeSpec()
 * RuntimeSpec
 * ```
 *
 * Both the Debug Chat path and the Publish path MUST feed the same
 * `ResolvedAgentConfig` into the same `compileRuntimeSpec` so that
 * "publish exactly what was debugged" holds by construction (identical
 * `canonicalJson` + `sha256` for the same revision).
 *
 * Credentials are deliberately NOT part of the resolved config: bearer tokens
 * are a turn-time / call-time input, and the Publish control gate checks
 * secret presence separately after resolution (a credential is a runtime
 * resource, not a frozen config input).
 */
import type { AgentDefinitionId } from "../domain/ids.ts";
import { toPublicId } from "../domain/ids.ts";
import type { PublishingRepositories, TenantScope } from "../repositories.ts";
import type { AgentDraftConfig, CompilerInput } from "./compiler.ts";

/** The parts of an immutable Agent Revision the resolver needs. */
export interface AgentConfigRecord {
	readonly agentDefinitionId: AgentDefinitionId;
	readonly revision: number;
	/** The raw `agent_definitions.draft_config` jsonb value. */
	readonly draftConfig: unknown;
}

/** Resolved, complete runtime inputs for one Agent revision. */
export interface ResolvedAgentConfig {
	readonly agent: AgentDraftConfig;
	readonly skills: NonNullable<CompilerInput["skills"]>[number][];
	readonly mcpServers: NonNullable<CompilerInput["mcpServers"]>[number][];
}

export type ResolveAgentRevisionConfigResult =
	| { readonly ok: true; readonly data: ResolvedAgentConfig }
	| { readonly ok: false; readonly error: string };

/** Repositories the resolver reads from (a seam separable for tests). */
export interface ResolveAgentRevisionConfigDeps {
	readonly skills: PublishingRepositories["skills"];
	readonly mcpServers: PublishingRepositories["mcpServers"];
}

/**
 * Resolve one immutable Agent Revision into its full, frozen runtime inputs:
 * the agent draft config plus every bound Skill and MCP Server (each pinned to
 * its specific revision, with the MCP Tool allowlist applied to the frozen
 * discovery snapshot). Never re-resolves "current/latest" skill or MCP
 * revisions — bindings fully pin them.
 */
export async function resolveAgentRevisionConfig(
	deps: ResolveAgentRevisionConfigDeps,
	scope: TenantScope,
	agent: AgentConfigRecord,
): Promise<ResolveAgentRevisionConfigResult> {
	const draft = agent.draftConfig as AgentDraftConfig;
	if (!draft.model?.provider || !draft.model.modelId)
		return { ok: false, error: "agent revision has no usable model" };

	const skills: NonNullable<CompilerInput["skills"]>[number][] = [];
	const skillBindings = await deps.skills.listBindings(scope, agent.agentDefinitionId, agent.revision);
	for (const binding of skillBindings) {
		const skill = await deps.skills.get(scope, binding.skillId);
		const revision = await deps.skills.getRevision(scope, binding.skillId, binding.skillRevision);
		if (skill === undefined || skill.status !== "enabled" || revision === undefined)
			return { ok: false, error: `a bound Skill revision is unavailable (${binding.skillId})` };
		skills.push({
			skillId: toPublicId("SkillId", revision.skillId),
			revision: revision.revision,
			sourceHash: revision.sourceHash,
			name: revision.parsedName,
			description: revision.description,
			instructionText: revision.instructionText,
			disableModelInvocation: revision.disableModelInvocation,
		});
	}

	const mcpServers: NonNullable<CompilerInput["mcpServers"]>[number][] = [];
	const mcpBindings = await deps.mcpServers.listBindings(scope, agent.agentDefinitionId, agent.revision);
	for (const binding of mcpBindings) {
		const server = await deps.mcpServers.get(scope, binding.mcpServerId);
		const revision = await deps.mcpServers.getRevision(scope, binding.mcpServerId, binding.mcpRevision);
		if (server === undefined || server.status !== "enabled" || revision === undefined)
			return { ok: false, error: `a bound MCP Server revision is unavailable (${binding.mcpServerId})` };
		const discovered = await deps.mcpServers.listTools(scope, binding.mcpServerId, binding.mcpRevision);
		const allowed = new Set(binding.toolAllowlist);
		const tools = discovered.filter((tool) => allowed.has(tool.name));
		if (tools.length !== allowed.size)
			return { ok: false, error: "an MCP Tool allowlist does not match its frozen discovery snapshot" };
		mcpServers.push({
			mcpServerId: toPublicId("McpServerId", binding.mcpServerId),
			revision: binding.mcpRevision,
			transport: revision.transport,
			endpoint: revision.endpoint,
			authentication: revision.authentication,
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				inputSchemaHash: tool.inputSchemaHash,
			})),
		});
	}

	return { ok: true, data: { agent: draft, skills, mcpServers } };
}

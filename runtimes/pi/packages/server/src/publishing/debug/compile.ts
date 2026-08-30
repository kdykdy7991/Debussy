/**
 * Debug RuntimeSpec compilation (Phase 1).
 *
 * Resolves the Agent's current revision and freezes it into an immutable
 * RuntimeSpec + hash, mirroring the Production `createVersion` compile path
 * but WITHOUT a published app version row. `publishedAppVersionId` inside the
 * Debug spec is a deterministic synthetic id (`debug-<agent>-<revision>`), so
 * skill/session materialisation is stable across Turns for the same revision
 * while never colliding with a real published version id.
 *
 * Credentials are deliberately NOT resolved or stored here: bearer tokens and
 * MCP server liveness are read live at call time (per the runtime-spec review:
 * they are turn-time / resource-time inputs, not frozen spec inputs).
 */

import { type AgentDefinitionId, toPublicId } from "../domain/ids.ts";
import type { PublishingRepositories, TenantScope } from "../repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog, CompilerInput } from "../runtime-spec/compiler.ts";
import { compileRuntimeSpec } from "../runtime-spec/compiler.ts";
import type { RuntimeSpec } from "../runtime-spec/schema.ts";

export type DebugCompileResult =
	| {
			readonly ok: true;
			readonly agentRevision: number;
			readonly agentName: string;
			readonly spec: RuntimeSpec;
			readonly canonicalJson: string;
			readonly runtimeSpecHash: string;
			readonly resolvedAgentRevisionName?: string;
	  }
	| { readonly ok: false; readonly error: string };

export interface DebugCompileDeps {
	readonly repositories: PublishingRepositories;
	readonly catalog: CapabilityCatalog;
}

/** Resolve + compile the latest revision of an agent from the tenant scope. */
export async function compileDebugAgentRevision(
	deps: DebugCompileDeps,
	scope: TenantScope,
	agentId: AgentDefinitionId,
	agentName?: string,
): Promise<DebugCompileResult> {
	const agent = await deps.repositories.agentDefinitions.getLatest(scope, agentId);
	if (agent === undefined) return { ok: false, error: "agent revision is unavailable" };
	const draft = agent.draftConfig as AgentDraftConfig;
	if (!draft.model?.provider || !draft.model.modelId)
		return { ok: false, error: "agent revision has no usable model" };

	const skills: NonNullable<CompilerInput["skills"]>[number][] = [];
	const skillBindings = await deps.repositories.skills.listBindings(scope, agentId, agent.revision);
	for (const binding of skillBindings) {
		const skill = await deps.repositories.skills.get(scope, binding.skillId);
		const revision = await deps.repositories.skills.getRevision(scope, binding.skillId, binding.skillRevision);
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
	const mcpBindings = await deps.repositories.mcpServers.listBindings(scope, agentId, agent.revision);
	for (const binding of mcpBindings) {
		const server = await deps.repositories.mcpServers.get(scope, binding.mcpServerId);
		const revision = await deps.repositories.mcpServers.getRevision(scope, binding.mcpServerId, binding.mcpRevision);
		if (server === undefined || server.status !== "enabled" || revision === undefined)
			return { ok: false, error: `a bound MCP Server revision is unavailable (${binding.mcpServerId})` };
		const discovered = await deps.repositories.mcpServers.listTools(scope, binding.mcpServerId, binding.mcpRevision);
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

	const syntheticVersionId = syntheticDebugVersionId(agentId, agent.revision);
	const compiled = compileRuntimeSpec({
		agent: draft,
		publishedAppVersionId: syntheticVersionId,
		catalog: deps.catalog,
		skills,
		mcpServers,
	});
	if (!compiled.ok) return { ok: false, error: `RuntimeSpec compile failed: ${compiled.errors.join("; ")}` };
	return {
		ok: true,
		agentRevision: agent.revision,
		agentName: agentName ?? agentId,
		spec: compiled.spec,
		canonicalJson: compiled.canonicalJson,
		runtimeSpecHash: compiled.sha256,
	};
}

/** Deterministic, stable materialisation key for a Debug (agent, revision) spec. */
export function syntheticDebugVersionId(agentId: AgentDefinitionId, revision: number): string {
	return `debug-${agentId}-${revision}`;
}

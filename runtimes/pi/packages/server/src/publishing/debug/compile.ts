/**
 * Debug RuntimeSpec compilation (Phase 1) — now a THIN wrapper over the shared
 * `resolveAgentRevisionConfig` + `compileRuntimeSpec` single path.
 *
 * Resolves the Agent's *latest* revision and freezes it into an immutable
 * RuntimeSpec + hash, mirroring the Production compile path but WITHOUT a
 * published app version row. `publishedAppVersionId` inside the Debug spec is
 * a deterministic synthetic id (`debug-<agent>-<revision>`), so
 * skill/session materialisation is stable across Turns for the same revision
 * while never colliding with a real published version id.
 *
 * Credentials are deliberately NOT resolved or stored here: bearer tokens and
 * MCP server liveness are read live at call time (turn-time / resource-time
 * inputs, not frozen spec inputs).
 */
import type { AgentDefinitionId } from "../domain/ids.ts";
import type { PublishingRepositories, TenantScope } from "../repositories.ts";
import type { CapabilityCatalog } from "../runtime-spec/compiler.ts";
import { compileRuntimeSpec } from "../runtime-spec/compiler.ts";
import { resolveAgentRevisionConfig } from "../runtime-spec/resolve.ts";
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

	const resolved = await resolveAgentRevisionConfig(
		{ skills: deps.repositories.skills, mcpServers: deps.repositories.mcpServers },
		scope,
		{ agentDefinitionId: agentId, revision: agent.revision, draftConfig: agent.draftConfig },
	);
	if (!resolved.ok) return { ok: false, error: resolved.error };

	const syntheticVersionId = syntheticDebugVersionId(agentId, agent.revision);
	const compiled = compileRuntimeSpec({
		agent: resolved.data.agent,
		publishedAppVersionId: syntheticVersionId,
		catalog: deps.catalog,
		skills: resolved.data.skills,
		mcpServers: resolved.data.mcpServers,
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

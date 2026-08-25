/**
 * Capability catalog snapshot for the running server (TASK-013).
 *
 * MVP semantics: the publishable whitelist IS the current agent's own
 * capabilities — the tools registered by the loaded extensions, the models
 * currently available, and the enabled knowledge bases (skills). The compiler
 * (TASK-010) then accepts exactly these references, so a server publishing
 * itself produces a `ready` version instead of rejecting everything.
 *
 * The catalog is derived from `AgentSessionServices` (never from implicit
 * global settings) and carries no secrets: only ids and display names.
 */
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { modelParameterCapabilities } from "../../model-parameters.ts";
import type { CapabilityCatalog } from "../runtime-spec/compiler.ts";

/** Build the capability whitelist from the current agent services. */
export function buildCapabilityCatalog(services: AgentSessionServices): CapabilityCatalog {
	const tools: { id: string; name: string }[] = [];
	const seenTools = new Set<string>();
	for (const extension of services.resourceLoader.getExtensions().extensions) {
		for (const [toolId, registered] of extension.tools) {
			if (seenTools.has(toolId)) continue;
			seenTools.add(toolId);
			tools.push({ id: toolId, name: registered.definition.label });
		}
	}

	const models: CapabilityCatalog["models"][number][] = [];
	const seenModels = new Set<string>();
	for (const model of services.modelRuntime.getAvailableSnapshot()) {
		const key = `${model.provider}/${model.id}`;
		if (seenModels.has(key)) continue;
		seenModels.add(key);
		models.push({
			provider: model.provider,
			modelId: model.id,
			parameterCapabilities: modelParameterCapabilities({
				id: model.id,
				api: model.api,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
			}),
		});
	}

	const knowledgeBases: { id: string }[] = [];
	for (const skill of services.resourceLoader.getSkills().skills) {
		knowledgeBases.push({ id: skill.name });
	}

	return { tools, models, knowledgeBases };
}

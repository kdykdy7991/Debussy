/**
 * Production `CurrentAgentDefinitionSource` (spec 33.3, TASK-013).
 *
 * Collects the publishable subset of the currently-resolved Server / Coding
 * Agent configuration from `AgentSessionServices`. The adapter only reads the
 * declared, publishable fields:
 *
 *  - system prompt from the resource loader,
 *  - default model (provider + model id) from settings / model runtime,
 *  - tool references that pass the platform whitelist,
 *  - conservative defaults for uploads / speech / avatar / theme.
 *
 * It NEVER collects: API keys, bearer tokens, cookies, proxy credentials,
 * arbitrary file contents under the cwd, user session history, dynamic
 * extensions outside the whitelist, or absolute local paths. Everything that
 * cannot be mapped safely is reported as a warning, never smuggled in.
 */
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { AgentDraftConfig, CapabilityCatalog } from "../runtime-spec/compiler.ts";
import type { CurrentAgentDefinitionSource } from "./service.ts";

export interface SourceWarning {
	readonly code: string;
	readonly path: string;
	readonly message: string;
}

export interface ServerAgentSourceOptions {
	readonly services: AgentSessionServices;
	/** Platform whitelist; refs outside it become TOOL_EXCLUDED warnings. */
	readonly catalog: CapabilityCatalog;
	/** Display name for the imported agent definition. */
	readonly name?: string;
}

/**
 * Build the production adapter bound to the current agent services.
 * `collect()` is stateless and safe to call repeatedly.
 */
export function createServerAgentSource(options: ServerAgentSourceOptions): CurrentAgentDefinitionSource {
	const services = options.services;
	const catalog = options.catalog;
	const name = options.name ?? "current-agent";
	const warnings: SourceWarning[] = [];

	return {
		async collect() {
			warnings.length = 0;
			const config = collectConfig();
			return { name, config, warnings: [...warnings] };
		},
	};

	function collectConfig(): AgentDraftConfig {
		const prompt = collectPrompt();
		const model = collectModel();
		const tools = collectTools();
		return {
			prompt,
			model,
			tools,
			knowledgeBases: [],
			// Conservative MVP defaults: local single-user values are not
			// publishable, so uploads stay enabled with platform defaults.
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: false },
			avatar: { enabled: false },
		};
	}

	function collectPrompt(): string {
		const system = services.resourceLoader.getSystemPrompt();
		if (system !== undefined && system.trim() !== "") return system;
		const prompts = services.resourceLoader.getPrompts();
		if (prompts.prompts.length > 0) {
			// Prompt templates are file references, not publishable content:
			// surface them as warnings and fall back to an empty prompt.
			warnings.push({
				code: "PROMPT_TEMPLATE_NOT_IMPORTED",
				path: "prompt",
				message: "Local prompt templates are not publishable in MVP; the system prompt is left empty",
			});
			return "";
		}
		return "";
	}

	function collectModel(): AgentDraftConfig["model"] {
		const provider = services.settingsManager.getDefaultProvider();
		const modelId = services.settingsManager.getDefaultModel();
		if (provider !== undefined && modelId !== undefined) {
			const model = services.modelRuntime.getModel(provider, modelId);
			if (model !== undefined) {
				if (model.input.includes("image")) {
					warnings.push({
						code: "MODEL_CAPABILITY_NOT_IMPORTED",
						path: "model.params",
						message: "Image input is not publishable in MVP; only the model id is imported",
					});
				}
				return { provider, modelId };
			}
		}
		const snapshot = services.modelRuntime.getAvailableSnapshot();
		if (snapshot.length > 0) {
			const first = snapshot[0]!;
			if (provider !== undefined || modelId !== undefined) {
				warnings.push({
					code: "MODEL_DEFAULT_UNAVAILABLE",
					path: "model",
					message: `Configured default model (${provider ?? "*"}/${modelId ?? "*"}) is not available; falling back to ${first.provider}/${first.id}`,
				});
			}
			return { provider: first.provider, modelId: first.id };
		}
		throw new Error("no available model to publish: configure a default model first");
	}

	function collectTools(): NonNullable<AgentDraftConfig["tools"]> {
		const out: { id: string; config?: Readonly<Record<string, unknown>> }[] = [];
		const seen = new Set<string>();
		for (const extension of services.resourceLoader.getExtensions().extensions) {
			for (const [toolId, registered] of extension.tools) {
				if (seen.has(toolId)) continue;
				seen.add(toolId);
				const entry = catalog.tools.find((candidate) => candidate.id === toolId);
				if (entry === undefined) {
					warnings.push({
						code: "TOOL_EXCLUDED",
						path: `tools.${toolId}`,
						message: `Tool ${toolId} is not in the platform whitelist (${registered.definition.label})`,
					});
					continue;
				}
				out.push({ id: toolId });
			}
		}
		return out;
	}
}

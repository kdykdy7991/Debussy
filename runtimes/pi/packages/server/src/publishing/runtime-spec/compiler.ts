/**
 * RuntimeSpec Compiler (spec 5.3/5.4/5.5, TASK-010).
 *
 * A pure function over an explicit `CapabilityCatalog` — never implicit global
 * settings — that freezes one Agent revision into an immutable RuntimeSpec:
 *
 * - copies prompt/model/tools/knowledge/upload/theme configuration,
 * - resolves every tool / model / knowledge base reference against the
 *   platform whitelist (unapproved references are rejected),
 * - emits canonical JSON + SHA-256 via `hash.ts`,
 * - NEVER copies provider secrets: only the fields declared by `AgentDraftConfig`
 *   are read, so stray `apiKey`/`token` fields in a draft can never leak into
 *   the spec or its hash.
 *
 * The output is re-parsed with `parseRuntimeSpec`, so the Compiler can never
 * produce a structure the runtime Decoder cannot re-read (TASK-009 forbids
 * that), and the same input always yields the same hash (draft edits never
 * change already-compiled outputs because compilation is deterministic).
 */
import type { ModelParameterCapabilities } from "@earendil-works/pi-protocol";
import { canonicalJson, sha256Hex } from "./hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "./schema.ts";

/** Platform whitelist entries (TASK-010: explicit capability catalog). */
export interface ToolCatalogEntry {
	readonly id: string;
	readonly name: string;
}
export interface ModelCatalogEntry {
	readonly provider: string;
	readonly modelId: string;
	readonly parameterCapabilities?: ModelParameterCapabilities;
}
export interface KnowledgeBaseCatalogEntry {
	readonly id: string;
}
export interface CapabilityCatalog {
	readonly tools: readonly ToolCatalogEntry[];
	readonly models: readonly ModelCatalogEntry[];
	readonly knowledgeBases: readonly KnowledgeBaseCatalogEntry[];
}

/** The configurable fields of one frozen Agent revision. */
export interface AgentDraftConfig {
	/** Console-only metadata retained with the immutable revision. */
	readonly description?: string;
	readonly prompt: string;
	readonly model: {
		readonly provider: string;
		readonly modelId: string;
		readonly params?: Readonly<Record<string, unknown>>;
	};
	readonly tools?: readonly { readonly id: string; readonly config?: Readonly<Record<string, unknown>> }[];
	readonly knowledgeBases?: readonly { readonly id: string }[];
	readonly uploads?: {
		readonly enabled?: boolean;
		readonly maxFiles?: number;
		readonly maxFileBytes?: number;
	};
	readonly speech?: { readonly enabled?: boolean };
	readonly realtimeVoice?: { readonly enabled?: boolean };
	readonly avatar?: { readonly enabled?: boolean };
	readonly conversations?: { readonly allowNew?: boolean };
	readonly theme?: { readonly primaryColor?: string; readonly welcomeMessage?: string };
	readonly contextPolicy?: {
		readonly maxTurns?: number;
		readonly maxContextTokens?: number;
		readonly toolResultMaxBytes?: number;
	};
	readonly runtimePolicy?: {
		readonly profile?: "chat-only" | "chat-with-files";
		readonly turnTimeoutMs?: number;
		readonly idleTtlMs?: number;
		readonly maxConcurrentTurnsPerConversation?: number;
	};
}

export interface CompilerInput {
	readonly agent: AgentDraftConfig;
	/** Public id of the published-app version this spec is frozen for. */
	readonly publishedAppVersionId: string;
	readonly catalog: CapabilityCatalog;
	readonly skills?: readonly {
		readonly skillId: string;
		readonly revision: number;
		readonly sourceHash: string;
		readonly name: string;
		readonly description: string;
		readonly instructionText: string;
		readonly disableModelInvocation: boolean;
	}[];
	readonly mcpServers?: readonly {
		readonly mcpServerId: string;
		readonly revision: number;
		readonly transport: "streamable_http";
		readonly endpoint: string;
		readonly authentication: "none" | "bearer";
		readonly tools: readonly {
			readonly name: string;
			readonly description: string | null;
			readonly inputSchema: Readonly<Record<string, unknown>>;
			readonly inputSchemaHash: string;
		}[];
	}[];
	readonly securityPolicyVersion?: string;
}

export type CompileResult =
	| {
			readonly ok: true;
			readonly spec: RuntimeSpec;
			readonly canonicalJson: string;
			readonly sha256: string;
	  }
	| { readonly ok: false; readonly errors: readonly string[] };

export function compileRuntimeSpec(input: CompilerInput): CompileResult {
	const errors: string[] = [];
	const { agent, catalog } = input;
	const skills = input.skills ?? [];
	const mcpServers = input.mcpServers ?? [];
	const mcpToolNames = mcpServers.flatMap((server) => server.tools.map((tool) => tool.name));
	if (mcpToolNames.length > 32) errors.push("MCP Tool allowlist exceeds the platform limit of 32");
	if (new Set(mcpToolNames).size !== mcpToolNames.length)
		errors.push("MCP Tool names must be unique across all bound Servers");
	// Skills are NOT spliced into the frozen system prompt. The runtime
	// materializes each frozen revision to a read-only dir and injects it into
	// the session's ResourceLoader via skillsOverride, so Pi's native skill
	// mechanics (progressive <available_skills> disclosure + /skill:name)
	// apply. Keeping the full instruction text out of the system prompt avoids
	// paying for every bound skill's body on every turn.
	const systemPrompt = agent.prompt;

	const model = catalog.models.find(
		(entry) => entry.provider === agent.model.provider && entry.modelId === agent.model.modelId,
	);
	if (model === undefined) {
		errors.push(`model ${agent.model.provider}/${agent.model.modelId} is not on the platform whitelist`);
	}

	const tools = (agent.tools ?? []).map((tool) => {
		if (!catalog.tools.some((entry) => entry.id === tool.id)) {
			errors.push(`tool ${tool.id} is not on the platform whitelist`);
			return undefined;
		}
		return tool.config === undefined ? { id: tool.id } : { id: tool.id, config: tool.config };
	});

	const knowledgeBases = (agent.knowledgeBases ?? []).map((kb) => {
		if (!catalog.knowledgeBases.some((entry) => entry.id === kb.id)) {
			errors.push(`knowledge base ${kb.id} is not on the platform whitelist`);
			return undefined;
		}
		return { id: kb.id };
	});

	if (errors.length > 0) return { ok: false, errors };

	const parsed = parseRuntimeSpec({
		schemaVersion: 1,
		publishedAppVersionId: input.publishedAppVersionId,
		agent: {
			systemPrompt,
			model: {
				provider: agent.model.provider,
				modelId: agent.model.modelId,
				...(model?.parameterCapabilities === undefined
					? {}
					: { parameterCapabilities: model.parameterCapabilities }),
				...("params" in agent.model && agent.model.params !== undefined ? { params: agent.model.params } : {}),
			},
		},
		capabilities: {
			tools: tools.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined),
			knowledgeBases: knowledgeBases.filter((kb): kb is NonNullable<typeof kb> => kb !== undefined),
			skills,
			mcpServers,
			...("uploads" in agent && agent.uploads !== undefined ? { uploads: agent.uploads } : {}),
			...("speech" in agent && agent.speech !== undefined ? { speech: agent.speech } : {}),
			...(agent.realtimeVoice === undefined ? {} : { realtimeVoice: agent.realtimeVoice }),
			...("avatar" in agent && agent.avatar !== undefined ? { avatar: agent.avatar } : {}),
			...("conversations" in agent && agent.conversations !== undefined
				? { conversations: agent.conversations }
				: {}),
		},
		...("contextPolicy" in agent && agent.contextPolicy !== undefined ? { contextPolicy: agent.contextPolicy } : {}),
		...("runtimePolicy" in agent && agent.runtimePolicy !== undefined ? { runtimePolicy: agent.runtimePolicy } : {}),
		securityPolicyVersion: input.securityPolicyVersion ?? "sp_001",
		...("theme" in agent && agent.theme !== undefined ? { theme: agent.theme } : {}),
	});
	if (!parsed.ok) return { ok: false, errors: parsed.errors };

	const json = canonicalJson(parsed.spec);
	return { ok: true, spec: parsed.spec, canonicalJson: json, sha256: sha256Hex(json) };
}

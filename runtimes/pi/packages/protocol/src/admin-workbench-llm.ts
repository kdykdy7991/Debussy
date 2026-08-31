/**
 * Custom LLM provider contracts shared by the Admin Web console and the
 * Control API.
 *
 * The agent runtime already loads user-defined providers from `models.json`
 * (`<agentDir>/models.json`). These contracts expose that file through the
 * control plane so the admin console can list / configure / validate custom
 * OpenAI-compatible endpoints without hand-editing the file, and the server
 * always triggers a runtime reload after a write so the model list and the
 * Chat model picker reflect the change immediately.
 */

export type CustomLlmApi = "openai-completions" | "openai-responses";

/** A custom model exposed by a provider, as persisted in `models.json`.
 *
 * `contextWindow` / `maxTokens` are mandatory on every *new write* through the
 * Debussy Control API so the runtime does not silently fall back to Pi's
 * defaults (128000 / 16384). They may be absent on the read side only when an
 * older `models.json` predates this field — the operator must fill them in
 * before the model can be saved again.
 */
export interface LlmProviderModelView {
	readonly id: string;
	/** Stored display name, if any. */
	readonly name?: string;
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
	/** Max input context tokens (Pi `Model.contextWindow`). Absent iff the
	 * stored config predates this field. */
	readonly contextWindow?: number;
	/** Max output tokens for one response (Pi `Model.maxTokens`). Absent iff
	 * the stored config predates this field. */
	readonly maxTokens?: number;
}

/** Wire shape of a user-configured custom LLM provider. Secrets (the API key)
 * are write-only: reads never include them, only the `apiKeyConfigured` flag. */
export interface CustomLlmProvider {
	/** Stable provider id (`models.json` top-level key). Lowercase `[a-z0-9_-]`. */
	readonly id: string;
	/** Display name shown in the console and the Chat model picker. */
	readonly name: string;
	/** Base URL of the OpenAI-compatible endpoint, e.g. `https://gateway/v1`. */
	readonly baseUrl: string;
	/** OpenAI protocol baked into every model of this provider. */
	readonly api: CustomLlmApi;
	/** Models this endpoint exposes, with their persisted context bounds. */
	readonly models: readonly LlmProviderModelView[];
	/** True when a non-empty API key is configured (env-ref, literal, or stored). */
	readonly apiKeyConfigured: boolean;
}

/** One model entry in an upsert. `contextWindow` / `maxTokens` are required. */
export interface UpsertLlmModelSpec {
	readonly id: string;
	/** Max input context tokens; must be a positive integer. */
	readonly contextWindow: number;
	/** Max output tokens for one response; positive integer not above contextWindow. */
	readonly maxTokens: number;
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Partial<Record<"low" | "medium" | "high", string | null>>;
}

/** `POST /api/control/v1/llm-providers` — create or update a provider. */
export interface UpsertCustomLlmProviderInput {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: CustomLlmApi;
	readonly models: readonly UpsertLlmModelSpec[];
	/** API key. Plain value -> stored as-is; `$NAME` -> read from env at runtime. Omit to keep. */
	readonly apiKey?: string;
}

export interface LlmProvidersListResponse {
	readonly items: readonly CustomLlmProvider[];
	readonly reloaded: boolean;
}

export interface LlmProviderResponse {
	readonly provider: CustomLlmProvider;
}

export interface LlmProviderTestResponse {
	/** Endpoint reachable + authenticated. */
	readonly ok: boolean;
	/** What the endpoint advertised, when discoverable. */
	readonly advertisedModels?: readonly string[];
	readonly error?: string;
}

/** A model the runtime exposes right now (used by the Chat model switcher). */
export interface LlmAvailableModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly reasoning: boolean;
	/** Provider-specific values used for the console's low / medium / high tiers. */
	readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
	readonly parameterCapabilities: ModelParameterCapabilities;
}

export interface ModelParameterCapabilities {
	readonly reasoning: {
		readonly supported: boolean;
		readonly toggle: boolean;
		readonly efforts: readonly import("./admin-workbench-agents.ts").ReasoningEffort[];
		readonly defaultEffort?: import("./admin-workbench-agents.ts").ReasoningEffort;
	};
}

export interface LlmAvailableModelsResponse {
	readonly items: readonly LlmAvailableModel[];
}

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
	/** Model ids this endpoint exposes. */
	readonly models: readonly string[];
	/** True when a non-empty API key is configured (env-ref, literal, or stored). */
	readonly apiKeyConfigured: boolean;
}

/** `POST /api/control/v1/llm-providers` — create or update a provider. */
export interface UpsertCustomLlmProviderInput {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: CustomLlmApi;
	readonly models: readonly string[];
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
}

export interface LlmAvailableModelsResponse {
	readonly items: readonly LlmAvailableModel[];
}

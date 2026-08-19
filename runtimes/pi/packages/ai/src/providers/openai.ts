import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { OPENAI_MODELS } from "./openai.models.ts";

export function openaiProvider(): Provider<"openai-responses"> {
	// Allow OPENAI_BASE_URL env override so the same provider can be used
	// against OpenAI-compatible gateways (vLLM, LocalAI, LiteLLM, Azure
	// OpenAI endpoint, internal proxies) without forking the provider.
	// Falls back to the public OpenAI endpoint when the env var is unset.
	return createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: getProviderEnvValue("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: Object.values(OPENAI_MODELS),
		api: openAIResponsesApi(),
	});
}

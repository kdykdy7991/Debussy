/**
 * OpenAI-compatible provider (independent from the built-in `openai` provider).
 *
 * Walks the same OpenAI Responses API and reuses the same model catalog as
 * the built-in `openai` provider, but is registered as a separate provider
 * id and reads its endpoint from the `OPENAI_BASE_URL` env var (falling back
 * to the default OpenAI endpoint when the var is unset). Use this when you
 * want to point the same model set at any OpenAI-compatible endpoint without
 * touching the built-in `openai` provider:
 *
 * - vLLM / LocalAI / LM Studio / Ollama (self-hosted)
 * - LiteLLM / OneAPI / Portkey (gateways)
 * - Azure OpenAI (custom endpoint)
 * - Internal LLM proxies
 *
 * The built-in `openai` provider is unchanged. The only way to talk to a
 * custom endpoint is to select this provider explicitly.
 */
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { openaiProvider } from "./openai.ts";

const PROVIDER_ID = "openai-compatible";
const PROVIDER_NAME = "OpenAI Compatible";

/**
 * Reuse the built-in `openai` provider as a template so we automatically
 * inherit its API implementation, auth, and model catalog. Only the
 * user-visible bits (id, name, baseUrl, model provider id, model baseUrl)
 * are rewritten for the new provider namespace.
 */
export function openaiCompatibleProvider(): Provider<"openai-responses"> {
	const baseUrl = getProviderEnvValue("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
	const upstream = openaiProvider();
	return createProvider({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl,
		auth: upstream.auth,
		models: upstream.getModels().map((model) => ({
			...model,
			// Re-stamp every model into the `openai-compatible` namespace so the
			// chat UI groups them under this provider and requests use `baseUrl`.
			provider: PROVIDER_ID,
			baseUrl,
		})),
		api: openAIResponsesApi(),
	});
}

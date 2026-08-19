/**
 * OpenAI-compatible provider (independent from the built-in `openai` provider).
 *
 * Walks the same OpenAI Responses API and reuses the same model catalog as
 * the built-in `openai` provider, but is registered as a separate provider
 * id and reads its endpoint from the `OPENAI_BASE_URL` env var. Use this
 * when you want to point the same model set at any OpenAI-compatible
 * endpoint without touching the built-in `openai` provider:
 *
 * - vLLM / LocalAI / LM Studio / Ollama (self-hosted)
 * - LiteLLM / OneAPI / Portkey (gateways)
 * - Azure OpenAI (custom endpoint)
 * - Internal LLM proxies
 *
 * The built-in `openai` provider is unchanged. The only way to talk to a
 * custom endpoint is to select this provider explicitly.
 */
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { Provider } from "../models.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { openaiProvider } from "./openai.ts";

const PROVIDER_ID = "openai-compatible";
const PROVIDER_NAME = "OpenAI Compatible";

/**
 * Reuse the built-in `openai` provider as a template so we automatically
 * inherit its API implementation, model catalog, and any future fields.
 * Only the user-visible bits (id, name, baseUrl, model provider id,
 * model baseUrl) are rewritten for the new provider namespace.
 */
export function openaiCompatibleProvider(): Provider {
	const baseUrl = getProviderEnvValue("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
	const upstream = openaiProvider();
	const models = upstream.getModels().map((model) => ({
		...model,
		// The built-in catalog is typed against the `openai` provider id; we
		// re-stamp every model so the chat UI sees a clean `openai-compatible`
		// namespace. `as unknown as` is intentional — the structural shape
		// is preserved.
		provider: PROVIDER_ID as unknown as typeof model.provider,
		baseUrl,
	}));
	return {
		...upstream,
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl,
		models,
	} as Provider;
}

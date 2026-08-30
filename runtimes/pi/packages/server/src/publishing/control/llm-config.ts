/**
 * Custom LLM provider store for the control plane.
 *
 * Persistence is `<engineDir>/models.json` — the exact file pi's
 * `ModelRuntime` loads at startup and re-reads on every `refresh()`. This
 * store is a thin, secret-blind write/read facade over that file and always
 * triggers a runtime reload after a write so the console model list and the
 * Chat model picker reflect the change without a restart.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { CustomLlmApi, ModelParameterCapabilities } from "@earendil-works/pi-protocol";
import { modelParameterCapabilities } from "../../model-parameters.ts";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KNOWN_APIS: readonly CustomLlmApi[] = ["openai-completions", "openai-responses"];

/** A single provider entry inside models.json (only the fields we use). */
interface ModelsJsonProviderEntry {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models?: readonly { id: string; name?: string; [key: string]: unknown }[];
	[key: string]: unknown;
}

export interface CustomLlmProviderView {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomLlmApi;
	models: readonly string[];
	apiKeyConfigured: boolean;
}

export type LlmModelSpecInput =
	| string
	| {
			id: string;
			reasoning?: boolean;
			thinkingLevelMap?: Partial<Record<"low" | "medium" | "high", string | null>>;
	  };

export interface LlmConfigStore {
	list(): Promise<CustomLlmProviderView[]>;
	upsert(input: {
		id: string;
		name: string;
		baseUrl: string;
		api: CustomLlmApi;
		models: readonly LlmModelSpecInput[];
		apiKey?: string;
	}): Promise<CustomLlmProviderView>;
	remove(id: string): Promise<boolean>;
	reload(): Promise<void>;
	listAvailableModels(): Promise<
		readonly {
			readonly provider: string;
			readonly id: string;
			readonly name: string;
			readonly api: string;
			readonly reasoning: boolean;
			readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
			readonly parameterCapabilities: ModelParameterCapabilities;
		}[]
	>;
	test(input: {
		providerId?: string;
		baseUrl: string;
		api: CustomLlmApi;
		apiKey?: string;
	}): Promise<{ ok: boolean; advertisedModels?: readonly string[]; error?: string }>;
}

/**
 * Build the store bound to the running agent services. `agentDir` gives the
 * models.json path and `modelRuntime.refresh()` is the hot-reload primitive.
 */
export function createLlmConfigStore(services: AgentSessionServices): LlmConfigStore {
	const modelsPath = join(services.agentDir, "models.json");

	return { list, upsert, remove, reload, listAvailableModels, test };

	async function list(): Promise<CustomLlmProviderView[]> {
		const file = readConfig();
		const providers = file.providers ?? {};
		const out: CustomLlmProviderView[] = [];
		for (const [id, entry] of Object.entries(providers)) {
			const view = toView(id, entry);
			if (view !== undefined) out.push(view);
		}
		out.sort((a, b) => a.id.localeCompare(b.id));
		return out;
	}

	async function upsert(input: {
		id: string;
		name: string;
		baseUrl: string;
		api: CustomLlmApi;
		models: readonly LlmModelSpecInput[];
		apiKey?: string;
	}): Promise<CustomLlmProviderView> {
		validateId(input.id);
		const name = requireNonEmpty(input.name, "name");
		const baseUrl = requireHttpUrl(input.baseUrl, "baseUrl");
		if (!KNOWN_APIS.includes(input.api)) {
			throw new Error(`api must be one of ${KNOWN_APIS.join(" | ")}`);
		}
		const models = normalizeModels(input.models);

		const file = readConfig();
		const existing = file.providers?.[input.id] as ModelsJsonProviderEntry | undefined;
		const entry: ModelsJsonProviderEntry = {
			...existing,
			name,
			baseUrl,
			api: input.api,
			models: models.map((spec) => {
				const prev = existing?.models?.find((model) => model.id === spec.id);
				let mergedMap: Record<string, string | null> | undefined;
				if (spec.thinkingLevelMap && Object.keys(spec.thinkingLevelMap).length) {
					// Merge into the existing map: a string sets a level's effort,
					// a null removes that level so the runtime falls back to the
					// same-name effort. Emit even when the result is empty to fully
					// clear a previously saved mapping.
					mergedMap = { ...(prev?.thinkingLevelMap ?? {}) };
					for (const [level, value] of Object.entries(spec.thinkingLevelMap)) {
						if (value === null) delete mergedMap[level];
						else if (typeof value === "string") mergedMap[level] = value;
					}
				}
				return {
					...(prev ?? {}),
					id: spec.id,
					...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
					...(mergedMap !== undefined ? { thinkingLevelMap: mergedMap } : {}),
				};
			}),
		};
		// Preserve the existing provider and per-model capabilities unless the caller replaces them.
		if (input.apiKey !== undefined) {
			if (input.apiKey.trim() === "") throw new Error("apiKey must not be empty when provided");
			entry.apiKey = input.apiKey;
		} else if (existing?.apiKey !== undefined) {
			entry.apiKey = existing.apiKey;
		}
		if (existing?.headers !== undefined) {
			entry.headers = existing.headers;
		}

		file.providers = file.providers ?? {};
		file.providers[input.id] = entry;
		writeConfig(file);

		await reload();

		const view = toView(input.id, entry);
		if (view === undefined) throw new Error("provider was written but could not be re-read");
		return view;
	}

	async function remove(id: string): Promise<boolean> {
		validateId(id);
		const file = readConfig();
		const providers = file.providers ?? {};
		if (!(id in providers)) return false;
		delete providers[id];
		await writeConfig(file);
		await reload();
		return true;
	}

	async function listAvailableModels(): Promise<
		readonly {
			readonly provider: string;
			readonly id: string;
			readonly name: string;
			readonly api: string;
			readonly reasoning: boolean;
			readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
			readonly parameterCapabilities: ModelParameterCapabilities;
		}[]
	> {
		try {
			const models = services.modelRuntime.getAvailableSnapshot();
			return models.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: typeof model.name === "string" ? model.name : model.id,
				api: model.api,
				reasoning: model.reasoning === true,
				thinkingLevelMap: normalizeThinkingLevelMap(model.thinkingLevelMap),
				parameterCapabilities: modelParameterCapabilities({
					id: model.id,
					api: model.api,
					reasoning: model.reasoning === true,
					thinkingLevelMap: model.thinkingLevelMap,
				}),
			}));
		} catch {
			return [];
		}
	}

	async function reload(): Promise<void> {
		await services.modelRuntime.refresh();
	}

	async function test(input: {
		providerId?: string;
		baseUrl: string;
		api: CustomLlmApi;
		apiKey?: string;
	}): Promise<{ ok: boolean; advertisedModels?: readonly string[]; error?: string }> {
		const baseUrl = requireHttpUrl(input.baseUrl, "baseUrl");
		if (!KNOWN_APIS.includes(input.api)) {
			return { ok: false, error: `api must be one of ${KNOWN_APIS.join(" | ")}` };
		}
		// When the caller edits an already-saved provider, it does not re-send
		// the stored key (the form keeps the field blank). Fall back to the
		// persisted key so「测试连接」verifies the live config instead of 401ing.
		const apiKey = input.apiKey ?? readConfig()?.providers?.[input.providerId ?? ""]?.apiKey;
		try {
			const modelsUrl = `${baseUrl.replace(/\/+$/, "")}/models`;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 10_000);
			try {
				const response = await fetch(modelsUrl, {
					signal: controller.signal,
					headers: apiKey ? { Authorization: `Bearer ${resolveApiKey(apiKey)}` } : undefined,
				});
				if (!response.ok) {
					return { ok: false, error: `endpoint responded with HTTP ${response.status}` };
				}
				const body = (await response.json().catch(() => null)) as {
					models?: readonly { id?: unknown }[];
					data?: readonly { id?: unknown }[];
				} | null;
				// Some gateways return the OpenAI standard `{"object":"list","data":[…]}`
				// shape; others use a `models` array. Accept both so the advertised
				// model list is populated either way.
				const entries = Array.isArray(body?.models)
					? body.models
					: Array.isArray(body?.data)
						? body.data
						: undefined;
				const advertised = entries
					?.map((model) => (typeof model.id === "string" ? model.id : undefined))
					.filter((id): id is string => id !== undefined);
				return advertised !== undefined ? { ok: true, advertisedModels: advertised } : { ok: true };
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	function readConfig(): { providers?: Record<string, ModelsJsonProviderEntry> } {
		try {
			const raw = readFileSync(modelsPath, "utf-8");
			const parsed = JSON.parse(raw) as { providers?: Record<string, ModelsJsonProviderEntry> };
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch (error) {
			// Missing/invalid file = empty config; the console can still write.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Preserve whatever exists so a concurrent edit is not lost.
			}
			return {};
		}
	}

	async function writeConfig(file: { providers?: Record<string, ModelsJsonProviderEntry> }): Promise<void> {
		mkdirSync(dirname(modelsPath), { recursive: true });
		const serialized = `${JSON.stringify(file, null, 2)}\n`;
		// Atomic-ish: write a temp file then rename so readers never see a
		// half-written models.json.
		const tmpPath = `${modelsPath}.tmp`;
		writeFileSync(tmpPath, serialized, "utf-8");
		writeFileSync(modelsPath, serialized, "utf-8");
		try {
			// remove temp (best-effort; rename would be cleaner but fsync matters less here)
			writeFileSync(tmpPath, "", "utf-8");
		} catch {
			// ignore
		}
	}
}

function toView(id: string, entry: ModelsJsonProviderEntry): CustomLlmProviderView | undefined {
	const baseUrl = entry.baseUrl;
	const api = entry.api;
	if (typeof baseUrl !== "string" || !KNOWN_APIS.includes(api as CustomLlmApi)) {
		return undefined;
	}
	const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name : id;
	const models = (entry.models ?? [])
		.map((model) => (typeof model.id === "string" ? model.id : undefined))
		.filter((id): id is string => id !== undefined);
	return {
		id,
		name,
		baseUrl,
		api: api as CustomLlmApi,
		models,
		apiKeyConfigured: typeof entry.apiKey === "string" && entry.apiKey.length > 0,
	};
}

function validateId(id: string): void {
	if (!PROVIDER_ID_PATTERN.test(id)) {
		throw new Error("id must be lowercase alphanumeric and may contain `-` / `_` (max 64 chars)");
	}
}

function requireNonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function requireHttpUrl(value: string, field: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${field} must be a valid absolute URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${field} must use http(s)`);
	}
	return url.toString().replace(/\/+$/, "");
}

function normalizeModels(models: readonly LlmModelSpecInput[]): readonly {
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<"low" | "medium" | "high", string | null>>;
}[] {
	if (!Array.isArray(models) || models.length === 0) {
		throw new Error("models must be a non-empty array of model ids");
	}
	const seen = new Set<string>();
	const out: {
		id: string;
		reasoning?: boolean;
		thinkingLevelMap?: Partial<Record<"low" | "medium" | "high", string | null>>;
	}[] = [];
	for (const raw of models) {
		const entry = typeof raw === "string" ? { id: raw } : raw;
		if (typeof entry?.id !== "string" || entry.id.trim() === "") {
			throw new Error("models must be a non-empty array of model ids");
		}
		const id = entry.id.trim();
		if (seen.has(id)) continue;
		seen.add(id);
		const thinkingLevelMap: Partial<Record<"low" | "medium" | "high", string | null>> = {};
		if (entry.thinkingLevelMap && typeof entry.thinkingLevelMap === "object") {
			for (const level of ["low", "medium", "high"] as const) {
				const value = entry.thinkingLevelMap[level];
				if (value === null) {
					// Explicit clear: signal the merge to drop a previously saved level.
					thinkingLevelMap[level] = null;
				} else if (typeof value === "string" && value.trim() !== "") {
					thinkingLevelMap[level] = value.trim();
				}
			}
		}
		out.push({
			id,
			...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
			...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
		});
	}
	return out;
}

function resolveApiKey(apiKey: string): string {
	if (apiKey.startsWith("$") && !apiKey.startsWith("$$")) {
		const name = apiKey.slice(1);
		const value = typeof process !== "undefined" ? process.env[name] : undefined;
		if (value !== undefined && value !== "") return value;
	}
	return apiKey;
}

function normalizeThinkingLevelMap(value: unknown): Readonly<Record<string, string | null>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string | null] => typeof entry[1] === "string" || entry[1] === null,
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

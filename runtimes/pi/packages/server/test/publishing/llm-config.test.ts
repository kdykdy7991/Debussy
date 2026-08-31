/**
 * Unit test for the Custom LLM config store (`llm-config.ts`).
 *
 * Purely file + runtime: writes to a temp models.json and reloads through a
 * fake model runtime, so it needs no Postgres / live agent.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLlmConfigStore,
	type LlmConfigStore,
	type LlmModelSpecInput,
} from "../../src/publishing/control/llm-config.ts";

interface TempWorld {
	agentDir: string;
	refreshCalls: number;
	store: LlmConfigStore;
	destroy: () => void;
}

function makeWorld(): TempWorld {
	const agentDir = mkdtempSync(join(tmpdir(), "llm-config-test-"));
	let refreshCalls = 0;
	const modelRuntime = {
		refresh: async () => {
			refreshCalls += 1;
		},
		getAvailableSnapshot: () => [],
		getModel: () => undefined,
	};
	const services = {
		agentDir,
		modelRuntime,
	} as unknown as AgentSessionServices;
	const store = createLlmConfigStore(services);
	return {
		agentDir,
		get refreshCalls() {
			return refreshCalls;
		},
		store,
		destroy: () => rmSync(agentDir, { recursive: true, force: true }),
	};
}

function readModelsJson(agentDir: string): { providers?: Record<string, unknown> } {
	const raw = readFileSync(join(agentDir, "models.json"), "utf-8");
	return JSON.parse(raw) as { providers?: Record<string, unknown> };
}

describe("createLlmConfigStore", () => {
	let world: TempWorld | undefined;

	afterEach(() => {
		world?.destroy();
		world = undefined;
	});

	it("lists nothing when models.json is absent", async () => {
		world = makeWorld();
		expect(await world.store.list()).toEqual([]);
	});

	it("lists an existing runtime provider that has no display name", async () => {
		world = makeWorld();
		writeFileSync(
			join(world.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					oneapi: {
						baseUrl: "http://127.0.0.1:3000/v1",
						api: "openai-completions",
						apiKey: "$ONEAPI_KEY",
						models: [{ id: "Qwen" }],
					},
				},
			}),
			"utf-8",
		);

		await expect(world.store.list()).resolves.toEqual([
			{
				id: "oneapi",
				name: "oneapi",
				baseUrl: "http://127.0.0.1:3000/v1",
				api: "openai-completions",
				models: [
					// Old config without contextWindow/maxTokens stays readable; the
					// fields are simply omitted (Pi falls back to its defaults).
					{ id: "Qwen" },
				],
				apiKeyConfigured: true,
			},
		]);
	});

	it("upserts a provider, writes to models.json, masks the key, and reloads", async () => {
		world = makeWorld();
		const provider = await world.store.upsert({
			id: "my-lm",
			name: "我的网关",
			baseUrl: "https://gateway.example.com/v1/",
			api: "openai-completions",
			models: [
				{ id: "qwen2.5-72b", contextWindow: 131072, maxTokens: 32768 },
				{ id: "llama-3.1-8b", contextWindow: 128000, maxTokens: 16384 },
			],
			apiKey: "$LLM_KEY",
		});
		expect(provider.id).toBe("my-lm");
		expect(provider.baseUrl).toBe("https://gateway.example.com/v1"); // trailing slash trimmed
		expect(provider.models).toEqual([
			{ id: "qwen2.5-72b", contextWindow: 131072, maxTokens: 32768 },
			{ id: "llama-3.1-8b", contextWindow: 128000, maxTokens: 16384 },
		]);
		expect(provider.apiKeyConfigured).toBe(true);
		expect(world.refreshCalls).toBe(1);

		const onDisk = readModelsJson(world.agentDir);
		const entry = onDisk.providers?.["my-lm"] as { apiKey?: string };
		expect(entry.apiKey).toBe("$LLM_KEY");
		expect(onDisk.providers?.["my-lm"] as { models?: unknown }).toMatchObject({
			models: [
				{ id: "qwen2.5-72b", contextWindow: 131072, maxTokens: 32768 },
				{ id: "llama-3.1-8b", contextWindow: 128000, maxTokens: 16384 },
			],
		});

		// Read back through the store: key never emitted.
		const listed = await world.store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.apiKeyConfigured).toBe(true);
		if (listed[0]) {
			expect("apiKey" in listed[0]).toBe(false);
		}
	});

	it("upsert persists explicit per-model reasoning and contextWindow/maxTokens and preserves when omitted", async () => {
		world = makeWorld();
		await world.store.upsert({
			id: "gate",
			name: "Gate",
			baseUrl: "https://g.example.com/v1",
			api: "openai-completions",
			models: [
				{ id: "m1", contextWindow: 100_000, maxTokens: 16_384, reasoning: true },
				{ id: "m2", contextWindow: 131_072, maxTokens: 32_768 },
			],
		});

		let onDisk = readModelsJson(world.agentDir);
		let models = onDisk.providers?.gate as {
			models?: readonly { id?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[];
		};
		expect(models.models).toEqual([
			{ id: "m1", contextWindow: 100_000, maxTokens: 16_384, reasoning: true },
			{ id: "m2", contextWindow: 131_072, maxTokens: 32_768 },
		]);

		// Re-save with m1 as a plain entry (only windows set): its saved reasoning:true must survive.
		await world.store.upsert({
			id: "gate",
			name: "Gate",
			baseUrl: "https://g.example.com/v1",
			api: "openai-completions",
			models: [
				{ id: "m1", contextWindow: 100_000, maxTokens: 16_384 },
				{ id: "m2", contextWindow: 131_072, maxTokens: 32_768 },
			],
		});
		onDisk = readModelsJson(world.agentDir);
		models = onDisk.providers?.gate as {
			models?: readonly { id?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[];
		};
		expect(models.models).toEqual([
			{ id: "m1", contextWindow: 100_000, maxTokens: 16_384, reasoning: true },
			{ id: "m2", contextWindow: 131_072, maxTokens: 32_768 },
		]);

		// Explicit false overrides the preserved true.
		await world.store.upsert({
			id: "gate",
			name: "Gate",
			baseUrl: "https://g.example.com/v1",
			api: "openai-completions",
			models: [
				{ id: "m1", contextWindow: 100_000, maxTokens: 16_384, reasoning: false },
				{ id: "m2", contextWindow: 131_072, maxTokens: 32_768 },
			],
		});
		onDisk = readModelsJson(world.agentDir);
		models = onDisk.providers?.gate as {
			models?: readonly { id?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[];
		};
		expect(models.models).toEqual([
			{ id: "m1", contextWindow: 100_000, maxTokens: 16_384, reasoning: false },
			{ id: "m2", contextWindow: 131_072, maxTokens: 32_768 },
		]);
	});

	it("upsert persists per-model thinkingLevelMap and merges it with existing", async () => {
		world = makeWorld();
		await world.store.upsert({
			id: "gate",
			name: "Gate",
			baseUrl: "https://g.example.com/v1",
			api: "openai-completions",
			models: [
				{
					id: "m1",
					contextWindow: 131_072,
					maxTokens: 32_768,
					reasoning: true,
					thinkingLevelMap: { low: "xlow", high: "xhigh" },
				},
			],
		});
		let onDisk = readModelsJson(world.agentDir).providers?.gate as {
			models?: readonly {
				id?: string;
				reasoning?: boolean;
				contextWindow?: number;
				maxTokens?: number;
				thinkingLevelMap?: Record<string, string>;
			}[];
		};
		expect(onDisk.models).toEqual([
			{
				id: "m1",
				contextWindow: 131_072,
				maxTokens: 32_768,
				reasoning: true,
				thinkingLevelMap: { low: "xlow", high: "xhigh" },
			},
		]);

		// Re-save touching only medium: existing low/high mapping must survive.
		await world.store.upsert({
			id: "gate",
			name: "Gate",
			baseUrl: "https://g.example.com/v1",
			api: "openai-completions",
			models: [
				{
					id: "m1",
					contextWindow: 131_072,
					maxTokens: 32_768,
					reasoning: true,
					thinkingLevelMap: { medium: "mid" },
				},
			],
		});
		onDisk = readModelsJson(world.agentDir).providers?.gate as {
			models?: readonly {
				id?: string;
				reasoning?: boolean;
				contextWindow?: number;
				maxTokens?: number;
				thinkingLevelMap?: Record<string, string>;
			}[];
		};
		expect(onDisk.models?.[0]?.thinkingLevelMap).toEqual({ low: "xlow", high: "xhigh", medium: "mid" });
		expect(onDisk.models?.[0]?.contextWindow).toBe(131_072);
		expect(onDisk.models?.[0]?.maxTokens).toBe(32_768);

		// Clearing a level (null) removes it so the runtime falls back to default.
		await world.store.upsert({
			id: "gate",
			name: "Gate",
			baseUrl: "https://g.example.com/v1",
			api: "openai-completions",
			models: [
				{
					id: "m1",
					contextWindow: 131_072,
					maxTokens: 32_768,
					reasoning: true,
					thinkingLevelMap: { low: "xlow", medium: null, high: "xhigh" },
				},
			],
		});
		onDisk = readModelsJson(world.agentDir).providers?.gate as {
			models?: readonly {
				id?: string;
				reasoning?: boolean;
				contextWindow?: number;
				maxTokens?: number;
				thinkingLevelMap?: Record<string, string>;
			}[];
		};
		expect(onDisk.models?.[0]?.thinkingLevelMap).toEqual({ low: "xlow", high: "xhigh" });
	});

	it("invalid input is rejected without writing or reloading", async () => {
		world = makeWorld();
		await expect(
			world.store.upsert({
				id: "Bad ID!",
				name: "x",
				baseUrl: "not-a-url",
				api: "openai-completions",
				models: [],
			}),
		).rejects.toThrow();
		expect(world.refreshCalls).toBe(0);
		// No file should be created for a rejected write.
		await expect(world.store.list()).resolves.toEqual([]);
	});

	it("rejects a custom model whose contextWindow is not a positive integer", async () => {
		world = makeWorld();
		await expect(
			world.store.upsert({
				id: "gw",
				name: "GW",
				baseUrl: "https://g.example.com/v1",
				api: "openai-completions",
				models: [{ id: "m", contextWindow: 0, maxTokens: 32_768 }],
			}),
		).rejects.toThrow(/model "m" contextWindow must be a positive integer/);
		expect(world.refreshCalls).toBe(0);
		await expect(world.store.list()).resolves.toEqual([]);
	});

	it("rejects a custom model whose maxTokens is not a positive integer", async () => {
		world = makeWorld();
		await expect(
			world.store.upsert({
				id: "gw",
				name: "GW",
				baseUrl: "https://g.example.com/v1",
				api: "openai-completions",
				models: [{ id: "m", contextWindow: 131_072, maxTokens: -1 }],
			}),
		).rejects.toThrow(/model "m" maxTokens must be a positive integer/);
	});

	it("rejects a custom model whose maxTokens exceeds contextWindow", async () => {
		world = makeWorld();
		await expect(
			world.store.upsert({
				id: "gw",
				name: "GW",
				baseUrl: "https://g.example.com/v1",
				api: "openai-completions",
				models: [{ id: "m", contextWindow: 32_768, maxTokens: 131_072 }],
			}),
		).rejects.toThrow(/maxTokens \(131072\) must not exceed contextWindow \(32768\)/);
		expect(world.refreshCalls).toBe(0);
	});

	it("rejects a new write that omits contextWindow or maxTokens", async () => {
		world = makeWorld();
		await expect(
			world.store.upsert({
				id: "gw",
				name: "GW",
				baseUrl: "https://g.example.com/v1",
				api: "openai-completions",
				// Simulate a stale caller that omits the now-required window fields.
				models: [{ id: "m", reasoning: true } as unknown as LlmModelSpecInput],
			}),
		).rejects.toThrow(/model "m" contextWindow must be a positive integer/);
		expect(world.refreshCalls).toBe(0);
	});

	it("removes a provider and reloads", async () => {
		world = makeWorld();
		await world.store.upsert({
			id: "a1",
			name: "A",
			baseUrl: "https://a.example.com/v1",
			api: "openai-responses",
			models: [{ id: "m1", contextWindow: 131_072, maxTokens: 32_768 }],
			apiKey: "$A_KEY",
		});
		const before = world.refreshCalls;

		const removed = await world.store.remove("a1");
		expect(removed).toBe(true);
		expect(world.refreshCalls).toBe(before + 1);
		expect(await world.store.list()).toEqual([]);

		const again = await world.store.remove("a1");
		expect(again).toBe(false);
	});

	it("preserves other provider entries on an unrelated upsert", async () => {
		world = makeWorld();
		await world.store.upsert({
			id: "p1",
			name: "P1",
			baseUrl: "https://p1.example.com/v1",
			api: "openai-completions",
			models: [{ id: "x", contextWindow: 131_072, maxTokens: 32_768 }],
			apiKey: "$P1_KEY",
		});
		await world.store.upsert({
			id: "p2",
			name: "P2",
			baseUrl: "https://p2.example.com/v1",
			api: "openai-completions",
			models: [{ id: "y", contextWindow: 131_072, maxTokens: 32_768 }],
		});
		const onDisk = readModelsJson(world.agentDir);
		expect(Object.keys(onDisk.providers ?? {})).toEqual(["p1", "p2"]);
		// p1's key survives the unrelated p2 write.
		expect((onDisk.providers!.p1 as { apiKey?: string }).apiKey).toBe("$P1_KEY");
	});

	it("preserves provider and model capability metadata when editing basic fields", async () => {
		world = makeWorld();
		writeFileSync(
			join(world.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					oneapi: {
						name: "Old",
						baseUrl: "https://old.example.com/v1",
						api: "openai-completions",
						compat: { supportsStore: false },
						models: [{ id: "Qwen", reasoning: true, thinkingLevelMap: { high: "xhigh" } }],
					},
				},
			}),
			"utf-8",
		);

		await world.store.upsert({
			id: "oneapi",
			name: "OneAPI",
			baseUrl: "https://new.example.com/v1",
			api: "openai-completions",
			models: [{ id: "Qwen", contextWindow: 131_072, maxTokens: 32_768 }],
		});

		const provider = readModelsJson(world.agentDir).providers?.oneapi as {
			compat?: unknown;
			models?: readonly { thinkingLevelMap?: unknown; contextWindow?: number; maxTokens?: number }[];
		};
		expect(provider.compat).toEqual({ supportsStore: false });
		expect(provider.models?.[0]?.thinkingLevelMap).toEqual({ high: "xhigh" });
		expect(provider.models?.[0]?.contextWindow).toBe(131_072);
		expect(provider.models?.[0]?.maxTokens).toBe(32_768);
	});

	it("test falls back to the persisted provider key when apiKey is omitted", async () => {
		world = makeWorld();
		writeFileSync(
			join(world.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					oneapi: {
						baseUrl: "http://127.0.0.1:3000/v1",
						api: "openai-completions",
						apiKey: "PERSISTED-KEY",
						models: [{ id: "Qwen" }],
					},
				},
			}),
			"utf-8",
		);

		const realFetch = globalThis.fetch;
		let requestedAuthorization: string | undefined;
		const stub: typeof fetch = (async (_url, init) => {
			requestedAuthorization = ((init as RequestInit)?.headers as Record<string, string> | undefined)?.Authorization;
			return { ok: true, json: async () => ({ models: [{ id: "Qwen" }] }) } as unknown as Response;
		}) as typeof fetch;
		(stub as unknown as { assign: unknown }).assign; // placeholder
		globalThis.fetch = stub;
		try {
			await world.store.test({
				providerId: "oneapi",
				baseUrl: "http://127.0.0.1:3000/v1",
				api: "openai-completions",
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(requestedAuthorization).toBe("Bearer PERSISTED-KEY");
	});

	it("test uses an explicitly provided apiKey over the persisted key", async () => {
		world = makeWorld();
		writeFileSync(
			join(world.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					oneapi: {
						baseUrl: "http://127.0.0.1:3000/v1",
						api: "openai-completions",
						apiKey: "PERSISTED-KEY",
						models: [{ id: "Qwen" }],
					},
				},
			}),
			"utf-8",
		);

		const realFetch = globalThis.fetch;
		let requestedAuthorization: string | undefined;
		const stub: typeof fetch = (async (_url, init) => {
			requestedAuthorization = ((init as RequestInit)?.headers as Record<string, string> | undefined)?.Authorization;
			return { ok: true, json: async () => ({ models: [{ id: "Qwen" }] }) } as unknown as Response;
		}) as typeof fetch;
		(stub as unknown as { assign: unknown }).assign; // placeholder
		globalThis.fetch = stub;
		try {
			await world.store.test({
				providerId: "oneapi",
				baseUrl: "http://127.0.0.1:3000/v1",
				api: "openai-completions",
				apiKey: "EXPLICIT-KEY",
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(requestedAuthorization).toBe("Bearer EXPLICIT-KEY");
	});

	it("test parses the OpenAI standard `data` shape when the gateway returns it", async () => {
		world = makeWorld();
		writeFileSync(
			join(world.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					oneapi: {
						baseUrl: "https://api.example.com",
						api: "openai-completions",
						models: [],
					},
				},
			}),
			"utf-8",
		);

		const realFetch = globalThis.fetch;
		const stub: typeof fetch = (async () => {
			return {
				ok: true,
				json: async () => ({
					object: "list",
					data: [
						{ id: "kimi-k3", object: "model" },
						{ id: "glm-5.2", object: "model" },
					],
				}),
			} as unknown as Response;
		}) as typeof fetch;
		(stub as unknown as { assign: unknown }).assign; // placeholder
		globalThis.fetch = stub;
		const result = await world.store.test({
			providerId: "oneapi",
			baseUrl: "https://api.example.com",
			api: "openai-completions",
		});
		globalThis.fetch = realFetch;

		expect(result.ok).toBe(true);
		expect(result.advertisedModels).toEqual(["kimi-k3", "glm-5.2"]);
	});
});

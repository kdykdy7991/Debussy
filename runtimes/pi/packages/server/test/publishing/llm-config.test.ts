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
import { createLlmConfigStore, type LlmConfigStore } from "../../src/publishing/control/llm-config.ts";

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
				models: ["Qwen"],
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
			models: ["qwen2.5-72b", "llama-3.1-8b"],
			apiKey: "$LLM_KEY",
		});
		expect(provider.id).toBe("my-lm");
		expect(provider.baseUrl).toBe("https://gateway.example.com/v1"); // trailing slash trimmed
		expect(provider.models).toEqual(["qwen2.5-72b", "llama-3.1-8b"]);
		expect(provider.apiKeyConfigured).toBe(true);
		expect(world.refreshCalls).toBe(1);

		const onDisk = readModelsJson(world.agentDir);
		const entry = onDisk.providers?.["my-lm"] as { apiKey?: string };
		expect(entry.apiKey).toBe("$LLM_KEY");

		// Read back through the store: key never emitted.
		const listed = await world.store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.apiKeyConfigured).toBe(true);
		if (listed[0]) {
			expect("apiKey" in listed[0]).toBe(false);
		}
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

	it("removes a provider and reloads", async () => {
		world = makeWorld();
		await world.store.upsert({
			id: "a1",
			name: "A",
			baseUrl: "https://a.example.com/v1",
			api: "openai-responses",
			models: ["m1"],
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
			models: ["x"],
			apiKey: "$P1_KEY",
		});
		await world.store.upsert({
			id: "p2",
			name: "P2",
			baseUrl: "https://p2.example.com/v1",
			api: "openai-completions",
			models: ["y"],
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
			models: ["Qwen"],
		});

		const provider = readModelsJson(world.agentDir).providers?.oneapi as {
			compat?: unknown;
			models?: readonly { thinkingLevelMap?: unknown }[];
		};
		expect(provider.compat).toEqual({ supportsStore: false });
		expect(provider.models?.[0]?.thinkingLevelMap).toEqual({ high: "xhigh" });
	});
});

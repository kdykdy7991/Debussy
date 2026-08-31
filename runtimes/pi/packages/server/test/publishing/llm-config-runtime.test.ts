/**
 * Round-trip test: relative to the *real* `ModelRuntime` (what Debug and
 * Published runtimes share) storing `contextWindow` / `maxTokens` for a custom
 * model through `LlmConfigStore` must surface as `Model.contextWindow` /
 * `Model.maxTokens` on `modelRuntime.getModel(...)`, hot-reloaded without a
 * server restart.
 *
 * Offline: allows no network model refresh; only the local models.json +
 * bundled catalog are composed, so no provider credentials are needed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmConfigStore, type LlmModelSpecInput } from "../../src/publishing/control/llm-config.ts";

interface RuntimeWorld {
	agentDir: string;
	modelRuntime: ModelRuntime;
	destroy: () => Promise<void>;
}

async function makeWorld(): Promise<RuntimeWorld> {
	const agentDir = mkdtempSync(join(tmpdir(), "llm-config-runtime-test-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	return {
		agentDir,
		modelRuntime,
		destroy: async () => {
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function storeFor(world: RuntimeWorld) {
	const services = { agentDir: world.agentDir, modelRuntime: world.modelRuntime } as unknown as AgentSessionServices;
	return createLlmConfigStore(services);
}

describe("custom model contextWindow/maxTokens reach the Pi ModelRuntime (hot reload)", () => {
	let world: RuntimeWorld | undefined;

	afterEach(async () => {
		await world?.destroy();
		world = undefined;
	});

	it("persists contextWindow/maxTokens and reloads getModel to the exact values", async () => {
		world = await makeWorld();
		const store = storeFor(world);

		await store.upsert({
			id: "gw",
			name: "GateWay",
			baseUrl: "https://gateway.example.com/v1",
			api: "openai-completions",
			models: [{ id: "Qwen3", contextWindow: 131_072, maxTokens: 32_768 }],
		});

		const model = world.modelRuntime.getModel("gw", "Qwen3");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(131_072);
		expect(model?.maxTokens).toBe(32_768);

		// Read back through the store too (round-trip of the read side).
		const listed = await store.list();
		expect(listed[0]?.models).toEqual([{ id: "Qwen3", contextWindow: 131_072, maxTokens: 32_768 }]);
	});

	it("updating contextWindow/maxTokens is reflected on a fresh getModel without a new runtime", async () => {
		world = await makeWorld();
		const store = storeFor(world);

		await store.upsert({
			id: "gw",
			name: "GateWay",
			baseUrl: "https://gateway.example.com/v1",
			api: "openai-completions",
			models: [{ id: "Qwen3", contextWindow: 131_072, maxTokens: 32_768 }],
		});
		expect(world.modelRuntime.getModel("gw", "Qwen3")?.contextWindow).toBe(131_072);

		await store.upsert({
			id: "gw",
			name: "GateWay",
			baseUrl: "https://gateway.example.com/v1",
			api: "openai-completions",
			models: [{ id: "Qwen3", contextWindow: 262_144, maxTokens: 65_536 }],
		});
		// Same ModelRuntime instance, hot-reloaded by the store's refresh().
		expect(world.modelRuntime.getModel("gw", "Qwen3")?.contextWindow).toBe(262_144);
		expect(world.modelRuntime.getModel("gw", "Qwen3")?.maxTokens).toBe(65_536);
	});

	it("an old models.json without contextWindow/maxTokens loads with Pi's fallback defaults", async () => {
		world = await makeWorld();
		writeFileSync(
			join(world.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					legacy: {
						baseUrl: "https://legacy.example.com/v1",
						api: "openai-completions",
						models: [{ id: "OldModel" }],
					},
				},
			}),
			"utf-8",
		);
		await world.modelRuntime.refresh({ allowNetwork: false });

		const model = world.modelRuntime.getModel("legacy", "OldModel");
		expect(model).toBeDefined();
		// Pi's fallback in modelFromJson when the stored config predates the field.
		expect(model?.contextWindow).toBe(128_000);
		expect(model?.maxTokens).toBe(16_384);

		// Re-saving that legacy model through the Debussy store requires the fields
		// to be supplied (historically-readable, strictly-writable).
		const store = storeFor(world);
		await expect(
			store.upsert({
				id: "legacy",
				name: "Legacy",
				baseUrl: "https://legacy.example.com/v1",
				api: "openai-completions",
				models: [{ id: "OldModel" } as unknown as LlmModelSpecInput],
			}),
		).rejects.toThrow(/model "OldModel" contextWindow must be a positive integer/);
	});
});

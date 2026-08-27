import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { buildCapabilityCatalog } from "../../src/publishing/control/catalog.ts";
import { createServerAgentSource } from "../../src/publishing/control/source.ts";

function servicesWithSkills(skillNames: readonly string[]): AgentSessionServices {
	return {
		resourceLoader: {
			getExtensions: () => ({ extensions: [] }),
			getSkills: () => ({ skills: skillNames.map((name) => ({ name })) }),
			getSystemPrompt: () => "System prompt",
			getPrompts: () => ({ prompts: [] }),
		},
		settingsManager: {
			getDefaultProvider: () => "test-provider",
			getDefaultModel: () => "test-model",
		},
		modelRuntime: {
			getModel: () => ({ input: ["text"] }),
			getAvailableSnapshot: () => [],
		},
	} as unknown as AgentSessionServices;
}

describe("current agent publishing source", () => {
	test("does not expose local Skills as knowledge bases", async () => {
		const services = servicesWithSkills(Array.from({ length: 24 }, (_, index) => `skill-${index + 1}`));
		const catalog = buildCapabilityCatalog(services);
		const source = createServerAgentSource({ services, catalog });

		const collected = await source.collect();

		expect(catalog.knowledgeBases).toEqual([]);
		expect(collected.config.knowledgeBases).toEqual([]);
		expect(collected.warnings).toEqual([]);
	});
});

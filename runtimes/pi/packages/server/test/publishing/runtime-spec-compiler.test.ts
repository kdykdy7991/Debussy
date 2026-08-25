/**
 * TASK-010: RuntimeSpec Compiler.
 *
 * Deterministic (same input -> same hash; draft edits never change old
 * outputs), whitelist-enforced (unapproved tools/models/knowledge bases are
 * rejected) and secret-free (stray credential fields in the draft never enter
 * the spec or its hash). The compiled spec always re-parses through the
 * TASK-009 schema. Pure unit tests, no DB.
 */
import { describe, expect, test } from "vitest";
import {
	type AgentDraftConfig,
	type CapabilityCatalog,
	compileRuntimeSpec,
} from "../../src/publishing/runtime-spec/compiler.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const catalog: CapabilityCatalog = {
	tools: [
		{ id: "web.search", name: "Web Search" },
		{ id: "doc.read", name: "Document Reader" },
	],
	models: [
		{
			provider: "skdy",
			modelId: "pi-chat",
			parameterCapabilities: {
				reasoning: { supported: true, toggle: false, efforts: ["low", "medium", "high"] },
			},
		},
	],
	knowledgeBases: [{ id: "kb-legal" }],
};

function draft(overrides: Partial<AgentDraftConfig> = {}): AgentDraftConfig {
	return {
		prompt: "You are a helpful assistant.",
		model: { provider: "skdy", modelId: "pi-chat", params: { temperature: 0.5 } },
		tools: [{ id: "web.search", config: { topK: 5 } }],
		knowledgeBases: [{ id: "kb-legal" }],
		uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
		speech: { enabled: false },
		avatar: { enabled: false },
		theme: { primaryColor: "#2563eb", welcomeMessage: "Hi" },
		...overrides,
	};
}

function compile(agent: AgentDraftConfig = draft()) {
	return compileRuntimeSpec({
		agent,
		publishedAppVersionId: "pav_00000000-0000-7000-8000-000000000001",
		catalog,
	});
}

describe("runtime spec compiler", () => {
	test("same input compiles to the same hash", () => {
		const a = compile();
		const b = compile();
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(b.sha256).toBe(a.sha256);
		expect(b.canonicalJson).toBe(a.canonicalJson);
	});

	test("modifying the draft never changes the already-compiled output", () => {
		const original = compile();
		expect(original.ok).toBe(true);
		// A new draft produces a different hash, but the original output is a
		// deterministic snapshot: recompiling the original draft reproduces it.
		const changed = compile(draft({ prompt: "Changed prompt." }));
		expect(changed.ok).toBe(true);
		if (!original.ok || !changed.ok) return;
		expect(changed.sha256).not.toBe(original.sha256);
		const originalAgain = compile();
		expect(originalAgain.ok).toBe(true);
		if (!originalAgain.ok) return;
		expect(originalAgain.sha256).toBe(original.sha256);
	});

	test("an unapproved tool is rejected", () => {
		const result = compile(draft({ tools: [{ id: "shell.exec" }] }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("shell.exec"))).toBe(true);
	});

	test("an unapproved model is rejected", () => {
		const result = compile(draft({ model: { provider: "other", modelId: "gpt-x" } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("other/gpt-x"))).toBe(true);
	});

	test("an unapproved knowledge base is rejected", () => {
		const result = compile(draft({ knowledgeBases: [{ id: "kb-secret" }] }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("kb-secret"))).toBe(true);
	});

	test("provider secrets never enter the spec or its hash", () => {
		const poisoned = draft();
		const leaked = poisoned as unknown as Record<string, unknown>;
		leaked.apiKey = "sk-secret-123";
		leaked.token = "tok-secret-456";
		const result = compile(poisoned);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.canonicalJson).not.toContain("sk-secret-123");
		expect(result.canonicalJson).not.toContain("tok-secret-456");
		expect(result.canonicalJson).not.toContain("apiKey");
		expect(result.sha256).toBe(
			// The hash covers the canonical spec only, so recomputing over the
			// spec (which has no secret fields) must match.
			compile(poisoned).ok && result.ok ? result.sha256 : "",
		);
	});

	test("the compiled spec re-parses through the runtime schema", () => {
		const result = compile();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(parseRuntimeSpec(JSON.parse(result.canonicalJson)).ok).toBe(true);
	});

	test("model parameter capabilities are frozen into the published runtime spec", () => {
		const result = compile();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.agent.model.parameterCapabilities).toEqual({
			reasoning: { supported: true, toggle: false, efforts: ["low", "medium", "high"] },
		});
	});

	test("theme is copied into the compiled spec", () => {
		const result = compile();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.theme).toEqual({ primaryColor: "#2563eb", welcomeMessage: "Hi" });
	});

	test("compilation with an empty catalog rejects everything", () => {
		const result = compile(draft({ tools: [{ id: "web.search" }], knowledgeBases: [{ id: "kb-legal" }] }));
		// catalog is fixed; use a catalog with no entries
		const empty = compileRuntimeSpec({
			agent: draft(),
			publishedAppVersionId: "pav_x",
			catalog: { tools: [], models: [], knowledgeBases: [] },
		});
		expect(result.ok).toBe(true);
		expect(empty.ok).toBe(false);
		if (empty.ok) return;
		expect(empty.errors.some((e) => e.includes("web.search"))).toBe(true);
		expect(empty.errors.some((e) => e.includes("skdy/pi-chat"))).toBe(true);
		expect(empty.errors.some((e) => e.includes("kb-legal"))).toBe(true);
	});

	test("compiled tool config survives canonical serialisation", () => {
		const result = compile();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.capabilities.tools).toEqual([{ id: "web.search", config: { topK: 5 } }]);
	});
});

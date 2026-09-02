/**
 * TASK-009: RuntimeSpec schema (spec 5.4 + 5.5).
 *
 * A valid chat-only / chat-with-files spec parses and normalises; unknown
 * schemaVersion, out-of-limit quotas, unknown capability keys, malformed
 * model structures, unknown fields and unsupported security policy versions
 * are all rejected with path-qualified errors. Pure unit tests, no DB.
 */
import { describe, expect, test } from "vitest";
import { PLATFORM_LIMITS, parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		publishedAppVersionId: "pav_00000000-0000-7000-8000-000000000001",
		agent: {
			systemPrompt: "You are a helpful assistant.",
			model: { provider: "skdy", modelId: "pi-chat", params: { temperature: 0.5 } },
		},
		capabilities: {
			tools: [],
			knowledgeBases: [],
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
			speech: { enabled: false },
			avatar: { enabled: false },
		},
		contextPolicy: { maxTurns: 100, maxContextTokens: 100000, toolResultMaxBytes: 65536 },
		runtimePolicy: {
			profile: "chat-with-files",
			turnTimeoutMs: 120000,
			idleTtlMs: 1200000,
			maxConcurrentTurnsPerConversation: 1,
		},
		securityPolicyVersion: "sp_001",
		...overrides,
	};
}

describe("runtime spec schema", () => {
	test("accepts a complete chat-with-files spec", () => {
		const result = parseRuntimeSpec(validInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.schemaVersion).toBe(1);
		expect(result.spec.runtimePolicy.profile).toBe("chat-with-files");
		expect(result.spec.capabilities.uploads.maxFiles).toBe(10);
	});

	test("accepts a minimal chat-only spec and normalises defaults", () => {
		const result = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: "pav_x",
			agent: { systemPrompt: "hi", model: { provider: "skdy", modelId: "pi-chat" } },
			capabilities: {},
			contextPolicy: {},
			runtimePolicy: {},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.runtimePolicy.profile).toBe("chat-only");
		expect(result.spec.runtimePolicy.turnTimeoutMs).toBe(120000);
		expect(result.spec.capabilities.uploads).toEqual({ enabled: true, maxFiles: 10, maxFileBytes: 26214400 });
		expect(result.spec.capabilities.speech).toEqual({ enabled: false }); // default for omitted object
		expect(result.spec.capabilities.realtimeVoice).toEqual({ enabled: false });
		expect(result.spec.securityPolicyVersion).toBe("sp_001");
	});

	test("freezes the experimental realtime voice capability independently from speech", () => {
		const input = validInput();
		const capabilities = input.capabilities as Record<string, unknown>;
		const result = parseRuntimeSpec({
			...input,
			capabilities: { ...capabilities, speech: { enabled: false }, realtimeVoice: { enabled: true } },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.capabilities.speech.enabled).toBe(false);
		expect(result.spec.capabilities.realtimeVoice.enabled).toBe(true);
	});

	test("rejects an unknown schemaVersion", () => {
		const result = parseRuntimeSpec(validInput({ schemaVersion: 2 }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
	});

	test("rejects an out-of-limit turn timeout", () => {
		const result = parseRuntimeSpec(
			validInput({
				runtimePolicy: { ...(validInput().runtimePolicy as Record<string, unknown>), turnTimeoutMs: 120001 },
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("runtimePolicy.turnTimeoutMs"))).toBe(true);
	});

	test("rejects an out-of-limit upload quota", () => {
		const result = parseRuntimeSpec(
			validInput({
				capabilities: {
					...(validInput().capabilities as Record<string, unknown>),
					uploads: { enabled: true, maxFiles: 11, maxFileBytes: 26214400 },
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("capabilities.uploads.maxFiles"))).toBe(true);
	});

	test("rejects an unknown capability key (over-privileged capability)", () => {
		const result = parseRuntimeSpec(
			validInput({
				capabilities: { ...(validInput().capabilities as Record<string, unknown>), shell: { enabled: true } },
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("capabilities") && e.includes("shell"))).toBe(true);
	});

	test("rejects a malformed model structure", () => {
		const result = parseRuntimeSpec(
			validInput({ agent: { ...(validInput().agent as Record<string, unknown>), model: { provider: "skdy" } } }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("agent.model.modelId"))).toBe(true);
	});

	test("rejects unknown top-level fields", () => {
		const result = parseRuntimeSpec(validInput({ extra: "nope" }));
		expect(result.ok).toBe(false);
	});

	test("rejects an over-long system prompt", () => {
		const result = parseRuntimeSpec(
			validInput({
				agent: {
					...(validInput().agent as Record<string, unknown>),
					systemPrompt: "x".repeat(PLATFORM_LIMITS.maxSystemPromptChars + 1),
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.some((e) => e.includes("agent.systemPrompt"))).toBe(true);
	});

	test("rejects more than one concurrent turn per conversation (PD-13)", () => {
		const result = parseRuntimeSpec(
			validInput({
				runtimePolicy: {
					...(validInput().runtimePolicy as Record<string, unknown>),
					maxConcurrentTurnsPerConversation: 2,
				},
			}),
		);
		expect(result.ok).toBe(false);
	});

	test("rejects an unsupported security policy version", () => {
		const result = parseRuntimeSpec(validInput({ securityPolicyVersion: "sp_002" }));
		expect(result.ok).toBe(false);
	});

	test("rejects a non-object input", () => {
		expect(parseRuntimeSpec("nope").ok).toBe(false);
		expect(parseRuntimeSpec(null).ok).toBe(false);
	});
});

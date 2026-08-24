/**
 * RuntimeSpec schema (spec section 5.4 + 5.5 platform hard limits, TASK-009).
 *
 * `parseRuntimeSpec` validates an untrusted draft/compiled RuntimeSpec and
 * normalises it: optional fields are filled with platform defaults, unknown
 * schemaVersion / unknown fields / out-of-limit quotas / unknown capability
 * keys are rejected (never silently clamped or dropped) so a failed parse is
 * auditable. The parsed output is the canonical shape the Compiler emits and
 * the runtime Decoder reads (TASK-010 forbids shapes the decoder cannot
 * re-read).
 */
import { z } from "zod";

/**
 * Platform hard limits (spec 5.5). Values anchored to the 5.4 example shape
 * and PD-08/PD-09/PD-13/PD-14; the Schema rejects out-of-limit values instead
 * of clamping them.
 */
export const PLATFORM_LIMITS = {
	schemaVersion: 1,
	maxSystemPromptChars: 65_536,
	maxFiles: 10,
	maxFileBytes: 26_214_400, // 25 MiB, PD-09
	maxTools: 32,
	maxKnowledgeBases: 8,
	maxTurns: 100,
	maxContextTokens: 100_000,
	maxToolResultBytes: 65_536,
	maxTurnTimeoutMs: 120_000,
	maxIdleTtlMs: 1_200_000, // 20 minutes, PD-14
	maxConcurrentTurnsPerConversation: 1, // PD-13
	supportedSecurityPolicyVersions: ["sp_001"] as const,
} as const;

/** Platform defaults used to normalise omitted optional fields. */
export const PLATFORM_DEFAULTS = {
	uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26_214_400 },
	speech: { enabled: false },
	avatar: { enabled: false },
	profile: "chat-only",
	turnTimeoutMs: 120_000,
	idleTtlMs: 1_200_000,
	maxConcurrentTurnsPerConversation: 1,
	maxTurns: 100,
	maxContextTokens: 100_000,
	toolResultMaxBytes: 65_536,
	securityPolicyVersion: "sp_001",
	logLevel: "standard",
} as const;

const booleanCapability = z
	.object({
		enabled: z.boolean().default(true),
	})
	.strict();

const uploadsCapability = z
	.object({
		enabled: z.boolean().default(true),
		maxFiles: z.number().int().min(1).max(PLATFORM_LIMITS.maxFiles).default(PLATFORM_DEFAULTS.uploads.maxFiles),
		maxFileBytes: z
			.number()
			.int()
			.min(1)
			.max(PLATFORM_LIMITS.maxFileBytes)
			.default(PLATFORM_DEFAULTS.uploads.maxFileBytes),
	})
	.strict();

const modelSpec = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		params: z.record(z.string(), z.unknown()).optional(),
		parameterCapabilities: z
			.object({
				reasoning: z
					.object({
						supported: z.boolean(),
						toggle: z.boolean(),
						efforts: z.array(z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])),
						defaultEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
					})
					.strict(),
			})
			.strict()
			.optional(),
	})
	.strict();

const agentSpec = z
	.object({
		systemPrompt: z.string().max(PLATFORM_LIMITS.maxSystemPromptChars),
		model: modelSpec,
	})
	.strict();

/**
 * tools/knowledgeBases elements are references whose concrete shape is frozen
 * by the Compiler's capability catalog (TASK-010), not by the Schema; here we
 * only enforce the platform size limits and object-ness.
 */
const referenceArray = (max: number) => z.array(z.record(z.string(), z.unknown())).max(max);

const capabilitiesSpec = z
	.object({
		tools: referenceArray(PLATFORM_LIMITS.maxTools).default([]),
		knowledgeBases: referenceArray(PLATFORM_LIMITS.maxKnowledgeBases).default([]),
		uploads: uploadsCapability.default(PLATFORM_DEFAULTS.uploads),
		speech: booleanCapability.default(PLATFORM_DEFAULTS.speech),
		avatar: booleanCapability.default(PLATFORM_DEFAULTS.avatar),
	})
	.strict();

const contextPolicySpec = z
	.object({
		maxTurns: z.number().int().min(1).max(PLATFORM_LIMITS.maxTurns).default(PLATFORM_DEFAULTS.maxTurns),
		maxContextTokens: z
			.number()
			.int()
			.min(1)
			.max(PLATFORM_LIMITS.maxContextTokens)
			.default(PLATFORM_DEFAULTS.maxContextTokens),
		toolResultMaxBytes: z
			.number()
			.int()
			.min(1)
			.max(PLATFORM_LIMITS.maxToolResultBytes)
			.default(PLATFORM_DEFAULTS.toolResultMaxBytes),
		/**
		 * WB-007: streaming chunk retention level for the conversation event
		 * log. Defaults to `standard` so published apps do not silently start
		 * persisting every chunk; admin debugging apps can opt into `full`.
		 */
		logLevel: z.enum(["standard", "diagnostic", "full"]).default(PLATFORM_DEFAULTS.logLevel),
	})
	.strict();

const runtimePolicySpec = z
	.object({
		profile: z.enum(["chat-only", "chat-with-files"]).default(PLATFORM_DEFAULTS.profile),
		turnTimeoutMs: z
			.number()
			.int()
			.min(1)
			.max(PLATFORM_LIMITS.maxTurnTimeoutMs)
			.default(PLATFORM_DEFAULTS.turnTimeoutMs),
		idleTtlMs: z.number().int().min(1).max(PLATFORM_LIMITS.maxIdleTtlMs).default(PLATFORM_DEFAULTS.idleTtlMs),
		maxConcurrentTurnsPerConversation: z
			.literal(PLATFORM_LIMITS.maxConcurrentTurnsPerConversation)
			.default(PLATFORM_DEFAULTS.maxConcurrentTurnsPerConversation),
	})
	.strict();

/**
 * Display configuration copied from the published app (spec 27.1 create-app
 * contract; carried into the immutable RuntimeSpec by the Compiler). Never
 * carries credentials.
 */
const themeSpec = z
	.object({
		primaryColor: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		welcomeMessage: z.string().optional(),
	})
	.strict();

const runtimeSpecSchema = z
	.object({
		schemaVersion: z.literal(PLATFORM_LIMITS.schemaVersion),
		publishedAppVersionId: z.string().min(1),
		agent: agentSpec,
		capabilities: capabilitiesSpec,
		contextPolicy: contextPolicySpec.default({}),
		runtimePolicy: runtimePolicySpec.default({}),
		theme: themeSpec.default({}),
		securityPolicyVersion: z
			.enum(PLATFORM_LIMITS.supportedSecurityPolicyVersions)
			.default(PLATFORM_DEFAULTS.securityPolicyVersion),
	})
	.strict();

/** The canonical, normalised RuntimeSpec shape. */
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>;

export type RuntimeSpecParseResult =
	| { readonly ok: true; readonly spec: RuntimeSpec }
	| { readonly ok: false; readonly errors: readonly string[] };

/** Validate and normalise an untrusted RuntimeSpec value. */
export function parseRuntimeSpec(input: unknown): RuntimeSpecParseResult {
	const result = runtimeSpecSchema.safeParse(input);
	if (result.success) return { ok: true, spec: result.data };
	return {
		ok: false,
		errors: result.error.issues.map((issue) =>
			issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
		),
	};
}

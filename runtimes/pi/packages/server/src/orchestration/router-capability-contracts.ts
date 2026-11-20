import { z } from "zod";
import { ROUTER_TIME_BUDGETS } from "./router-contracts.ts";

/** Three-state scope persisted on aaas_api_keys.router_capability_scope. */
export const ROUTER_CAPABILITY_SCOPES = ["legacy", "dual", "router"] as const;
export type RouterCapabilityScope = (typeof ROUTER_CAPABILITY_SCOPES)[number];

const serverId = z.string().regex(/^mcp_[0-9a-f-]{36}$/);
/** Admin paths and rule bodies may use either the public `mcp_<uuid>` or bare UUID form. */
const ruleServerId = z.union([serverId, z.string().uuid().transform((value) => `mcp_${value}`)]);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const credentialId = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100);

/** Only parameters the platform can compile into an execution spec are accepted. */
export const ROUTER_SUPPORTED_MODEL_PARAMETERS = [
	"temperature",
	"maxTokens",
	"max_tokens",
	"topP",
	"top_p",
	"presencePenalty",
	"frequencyPenalty",
] as const;

const modelParametersSchema = z.record(
	z.enum(ROUTER_SUPPORTED_MODEL_PARAMETERS),
	z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
const localToolsSchema = z.array(z.literal("bash")).max(1);

/** A directly registered MCP Server: exact revision and exact tool allowlist. */
export const directCapabilityServerSchema = z
	.object({
		server_id: serverId,
		revision: z.number().int().min(1),
		authentication: z.enum(["none", "bearer", "api_key"]),
		tool_allowlist: z.array(z.string().min(1).max(128)).min(1).max(128),
	})
	.strict();

export const directCapabilitySkillSchema = z
	.object({
		skill_id: z.string().min(1).max(200),
		revision: z.number().int().min(1),
		artifact_hash: sha256,
	})
	.strict();

export const routerExecutionPolicySchema = z
	.object({
		max_pending_operations: z.number().int().min(1).max(4),
		queue_timeout_ms: z.number().int().min(1).max(ROUTER_TIME_BUDGETS.queueMs),
		credential_max_ms: z.number().int().min(1).max(ROUTER_TIME_BUDGETS.credentialMaxMs),
	})
	.strict();

/** Stored verbatim in aaas_api_keys.direct_capabilities; no credentials are allowed here. */
export const directCapabilitiesSchema = z
	.object({
		model: z
			.object({
				provider: z.string().min(1).max(100),
				model_id: z.string().min(1).max(200),
				parameters: modelParametersSchema.default({}),
			})
			.strict(),
		mcp_servers: z.array(directCapabilityServerSchema).max(8),
		local_tools: localToolsSchema.optional(),
		skills: z.array(directCapabilitySkillSchema).max(32),
		execution_policy: routerExecutionPolicySchema,
	})
	.strict();
export type DirectCapabilities = z.infer<typeof directCapabilitiesSchema>;
export type DirectCapabilityServer = z.infer<typeof directCapabilityServerSchema>;

/** One platform-owned sensitive parameter mapping, frozen with the MCP Revision. */
export const sensitiveBindingSchema = z
	.object({
		mcpServerId: ruleServerId,
		toolName: z.string().min(1).max(128),
		parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200),
		credentialId,
	})
	.strict();
export type SensitiveBinding = z.infer<typeof sensitiveBindingSchema>;

/**
 * Admin input. A batch rule is expanded to one SensitiveBinding per named tool
 * when the Revision is frozen; `toolNames: []` means an explicitly empty rule.
 */
export const sensitiveRuleBatchSchema = z
	.object({
		mcpServerId: ruleServerId,
		toolNames: z.array(z.string().min(1).max(128)).max(128),
		parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200),
		credentialId,
	})
	.strict();
export type SensitiveRuleBatch = z.infer<typeof sensitiveRuleBatchSchema>;

/** NULL = never registered; [] = reviewed empty; non-empty = expanded rules. */
export const sensitiveBindingsSchema = z.array(sensitiveBindingSchema);
export type SensitiveBindings = readonly SensitiveBinding[] | null | undefined;

export interface RouterEffectiveServer {
	readonly serverId: string;
	readonly revision: number;
	readonly authentication: "none" | "bearer" | "api_key";
	readonly tools: readonly {
		readonly name: string;
		readonly description: string | null;
		readonly inputSchema: Record<string, unknown>;
		readonly inputSchemaHash: string;
		readonly sensitiveBindings: readonly SensitiveBinding[];
	}[];
	readonly sensitiveBindings: readonly SensitiveBinding[];
}

export interface RouterEffectiveCapabilities {
	readonly source: "router" | "legacy";
	readonly capabilityRevision: number;
	readonly configurationId: string | null;
	readonly orchestrationVersionId: string | null;
	readonly model: { readonly provider: string; readonly modelId: string; readonly parameters: Record<string, unknown> };
	readonly executionPolicy: z.infer<typeof routerExecutionPolicySchema>;
	readonly servers: readonly RouterEffectiveServer[];
	readonly localTools?: readonly "bash"[];
	readonly skills: readonly (z.infer<typeof directCapabilitySkillSchema> & { readonly sourceHash: string })[];
}

/** Frozen per-Operation snapshot. Version 2 is distinct from the legacy Run snapshot. */
export interface RouterCapabilitySnapshot {
	readonly version: 2;
	readonly keyId: string;
	readonly capabilityRevision: number;
	readonly source: "router" | "legacy";
	readonly model: RouterEffectiveCapabilities["model"];
	readonly executionPolicy: RouterEffectiveCapabilities["executionPolicy"];
	readonly configurationId: string | null;
	readonly orchestrationVersionId: string | null;
	readonly localTools?: readonly "bash"[];
	readonly servers: readonly {
		readonly serverId: string;
		readonly revision: number;
		readonly authentication: "none" | "bearer" | "api_key";
		readonly toolAllowlist: readonly string[];
		readonly sensitiveBindings: readonly SensitiveBinding[];
		readonly tools: readonly {
			readonly name: string;
			readonly description: string | null;
			readonly inputSchema: Record<string, unknown>;
			readonly inputSchemaHash: string;
			readonly sensitiveBindings: readonly SensitiveBinding[];
		}[];
	}[];
	readonly skills: readonly (z.infer<typeof directCapabilitySkillSchema> & { readonly sourceHash: string })[];
}

const snapshotSensitiveBindings = z.array(sensitiveBindingSchema);
const snapshotSkill = directCapabilitySkillSchema.extend({ sourceHash: sha256 }).strict();
const snapshotTool = z
	.object({
		name: z.string().min(1).max(128),
		description: z.string().nullable(),
		inputSchema: z.record(z.string(), z.unknown()),
		inputSchemaHash: sha256,
		sensitiveBindings: snapshotSensitiveBindings,
	})
	.strict();

export const routerCapabilitySnapshotSchema = z
	.object({
		version: z.literal(2),
		keyId: z.string().uuid(),
		capabilityRevision: z.number().int().min(1),
		source: z.enum(["router", "legacy"]),
		model: z
			.object({
				provider: z.string().min(1),
				modelId: z.string().min(1),
				parameters: z.record(z.string(), z.unknown()),
			})
			.strict(),
		executionPolicy: routerExecutionPolicySchema,
		configurationId: z.string().nullable(),
		orchestrationVersionId: z.string().nullable(),
		localTools: localToolsSchema.optional(),
		servers: z.array(
			z
				.object({
					serverId: serverId,
					revision: z.number().int().min(1),
					authentication: z.enum(["none", "bearer", "api_key"]),
					toolAllowlist: z.array(z.string().min(1).max(128)),
					sensitiveBindings: snapshotSensitiveBindings,
					tools: z.array(snapshotTool),
				})
				.strict(),
		),
		skills: z.array(snapshotSkill),
	})
	.strict();

export function parseRouterCapabilitySnapshot(value: unknown): RouterCapabilitySnapshot | undefined {
	const parsed = routerCapabilitySnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

import { z } from "zod";

/** Distinct from the legacy `oi_` Integration Token prefix; used for mutually exclusive dispatch. */
export const API_KEY_PREFIX = "ak_";
export const API_KEY_TOKEN_PATTERN = /^Bearer ak_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

const credentialIdSchema = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.min(1)
	.max(100);
const serverIdSchema = z.string().regex(/^mcp_[0-9a-f-]{36}$/);
const secretSchema = z.string().min(4).max(4096);

/** Connection credentials are keyed by Server ID; tool parameter credentials by Server + Tool + registered ID. */
const legacyCredentialsSchema = z
	.object({
		servers: z
			.record(
				serverIdSchema,
				z
					.object({
						connection: z.object({ credential_id: credentialIdSchema, value: secretSchema }).strict(),
					})
					.strict(),
			)
			.default({}),
		tools: z
			.record(serverIdSchema, z.record(z.string().min(1).max(200), z.record(credentialIdSchema, secretSchema)))
			.default({}),
	})
	.strict()
	.default({ servers: {}, tools: {} });
const sharedCredentialsSchema = z.object({
	servers: z.record(serverIdSchema, z.object({
		connection_credential: secretSchema.optional(),
		tool_credential: secretSchema.optional(),
	}).strict().refine((value) => value.connection_credential !== undefined || value.tool_credential !== undefined)),
}).strict().refine((value) => Object.keys(value.servers).length > 0);
export const apiKeyCredentialsSchema = z.union([legacyCredentialsSchema, sharedCredentialsSchema]);
export type ApiKeyCredentials = z.infer<typeof apiKeyCredentialsSchema>;

/** V1 accepts a complete prompt only. `mcp_servers` omitted = all configured and available servers; [] = none. */
export const apiKeyRunRequestSchema = z
	.object({
		prompt: z
			.string()
			.min(1)
			.max(48_000)
			.refine((text) => text.trim().length > 0),
		task_id: z.string().min(1).max(200).optional(),
		mcp_servers: z.array(serverIdSchema).max(8).optional(),
		credentials: apiKeyCredentialsSchema,
	})
	.strict();
export type ApiKeyRunRequest = z.infer<typeof apiKeyRunRequestSchema>;

export type ApiKeyStatus = "enabled" | "disabled" | "revoked";

/** The only identity accepted by new-Key data access. Never optional, never an Integration ID. */
export interface ApiKeyPrincipal {
	readonly kind: "apiKey";
	readonly tenantId: string;
	readonly keyId: string;
	readonly carrierIntegrationId: string | null;
	/** Current secret hash captured at authentication; re-verified inside the acceptance transaction. */
	readonly secretHash: string;
}

export interface ApiKeyRunView {
	readonly run_id: string;
	readonly task_id: string | null;
	readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
	readonly result: string | null;
	readonly error: { readonly code: string } | null;
	readonly created_at: string;
	readonly started_at: string | null;
	readonly completed_at: string | null;
	readonly duplicate: boolean;
}

/** Lightweight summary returned by the Server list; tool details live in the detail endpoint. */
export interface ApiKeyMcpServerSummary {
	readonly server_id: string;
	readonly name: string;
	readonly description: string | null;
	readonly revision: number;
	readonly tool_count: number;
	readonly authentication: "none" | "bearer" | "api_key";
	readonly credential_requirements: { readonly connection_credential?: boolean; readonly tool_credential: boolean };
}

/** On-demand detail for one effective Server, including its allowed tool snapshot. */
export interface ApiKeyMcpServerView extends ApiKeyMcpServerSummary {
	readonly tools: readonly {
		readonly name: string;
		readonly description: string | null;
		readonly input_schema: Record<string, unknown>;
	}[];
	readonly required_credentials: readonly {
		readonly credential_id: string;
		readonly scope: "connection" | "tool";
		readonly tool_name?: string;
		readonly parameter?: string;
		readonly required: boolean;
	}[];
}

export interface ApiKeyUsageView {
	readonly key_id: string;
	readonly runs: number;
	readonly by_status: Readonly<Record<string, number>>;
	readonly usage: {
		readonly status: "covered" | "partial" | "unknown";
		readonly covered_runs: number;
		readonly missing_runs: number;
		readonly total_tokens: number | null;
		readonly input_tokens: number | null;
		readonly output_tokens: number | null;
	} | null;
}

/** Frozen per-Run capability snapshot, never derived from shared mutable state. */
export interface CapabilitySnapshot {
	readonly version: 1;
	readonly configurationId: string;
	readonly orchestrationVersionId: string;
	readonly revision: number;
	readonly servers: readonly {
		readonly serverId: string;
		readonly revision: number;
		readonly authentication: "none" | "bearer" | "api_key";
		readonly connectionCredentialId: string | null;
		readonly tools: readonly {
			readonly name: string;
			readonly inputSchema: Record<string, unknown>;
			readonly parameterCredentials: readonly {
				readonly credentialId: string;
				readonly parameter: string;
			}[];
		}[];
	}[];
}

const capabilitySnapshotSchema = z
	.object({
		version: z.literal(1),
		configurationId: z.string().min(1),
		orchestrationVersionId: z.string().min(1),
		revision: z.number().int().min(1),
		servers: z.array(
			z
				.object({
					serverId: z.string().min(1),
					revision: z.number().int().min(1),
					authentication: z.enum(["none", "bearer", "api_key"]),
					connectionCredentialId: z.string().min(1).nullable(),
					tools: z.array(
						z
							.object({
								name: z.string().min(1).max(200),
								inputSchema: z.record(z.string(), z.unknown()),
								parameterCredentials: z.array(
									z
										.object({
											credentialId: z.string().min(1).max(100),
											parameter: z.string().min(1).max(200),
										})
										.strict(),
								),
							})
							.strict(),
					),
				})
				.strict(),
		),
	})
	.strict();

/**
 * Validate a stored snapshot before it is used to assemble an execution spec.
 * Returns undefined for anything that is not exactly a V1 capability snapshot.
 */
export function parseCapabilitySnapshot(value: unknown): CapabilitySnapshot | undefined {
	const parsed = capabilitySnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

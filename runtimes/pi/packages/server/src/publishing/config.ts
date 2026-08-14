/**
 * Publishing feature configuration (MVP spec section 24.2).
 *
 * The publishing control plane, embed data plane and runtime plane are gated
 * behind a single master switch (`PI_PUBLISHING_ENABLED`). When the switch is
 * off the existing web server path must behave exactly as before: no database,
 * Redis or object-store clients are created, and `/api/pi/v1/ws` is unchanged.
 *
 * Enabling publishing without the required infrastructure (database, Redis,
 * keys) must fail startup instead of silently degrading to an unauthenticated
 * mode; those checks are added by later tasks that own the connections.
 */

export const PUBLISHING_ENABLED_ENV = "PI_PUBLISHING_ENABLED";
export const PUBLISHING_DATABASE_URL_ENV = "PI_DATABASE_URL";
export const BOOTSTRAP_TENANT_ID_ENV = "PI_BOOTSTRAP_TENANT_ID";
export const BOOTSTRAP_TENANT_NAME_ENV = "PI_BOOTSTRAP_TENANT_NAME";
export const CONTROL_ADMIN_TOKEN_FILE_ENV = "PI_CONTROL_ADMIN_TOKEN_FILE";
export const EMBED_ISSUER_ENV = "PI_EMBED_ISSUER";

/** Parsed publishing feature configuration. */
export interface PublishingConfig {
	/**
	 * Master switch, defaults to `false`. When `false`, no publishing
	 * infrastructure is created and existing paths are untouched.
	 */
	readonly enabled: boolean;
	/** `PI_DATABASE_URL`; required when enabled. */
	readonly databaseUrl: string | undefined;
	/** `PI_BOOTSTRAP_TENANT_ID`; the control plane maps to this tenant (33.1). */
	readonly bootstrapTenantId: string | undefined;
	/** `PI_BOOTSTRAP_TENANT_NAME`; required when enabled. */
	readonly bootstrapTenantName: string | undefined;
	/** `PI_CONTROL_ADMIN_TOKEN_FILE`; required when enabled (33.2). */
	readonly controlAdminTokenFile: string | undefined;
	/** `PI_EMBED_ISSUER`; base URL for generated embed URLs. */
	readonly embedBaseUrl: string;
}

/**
 * Parse the publishing configuration from an environment object.
 *
 * Accepts `true`/`false` (case-insensitive, trimmed). Any other value is a
 * configuration error and must fail startup rather than being ignored.
 */
function disabledConfig(): PublishingConfig {
	return {
		enabled: false,
		databaseUrl: undefined,
		bootstrapTenantId: undefined,
		bootstrapTenantName: undefined,
		controlAdminTokenFile: undefined,
		embedBaseUrl: "http://127.0.0.1:8765",
	};
}

export function parsePublishingConfig(env: NodeJS.ProcessEnv): PublishingConfig {
	const raw = env[PUBLISHING_ENABLED_ENV];
	if (raw === undefined) return disabledConfig();
	const normalized = raw.trim().toLowerCase();
	if (normalized === "false") return disabledConfig();
	if (normalized !== "true") {
		throw new Error(`${PUBLISHING_ENABLED_ENV} must be a boolean ("true" or "false"), got: ${JSON.stringify(raw)}`);
	}
	return {
		enabled: true,
		databaseUrl: env[PUBLISHING_DATABASE_URL_ENV],
		bootstrapTenantId: env[BOOTSTRAP_TENANT_ID_ENV],
		bootstrapTenantName: env[BOOTSTRAP_TENANT_NAME_ENV],
		controlAdminTokenFile: env[CONTROL_ADMIN_TOKEN_FILE_ENV],
		embedBaseUrl: env[EMBED_ISSUER_ENV] ?? "http://127.0.0.1:8765",
	};
}

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
export const PUBLISHING_REDIS_URL_ENV = "PI_REDIS_URL";
export const BOOTSTRAP_TENANT_ID_ENV = "PI_BOOTSTRAP_TENANT_ID";
export const BOOTSTRAP_TENANT_NAME_ENV = "PI_BOOTSTRAP_TENANT_NAME";
export const CONTROL_ADMIN_TOKEN_FILE_ENV = "PI_CONTROL_ADMIN_TOKEN_FILE";
export const EMBED_ISSUER_ENV = "PI_EMBED_ISSUER";
/** 匿名 subject hash 的服务端 HMAC pepper（spec 7.1，TASK-015）。 */
export const EMBED_SUBJECT_PEPPER_ENV = "PI_EMBED_SUBJECT_PEPPER";
export const ACCESS_TOKEN_PRIVATE_KEY_FILE_ENV = "PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE";
export const ACCESS_TOKEN_PUBLIC_KEY_FILE_ENV = "PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE";
export const ACCESS_TOKEN_KEY_ID_ENV = "PI_EMBED_ACCESS_TOKEN_KEY_ID";
export const ACCESS_TOKEN_TTL_SECONDS_ENV = "PI_EMBED_ACCESS_TOKEN_TTL_SECONDS";
export const EMBED_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 600;

/** Parsed publishing feature configuration. */
export interface PublishingConfig {
	/**
	 * Master switch, defaults to `false`. When `false`, no publishing
	 * infrastructure is created and existing paths are untouched.
	 */
	readonly enabled: boolean;
	/** `PI_DATABASE_URL`; required when enabled. */
	readonly databaseUrl: string | undefined;
	/** `PI_REDIS_URL`; required when enabled（限流/Ticket/未来 Lease）。 */
	readonly redisUrl: string | undefined;
	/** `PI_BOOTSTRAP_TENANT_ID`; the control plane maps to this tenant (33.1). */
	readonly bootstrapTenantId: string | undefined;
	/** `PI_BOOTSTRAP_TENANT_NAME`; required when enabled. */
	readonly bootstrapTenantName: string | undefined;
	/** `PI_CONTROL_ADMIN_TOKEN_FILE`; required when enabled (33.2). */
	readonly controlAdminTokenFile: string | undefined;
	/** `PI_EMBED_ISSUER`; base URL for generated embed URLs. */
	readonly embedBaseUrl: string;
	/**
	 * `PI_EMBED_SUBJECT_PEPPER`; HMAC pepper for anonymous subject hashes
	 * (spec 7.1). A server secret; required when the embed data plane is
	 * composed.
	 */
	readonly subjectPepper: string | undefined;
	/** `PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE` (Ed25519 PKCS8 PEM). */
	readonly accessTokenPrivateKeyFile: string | undefined;
	/** `PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE` (Ed25519 SPKI PEM). */
	readonly accessTokenPublicKeyFile: string | undefined;
	/** `PI_EMBED_ACCESS_TOKEN_KEY_ID`; independent keyId for platform tokens. */
	readonly accessTokenKeyId: string | undefined;
	/**
	 * `PI_EMBED_ACCESS_TOKEN_TTL_SECONDS`; defaults to 600 (spec 7.3
	 * recommends 5-15 minutes). Invalid values fail startup.
	 */
	readonly accessTokenTtlSeconds: number;
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
		redisUrl: undefined,
		bootstrapTenantId: undefined,
		bootstrapTenantName: undefined,
		controlAdminTokenFile: undefined,
		embedBaseUrl: "http://127.0.0.1:8765",
		subjectPepper: undefined,
		accessTokenPrivateKeyFile: undefined,
		accessTokenPublicKeyFile: undefined,
		accessTokenKeyId: undefined,
		accessTokenTtlSeconds: EMBED_ACCESS_TOKEN_DEFAULT_TTL_SECONDS,
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
	const ttlRaw = env[ACCESS_TOKEN_TTL_SECONDS_ENV];
	let accessTokenTtlSeconds = EMBED_ACCESS_TOKEN_DEFAULT_TTL_SECONDS;
	if (ttlRaw !== undefined) {
		const ttl = Number(ttlRaw);
		if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86_400) {
			throw new Error(
				`${ACCESS_TOKEN_TTL_SECONDS_ENV} must be an integer between 1 and 86400, got: ${JSON.stringify(ttlRaw)}`,
			);
		}
		accessTokenTtlSeconds = ttl;
	}
	return {
		enabled: true,
		databaseUrl: env[PUBLISHING_DATABASE_URL_ENV],
		redisUrl: env[PUBLISHING_REDIS_URL_ENV],
		bootstrapTenantId: env[BOOTSTRAP_TENANT_ID_ENV],
		bootstrapTenantName: env[BOOTSTRAP_TENANT_NAME_ENV],
		controlAdminTokenFile: env[CONTROL_ADMIN_TOKEN_FILE_ENV],
		embedBaseUrl: env[EMBED_ISSUER_ENV] ?? "http://127.0.0.1:8765",
		subjectPepper: env[EMBED_SUBJECT_PEPPER_ENV],
		accessTokenPrivateKeyFile: env[ACCESS_TOKEN_PRIVATE_KEY_FILE_ENV],
		accessTokenPublicKeyFile: env[ACCESS_TOKEN_PUBLIC_KEY_FILE_ENV],
		accessTokenKeyId: env[ACCESS_TOKEN_KEY_ID_ENV],
		accessTokenTtlSeconds,
	};
}

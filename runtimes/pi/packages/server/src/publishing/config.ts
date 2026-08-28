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
export const MCP_SECRET_MASTER_KEY_ENV = "PI_MCP_SECRET_MASTER_KEY";
export const MCP_ALLOW_HTTP_ENV = "PI_MCP_ALLOW_HTTP";
export const MCP_ALLOW_PRIVATE_NETWORK_ENV = "PI_MCP_ALLOW_PRIVATE_NETWORK";
export const MCP_ALLOWED_PORTS_ENV = "PI_MCP_ALLOWED_PORTS";
export const EMBED_ISSUER_ENV = "PI_EMBED_ISSUER";
/** 匿名 subject hash 的服务端 HMAC pepper（spec 7.1，TASK-015）。 */
export const EMBED_SUBJECT_PEPPER_ENV = "PI_EMBED_SUBJECT_PEPPER";
export const ACCESS_TOKEN_PRIVATE_KEY_FILE_ENV = "PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE";
export const ACCESS_TOKEN_PUBLIC_KEY_FILE_ENV = "PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE";
export const ACCESS_TOKEN_KEY_ID_ENV = "PI_EMBED_ACCESS_TOKEN_KEY_ID";
export const ACCESS_TOKEN_TTL_SECONDS_ENV = "PI_EMBED_ACCESS_TOKEN_TTL_SECONDS";
export const EMBED_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 600;
/** Launch Token 期望 audience（spec 7.2 `aud: "skdy-embed"`，TASK-028）。 */
export const LAUNCH_TOKEN_AUDIENCE_ENV = "PI_EMBED_LAUNCH_TOKEN_AUDIENCE";
export const EMBED_LAUNCH_TOKEN_DEFAULT_AUDIENCE = "skdy-embed";
/** 逗号分隔的宿主 issuer 白名单；为空 = signed-user Exchange 关闭（PD-19）。 */
export const LAUNCH_TOKEN_ALLOWED_ISSUERS_ENV = "PI_EMBED_LAUNCH_TOKEN_ALLOWED_ISSUERS";
export const OBJECT_STORE_ENDPOINT_ENV = "PI_OBJECT_STORE_ENDPOINT";
export const OBJECT_STORE_REGION_ENV = "PI_OBJECT_STORE_REGION";
export const OBJECT_STORE_BUCKET_ENV = "PI_OBJECT_STORE_BUCKET";
export const OBJECT_STORE_ACCESS_KEY_ID_ENV = "PI_OBJECT_STORE_ACCESS_KEY_ID";
export const OBJECT_STORE_SECRET_ACCESS_KEY_ENV = "PI_OBJECT_STORE_SECRET_ACCESS_KEY";
export const UPLOAD_QUOTA_CONVERSATION_BYTES_ENV = "PI_EMBED_UPLOAD_QUOTA_CONVERSATION_BYTES";
export const UPLOAD_QUOTA_PRINCIPAL_BYTES_ENV = "PI_EMBED_UPLOAD_QUOTA_PRINCIPAL_BYTES";
export const UPLOAD_QUOTA_APP_BYTES_ENV = "PI_EMBED_UPLOAD_QUOTA_APP_BYTES";

/** 上传总量配额平台默认（spec 14；TASK-031 可被环境变量覆盖）。 */
export const DEFAULT_UPLOAD_QUOTA = {
	conversationBytes: 100 * 1024 * 1024,
	principalBytes: 500 * 1024 * 1024,
	appBytes: 2 * 1024 * 1024 * 1024,
} as const;

/** S3 兼容对象存储配置（spec 24.1/24.2；TASK-030 附件落地）。 */
export interface ObjectStoreConfig {
	/** S3 endpoint（http(s)://host[:port]）。 */
	readonly endpoint: string;
	readonly region: string | undefined;
	readonly bucket: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

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
	/** Canonical Base64 decoded 32-byte AES key; optional until bearer MCP is configured. */
	readonly mcpSecretMasterKey?: Uint8Array;
	/** Outbound MCP network policy. MCP endpoints are unrestricted by default. */
	readonly mcpNetworkPolicy?: {
		readonly allowHttp: boolean;
		readonly allowPrivateNetwork: boolean;
		readonly allowedPorts: readonly number[] | undefined;
	};
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
	/**
	 * `PI_EMBED_LAUNCH_TOKEN_AUDIENCE`; the expected `aud` claim of host
	 * Launch Tokens (spec 7.2). Defaults to `skdy-embed`.
	 */
	readonly launchTokenAudience: string;
	/**
	 * `PI_EMBED_LAUNCH_TOKEN_ALLOWED_ISSUERS`; comma-separated allowlist of
	 * host issuers that may sign Launch Tokens. An empty list disables
	 * signed-user Exchange (PD-19 default): `mode: "signed_user"` requests
	 * are explicitly rejected, never silently accepted.
	 */
	readonly launchTokenAllowedIssuers: readonly string[];
	/**
	 * `PI_OBJECT_STORE_*` (spec 24.2); attachments object store. Absent =
	 * uploads are disabled (explicit 503, never node disk; spec 24.1).
	 * Partially-set values are a configuration error and fail startup.
	 */
	readonly objectStore?: ObjectStoreConfig | undefined;
	/**
	 * 上传总量配额（spec 14：单会话 / Principal / App 字节上限；TASK-031）。
	 * `PI_EMBED_UPLOAD_QUOTA_{CONVERSATION,PRINCIPAL,APP}_BYTES`；缺省用
	 * 平台默认（见 service 常量）。单文件/单次上限来自 RuntimeSpec
	 * capabilities.uploads（PD-09），不在此配置。
	 */
	readonly uploadQuota: {
		readonly conversationBytes: number;
		readonly principalBytes: number;
		readonly appBytes: number;
	};
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
		mcpSecretMasterKey: undefined,
		embedBaseUrl: "http://127.0.0.1:8765",
		subjectPepper: undefined,
		accessTokenPrivateKeyFile: undefined,
		accessTokenPublicKeyFile: undefined,
		accessTokenKeyId: undefined,
		accessTokenTtlSeconds: EMBED_ACCESS_TOKEN_DEFAULT_TTL_SECONDS,
		launchTokenAudience: EMBED_LAUNCH_TOKEN_DEFAULT_AUDIENCE,
		launchTokenAllowedIssuers: [],
		objectStore: undefined,
		uploadQuota: { ...DEFAULT_UPLOAD_QUOTA },
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
	const mcpSecretMasterKeyRaw = env[MCP_SECRET_MASTER_KEY_ENV];
	let mcpSecretMasterKey: Uint8Array | undefined;
	if (mcpSecretMasterKeyRaw !== undefined) {
		const bytes = Buffer.from(mcpSecretMasterKeyRaw, "base64");
		if (bytes.byteLength !== 32 || bytes.toString("base64") !== mcpSecretMasterKeyRaw) {
			throw new Error(`${MCP_SECRET_MASTER_KEY_ENV} must be canonical Base64 for exactly 32 bytes`);
		}
		mcpSecretMasterKey = Uint8Array.from(bytes);
	}
	const mcpNetworkPolicy = {
		allowHttp: parseBoolean(env[MCP_ALLOW_HTTP_ENV], true, MCP_ALLOW_HTTP_ENV),
		allowPrivateNetwork: parseBoolean(env[MCP_ALLOW_PRIVATE_NETWORK_ENV], true, MCP_ALLOW_PRIVATE_NETWORK_ENV),
		allowedPorts: parsePorts(env[MCP_ALLOWED_PORTS_ENV]),
	};
	return {
		enabled: true,
		databaseUrl: env[PUBLISHING_DATABASE_URL_ENV],
		redisUrl: env[PUBLISHING_REDIS_URL_ENV],
		bootstrapTenantId: env[BOOTSTRAP_TENANT_ID_ENV],
		bootstrapTenantName: env[BOOTSTRAP_TENANT_NAME_ENV],
		controlAdminTokenFile: env[CONTROL_ADMIN_TOKEN_FILE_ENV],
		mcpSecretMasterKey,
		mcpNetworkPolicy,
		embedBaseUrl: env[EMBED_ISSUER_ENV] ?? "http://127.0.0.1:8765",
		subjectPepper: env[EMBED_SUBJECT_PEPPER_ENV],
		accessTokenPrivateKeyFile: env[ACCESS_TOKEN_PRIVATE_KEY_FILE_ENV],
		accessTokenPublicKeyFile: env[ACCESS_TOKEN_PUBLIC_KEY_FILE_ENV],
		accessTokenKeyId: env[ACCESS_TOKEN_KEY_ID_ENV],
		accessTokenTtlSeconds,
		launchTokenAudience: env[LAUNCH_TOKEN_AUDIENCE_ENV] ?? EMBED_LAUNCH_TOKEN_DEFAULT_AUDIENCE,
		launchTokenAllowedIssuers: parseIssuerList(env[LAUNCH_TOKEN_ALLOWED_ISSUERS_ENV]),
		objectStore: parseObjectStore(env),
		uploadQuota: {
			conversationBytes: parsePositiveBytes(
				env[UPLOAD_QUOTA_CONVERSATION_BYTES_ENV],
				DEFAULT_UPLOAD_QUOTA.conversationBytes,
				UPLOAD_QUOTA_CONVERSATION_BYTES_ENV,
			),
			principalBytes: parsePositiveBytes(
				env[UPLOAD_QUOTA_PRINCIPAL_BYTES_ENV],
				DEFAULT_UPLOAD_QUOTA.principalBytes,
				UPLOAD_QUOTA_PRINCIPAL_BYTES_ENV,
			),
			appBytes: parsePositiveBytes(
				env[UPLOAD_QUOTA_APP_BYTES_ENV],
				DEFAULT_UPLOAD_QUOTA.appBytes,
				UPLOAD_QUOTA_APP_BYTES_ENV,
			),
		},
	};
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
	if (raw === undefined || raw === "") return fallback;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	throw new Error(`${name} must be a boolean ("true" or "false"), got: ${JSON.stringify(raw)}`);
}

function parsePorts(raw: string | undefined): readonly number[] | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const ports = raw.split(",").map((entry) => Number(entry.trim()));
	if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
		throw new Error(`${MCP_ALLOWED_PORTS_ENV} must be a comma-separated list of ports between 1 and 65535`);
	}
	return [...new Set(ports)].sort((left, right) => left - right);
}

/** 解析字节数环境变量；非法（非正整数）启动失败。 */
function parsePositiveBytes(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer (bytes), got: ${JSON.stringify(raw)}`);
	}
	return value;
}

/** 对象存储配置：全部缺省 = 关闭；部分缺省 = 配置错误（启动失败）。 */
function parseObjectStore(env: NodeJS.ProcessEnv): ObjectStoreConfig | undefined {
	const endpoint = env[OBJECT_STORE_ENDPOINT_ENV];
	const bucket = env[OBJECT_STORE_BUCKET_ENV];
	const accessKeyId = env[OBJECT_STORE_ACCESS_KEY_ID_ENV];
	const secretAccessKey = env[OBJECT_STORE_SECRET_ACCESS_KEY_ENV];
	const region = env[OBJECT_STORE_REGION_ENV];
	const provided = [endpoint, bucket, accessKeyId, secretAccessKey].filter(
		(value) => value !== undefined && value !== "",
	);
	if (provided.length === 0) return undefined;
	if (
		endpoint === undefined ||
		endpoint === "" ||
		bucket === undefined ||
		bucket === "" ||
		accessKeyId === undefined ||
		accessKeyId === "" ||
		secretAccessKey === undefined ||
		secretAccessKey === ""
	) {
		throw new Error(
			`${OBJECT_STORE_ENDPOINT_ENV}, ${OBJECT_STORE_BUCKET_ENV}, ${OBJECT_STORE_ACCESS_KEY_ID_ENV} and ${OBJECT_STORE_SECRET_ACCESS_KEY_ENV} must all be set when object storage is enabled`,
		);
	}
	return {
		endpoint,
		region: region !== undefined && region !== "" ? region : undefined,
		bucket,
		accessKeyId,
		secretAccessKey,
	};
}

/** 逗号分隔 issuer 白名单 -> 去空/去空白后的数组。 */
function parseIssuerList(raw: string | undefined): readonly string[] {
	if (raw === undefined) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

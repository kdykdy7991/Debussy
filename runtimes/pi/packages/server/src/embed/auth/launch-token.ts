/**
 * Launch Token 验证器（spec 7.2 + 27.4，TASK-028）。
 *
 * 宿主后端签发短期 JWS Launch Token（Ed25519/EdDSA），iframe 通过限定
 * Origin 的 postMessage 拿到后交给 Exchange。**平台只信任这个验证器的输出
 * （AD-11）**：URL 参数、普通 postMessage 字段或客户端提交的 Principal ID
 * 一律不构成身份。
 *
 * 验证顺序（任何一步失败都是统一 TOKEN_INVALID / TOKEN_EXPIRED，不泄漏
 * 细节）：
 *
 * 1. 解析 JWT 头取 `alg`/`kid`；`alg` 必须 EdDSA，`kid` 必须存在。
 * 2. 按 `(tenant, app, kid)` 从 `embed_launch_keys` 取登记的公钥（TASK-027
 *    只收公钥，私钥永不落库）；`revoked` / 未生效 / 已过期 key 拒绝。
 *    `active` 与 `retiring`（轮换窗口）都接受——旧/新 key 同时可用。
 * 3. `jwtVerify` 校验签名、`iss`（平台白名单）、`aud`（默认 skdy-embed）、
 *    `exp`（过期 -> TOKEN_EXPIRED）。
 * 4. 字段校验：`appId` 必须等于请求的 publicAppId；`origin` 必须等于请求
 *    Origin 头；`externalUserId` 非空且限长；`iat` 不得在未来。
 * 5. **nonce 原子占用**（Redis SET NX）：签名有效的 token 只能用一次；
 *    第二次 -> TOKEN_REPLAYED。
 *
 * 明文 nonce / externalUserId 不写日志、不落 Redis（只存 hash）。
 */
import { createHash } from "node:crypto";
import { decodeProtectedHeader, errors, importSPKI, type JWTPayload, jwtVerify } from "jose";
import type { NonceStore } from "../../persistence/redis/nonce-store.ts";
import { type EmbedError, tokenExpired, tokenInvalid, tokenReplayed } from "../../publishing/domain/errors.ts";
import type { PublishedAppRecord, PublishingRepositories } from "../../publishing/repositories.ts";

/** Launch Token 期望 audience 默认值（spec 7.2）。 */
export const LAUNCH_TOKEN_DEFAULT_AUDIENCE = "skdy-embed";
export const LAUNCH_TOKEN_ALGORITHM = "EdDSA";
/** nonce 保留窗口：覆盖 1~5 分钟 Launch Token 生命周期（spec 7.2）。 */
export const LAUNCH_NONCE_TTL_SECONDS = 300;
/** iat/exp 允许的时钟偏差。 */
export const LAUNCH_CLOCK_SKEW_SECONDS = 60;
const EXTERNAL_USER_ID_MAX_CHARS = 256;
const NONCE_MAX_CHARS = 256;

export interface LaunchTokenVerifierOptions {
	readonly repositories: PublishingRepositories;
	readonly nonces: NonceStore;
	/** `PI_EMBED_LAUNCH_TOKEN_AUDIENCE`; expected `aud` claim. */
	readonly audience?: string;
	/** Host issuer allowlist (spec 7.2 `iss` must be validated). */
	readonly allowedIssuers: readonly string[];
	/** Clock tolerance in seconds; defaults to 60. */
	readonly clockSkewSeconds?: number;
}

export interface VerifiedLaunchClaims {
	readonly externalUserId: string;
	readonly issuer: string;
	readonly nonce: string;
}

export type LaunchTokenVerifyResult =
	| { readonly ok: true; readonly claims: VerifiedLaunchClaims }
	| { readonly ok: false; readonly error: EmbedError };

export class LaunchTokenVerifier {
	private readonly repos: PublishingRepositories;
	private readonly nonces: NonceStore;
	private readonly audience: string;
	private readonly allowedIssuers: readonly string[];
	private readonly clockSkewSeconds: number;

	constructor(options: LaunchTokenVerifierOptions) {
		this.repos = options.repositories;
		this.nonces = options.nonces;
		this.audience = options.audience ?? LAUNCH_TOKEN_DEFAULT_AUDIENCE;
		this.allowedIssuers = options.allowedIssuers;
		this.clockSkewSeconds = options.clockSkewSeconds ?? LAUNCH_CLOCK_SKEW_SECONDS;
	}

	/** Verify a Launch Token against the app's registered public keys. */
	async verify(input: {
		readonly token: string;
		readonly app: PublishedAppRecord;
		readonly requestOrigin: string | undefined;
	}): Promise<LaunchTokenVerifyResult> {
		const { token, app, requestOrigin } = input;

		// 1. Header: alg + kid (no signature check yet).
		let header: { readonly alg?: string; readonly kid?: string };
		try {
			header = decodeProtectedHeader(token);
		} catch {
			return this.invalid("Launch token header is malformed");
		}
		if (header.alg !== LAUNCH_TOKEN_ALGORITHM) {
			return this.invalid(`Launch token algorithm must be ${LAUNCH_TOKEN_ALGORITHM}`);
		}
		if (typeof header.kid !== "string" || header.kid === "") {
			return this.invalid("Launch token is missing its kid");
		}

		// 2. Resolve the registered public key (TASK-027). Status gates:
		// active + retiring accepted, revoked/not-yet-active/expired rejected.
		const scope = { tenantId: app.tenantId, publishedAppId: app.publishedAppId };
		const key = await this.repos.launchKeys.getByKeyId(scope, header.kid);
		if (key === undefined) return this.invalid("unknown launch key id");
		if (key.status === "revoked") return this.invalid("launch key is revoked");
		if (key.notBefore.getTime() > Date.now()) return this.invalid("launch key is not active yet");
		if (key.expiresAt !== null && key.expiresAt.getTime() < Date.now()) {
			return this.invalid("launch key has expired");
		}
		let publicKey: Awaited<ReturnType<typeof importSPKI>>;
		try {
			publicKey = await importSPKI(key.publicKeyPem, "Ed25519");
		} catch {
			return this.invalid("launch key material is not a usable public key");
		}

		// 3. Signature + iss/aud/exp.
		let payload: JWTPayload;
		try {
			const result = await jwtVerify(token, publicKey, {
				// Empty allowlist means signed-user exchange is disabled by the
				// caller; a verifier is only constructed with a non-empty list.
				issuer: this.allowedIssuers.length > 0 ? [...this.allowedIssuers] : undefined,
				audience: this.audience,
				algorithms: [LAUNCH_TOKEN_ALGORITHM],
				clockTolerance: this.clockSkewSeconds,
			});
			payload = result.payload;
		} catch (error) {
			if (error instanceof errors.JWTExpired) {
				return { ok: false, error: tokenExpired("Launch token has expired") };
			}
			return this.invalid("Launch token signature or claims are invalid");
		}

		// 4. Claim validation: appId, origin, externalUserId, iat.
		const appId = payload.appId;
		const origin = payload.origin;
		const externalUserId = payload.externalUserId;
		const nonce = payload.nonce;
		if (typeof appId !== "string" || appId !== app.publicAppId) {
			return this.invalid("Launch token appId does not match the requested app");
		}
		if (typeof origin !== "string" || requestOrigin === undefined || origin !== requestOrigin) {
			return this.invalid("Launch token origin does not match the request origin");
		}
		if (
			typeof externalUserId !== "string" ||
			externalUserId === "" ||
			externalUserId.length > EXTERNAL_USER_ID_MAX_CHARS
		) {
			return this.invalid("Launch token externalUserId is missing or too long");
		}
		if (typeof nonce !== "string" || nonce === "" || nonce.length > NONCE_MAX_CHARS) {
			return this.invalid("Launch token nonce is missing or too long");
		}
		if (typeof payload.iat === "number" && payload.iat > Math.floor(Date.now() / 1000) + this.clockSkewSeconds) {
			return this.invalid("Launch token iat is in the future");
		}

		// 5. Single-use nonce (atomic claim; replay fails here).
		const claimed = await this.nonces.consume(nonce, LAUNCH_NONCE_TTL_SECONDS);
		if (!claimed) {
			return { ok: false, error: tokenReplayed("Launch token nonce was already used") };
		}
		return {
			ok: true,
			claims: {
				externalUserId,
				issuer: typeof payload.iss === "string" ? payload.iss : "",
				nonce,
			},
		};
	}

	private invalid(message: string): LaunchTokenVerifyResult {
		return { ok: false, error: tokenInvalid(message) };
	}
}

/** SHA-256 of a nonce (used by tests to assert only the hash is stored). */
export function nonceHash(nonce: string): string {
	return createHash("sha256").update(nonce, "utf8").digest("hex");
}

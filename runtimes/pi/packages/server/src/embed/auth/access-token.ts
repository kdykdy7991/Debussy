/**
 * Embed Access Token (spec 7.3 + 24.1, TASK-015).
 *
 * A short-lived asymmetric JWS (Ed25519 / EdDSA) that authorises exactly one
 * tenant, one published app and one principal. Claims carry no secrets: the
 * principal id, scope, token id and version info only (7.3) — the raw
 * visitorId / externalUserId never appear inside the token.
 *
 * Tokens are signed with the platform's own key pair
 * (`PI_EMBED_ACCESS_TOKEN_*`, an independent keyId, spec 24.1) — never with a
 * host launch key. `verify` is the single entry point used by every embed
 * resource, so the same issuer/audience/algorithm rules apply everywhere.
 */
import { readFile } from "node:fs/promises";
import { errors, type GenerateKeyPairResult, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { type EmbedError, tokenExpired, tokenInvalid } from "../../publishing/domain/errors.ts";
import type { PrincipalId, PublishedAppId, PublishedAppVersionId, TenantId } from "../../publishing/domain/ids.ts";
import { newRequestId } from "../../publishing/domain/ids.ts";
import type { PrincipalType } from "../../publishing/domain/states.ts";

/** Platform access-token audience; distinct from the host launch token's. */
export const EMBED_ACCESS_TOKEN_AUDIENCE = "skdy-embed-access";
export const EMBED_ACCESS_TOKEN_ALGORITHM = "EdDSA";
/** Spec 7.3 recommends 5-15 minutes; `PI_EMBED_ACCESS_TOKEN_TTL_SECONDS`. */
export const EMBED_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 600;

/**
 * Key type accepted by jose for Ed25519 signing/verification (CryptoKey).
 * Derived from jose's own `generateKeyPair` result so tests, the PEM loader
 * and the signer/verifier always agree on one structural type — the repo's
 * tsconfig has no DOM lib, so the webcrypto `CryptoKey` global is unavailable.
 */
export type EmbedAccessKey = GenerateKeyPairResult["privateKey"];

/** Decoded claims of an embed access token (all read from the JWT). */
export interface AccessTokenClaims {
	readonly tokenId: string;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly principalId: PrincipalId;
	readonly principalType: PrincipalType;
	readonly scopes: readonly string[];
	/** Current published-app-version id at issuance (informational, 7.3). */
	readonly publishedAppVersionId: PublishedAppVersionId | null;
	readonly issuedAt: Date;
	readonly expiresAt: Date;
}

export interface AccessTokenSignerOptions {
	/** `PI_EMBED_ISSUER`; the `iss` claim. */
	readonly issuer: string;
	/** Audience; defaults to `skdy-embed-access`. */
	readonly audience?: string;
	/** `PI_EMBED_ACCESS_TOKEN_KEY_ID`; the `kid` header (independent keyId). */
	readonly keyId: string;
	readonly privateKey: EmbedAccessKey;
	readonly publicKey: EmbedAccessKey;
	/** Lifetime in seconds; spec 7.3 recommends 5-15 minutes (default 600). */
	readonly ttlSeconds: number;
}

export interface AccessTokenSignInput {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly principalId: PrincipalId;
	readonly principalType: PrincipalType;
	readonly scopes?: readonly string[];
	readonly publishedAppVersionId?: string | null;
}

export type AccessTokenVerifyResult =
	| { readonly ok: true; readonly claims: AccessTokenClaims }
	| { readonly ok: false; readonly error: EmbedError };

export class AccessTokenService {
	private readonly issuer: string;
	private readonly audience: string;
	private readonly keyId: string;
	private readonly privateKey: EmbedAccessKey;
	private readonly publicKey: EmbedAccessKey;
	private readonly ttlSeconds: number;

	constructor(options: AccessTokenSignerOptions) {
		this.issuer = options.issuer;
		this.audience = options.audience ?? EMBED_ACCESS_TOKEN_AUDIENCE;
		this.keyId = options.keyId;
		this.privateKey = options.privateKey;
		this.publicKey = options.publicKey;
		this.ttlSeconds = options.ttlSeconds;
	}

	/** Sign a fresh access token for one tenant + app + principal. */
	async sign(input: AccessTokenSignInput): Promise<{ readonly token: string; readonly expiresAt: Date }> {
		const tokenId = newRequestId();
		const issuedAt = new Date();
		const expiresAt = new Date(issuedAt.getTime() + this.ttlSeconds * 1000);
		const token = await new SignJWT({
			tenantId: input.tenantId,
			publishedAppId: input.publishedAppId,
			principalId: input.principalId,
			principalType: input.principalType,
			scopes: input.scopes ?? [],
			publishedAppVersionId: input.publishedAppVersionId ?? null,
		})
			.setProtectedHeader({ alg: EMBED_ACCESS_TOKEN_ALGORITHM, kid: this.keyId, typ: "JWT" })
			.setIssuer(this.issuer)
			.setAudience(this.audience)
			.setSubject(input.principalId)
			.setJti(tokenId)
			.setIssuedAt(issuedAt)
			.setExpirationTime(expiresAt)
			.sign(this.privateKey);
		return { token, expiresAt };
	}

	/**
	 * Verify + decode an access token. This is the single entry point for
	 * every embed resource; expired tokens are `TOKEN_EXPIRED`, anything else
	 * (bad signature, wrong issuer/audience/algorithm, malformed claims) is
	 * the uniform `TOKEN_INVALID`.
	 */
	async verify(token: string): Promise<AccessTokenVerifyResult> {
		let payload: Record<string, unknown>;
		try {
			const result = await jwtVerify(token, this.publicKey, {
				issuer: this.issuer,
				audience: this.audience,
				algorithms: [EMBED_ACCESS_TOKEN_ALGORITHM],
			});
			payload = result.payload as Record<string, unknown>;
		} catch (error) {
			if (error instanceof errors.JWTExpired) {
				return { ok: false, error: tokenExpired("Embed access token has expired") };
			}
			return { ok: false, error: tokenInvalid("Embed access token is invalid") };
		}
		const claims = decodeClaims(payload);
		if (claims === null) return { ok: false, error: tokenInvalid("Embed access token claims are malformed") };
		return { ok: true, claims };
	}
}

/** Defensive claim decoding: our own tokens, but never trust the wire. */
function decodeClaims(payload: Record<string, unknown>): AccessTokenClaims | null {
	const tokenId = payload.jti;
	const subject = payload.sub;
	const tenantId = payload.tenantId;
	const publishedAppId = payload.publishedAppId;
	const principalId = payload.principalId;
	const principalType = payload.principalType;
	const scopes = payload.scopes;
	const publishedAppVersionId = payload.publishedAppVersionId;
	const issuedAt = payload.iat;
	const expiresAt = payload.exp;
	if (typeof tokenId !== "string" || tokenId === "") return null;
	if (typeof principalId !== "string" || principalId === "") return null;
	if (subject !== principalId) return null;
	if (typeof tenantId !== "string" || tenantId === "") return null;
	if (typeof publishedAppId !== "string" || publishedAppId === "") return null;
	if (typeof principalType !== "string" || principalType === "") return null;
	if (!Array.isArray(scopes) || scopes.some((entry) => typeof entry !== "string")) return null;
	if (publishedAppVersionId !== null && typeof publishedAppVersionId !== "string") return null;
	if (typeof issuedAt !== "number" || typeof expiresAt !== "number") return null;
	return {
		tokenId,
		tenantId: tenantId as TenantId,
		publishedAppId: publishedAppId as PublishedAppId,
		principalId: principalId as PrincipalId,
		principalType: principalType as PrincipalType,
		scopes: scopes as readonly string[],
		publishedAppVersionId: publishedAppVersionId === null ? null : (publishedAppVersionId as PublishedAppVersionId),
		issuedAt: new Date(issuedAt * 1000),
		expiresAt: new Date(expiresAt * 1000),
	};
}

export interface AccessTokenKeyMaterial {
	readonly privateKey: EmbedAccessKey;
	readonly publicKey: EmbedAccessKey;
}

/** Load the Ed25519 key pair from PEM files (`PI_EMBED_ACCESS_TOKEN_*`). */
export async function loadAccessTokenKeyMaterial(input: {
	readonly privateKeyFile: string;
	readonly publicKeyFile: string;
}): Promise<AccessTokenKeyMaterial> {
	const [privatePem, publicPem] = await Promise.all([
		readFile(input.privateKeyFile, "utf8"),
		readFile(input.publicKeyFile, "utf8"),
	]);
	return {
		privateKey: await importPKCS8(privatePem.trim(), "Ed25519"),
		publicKey: await importSPKI(publicPem.trim(), "Ed25519"),
	};
}

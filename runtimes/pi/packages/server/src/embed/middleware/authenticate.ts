/**
 * Embed Access Token 认证中间件（spec 7.3 / 13.1，TASK-016）。
 *
 * 从 `Authorization: Bearer <embed-access-token>` 解析并验签 Access Token，
 * 产出后续所有数据面操作所需的 Principal 上下文。验签是唯一入口
 * （`AccessTokenService.verify`），因此所有 embed 资源共享同一套
 * issuer/audience/algorithm 规则；失败统一映射 401
 * （TOKEN_INVALID / TOKEN_EXPIRED），缺失或非 Bearer 一律 TOKEN_INVALID。
 *
 * 中间件只做认证，不做授权：Conversation/Event/Attachment 的逐资源授权由
 * 各 Service 以本上下文为 scope 完成（AD-08：Scope 不能替代授权）。
 */
import type { IncomingMessage } from "node:http";
import { type EmbedError, tokenInvalid } from "../../publishing/domain/errors.ts";
import type { PrincipalId, PublishedAppId, PublishedAppVersionId, TenantId } from "../../publishing/domain/ids.ts";
import type { PrincipalType } from "../../publishing/domain/states.ts";
import type { AccessTokenService } from "../auth/access-token.ts";

/** 一次已认证请求的 Principal 上下文（从 Access Token claims 解析）。 */
export interface EmbedAuthContext {
	readonly tokenId: string;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly principalId: PrincipalId;
	readonly principalType: PrincipalType;
	readonly scopes: readonly string[];
	readonly issuedAt: Date;
	readonly expiresAt: Date;
	/**
	 * Pinned `PublishedAppVersionId` (WB-005). Always present; equals
	 * `app.currentVersionId` for non-preview principals. For
	 * `platform_admin_preview` principals this is the non-current version.
	 */
	readonly publishedAppVersionId: PublishedAppVersionId;
}

export interface EmbedAuthenticator {
	/**
	 * 认证一个 HTTP 请求。返回 Principal 上下文，或一个映射到 401 的
	 * EmbedError（缺失/无效 token → TOKEN_INVALID，过期 → TOKEN_EXPIRED）。
	 */
	authenticate(request: IncomingMessage): Promise<EmbedAuthContext | EmbedError>;
}

export function createEmbedAuthenticator(options: { readonly accessTokens: AccessTokenService }): EmbedAuthenticator {
	return {
		async authenticate(request) {
			const bearer = readBearerToken(request);
			if (bearer === null) return tokenInvalid("Missing or invalid bearer token");
			const verified = await options.accessTokens.verify(bearer);
			if (!verified.ok) return verified.error;
			const claims = verified.claims;
			if (claims.publishedAppVersionId === null) {
				return tokenInvalid("Token missing publishedAppVersionId");
			}
			const pinnedVersionId: PublishedAppVersionId = claims.publishedAppVersionId;
			const ctx: EmbedAuthContext = {
				tokenId: claims.tokenId,
				tenantId: claims.tenantId,
				publishedAppId: claims.publishedAppId,
				principalId: claims.principalId,
				principalType: claims.principalType,
				scopes: claims.scopes,
				issuedAt: claims.issuedAt,
				expiresAt: claims.expiresAt,
				publishedAppVersionId: pinnedVersionId,
			};
			return ctx;
		},
	};
}

/** 读取 `Authorization: Bearer <token>`；缺失/格式错误返回 null。 */
function readBearerToken(request: IncomingMessage): string | null {
	const authorization = request.headers.authorization ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/);
	if (match === null || match[1] === undefined) return null;
	const token = match[1].trim();
	return token === "" ? null : token;
}

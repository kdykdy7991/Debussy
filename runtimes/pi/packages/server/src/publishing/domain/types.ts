/**
 * Core domain types shared across the publishing/embed planes: the security
 * identity (`Principal`), the resource ownership triple and the required
 * resource scope for every scoped repository query.
 */
import type { ConversationId, PrincipalId, PublishedAppId, TenantId, TurnId } from "./ids.ts";
import type { PrincipalType } from "./states.ts";

/**
 * Resource owner: resources belong to `(tenantId, publishedAppId,
 * ownerPrincipalId)`. `externalUserId`/`anonymousVisitorId` are mapped to a
 * Principal first; resource ownership never references raw external
 * identifiers (spec AD-08/AD-09, section 5.1).
 */
export interface ResourceOwner {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly ownerPrincipalId: PrincipalId;
}

/**
 * Required scope for any repository query touching data-plane resources.
 * Spec section 13.2: every query must carry at least one of
 * `(tenantId, publishedAppId, principalId, resourceId)`; bare resourceId
 * lookups without the owning scope are forbidden.
 */
export interface ResourceScope {
	readonly tenantId: TenantId;
	readonly publishedAppId?: PublishedAppId;
	readonly principalId?: PrincipalId;
	readonly resourceId?: ConversationId | TurnId | string;
}

/**
 * Authenticated identity for one request (spec section 5.2). `subject` is the
 * stable hashed subject within the `(tenantId, publishedAppId)` namespace;
 * raw external identifiers are never stored as plaintext primary keys.
 */
export interface Principal {
	readonly principalId: PrincipalId;
	readonly principalType: PrincipalType;
	readonly subject: string;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	/** Present only for `external_user`. */
	readonly externalUserId?: string;
	/** Present only for `anonymous_visitor`. */
	readonly anonymousVisitorId?: string;
	readonly issuedAt: Date;
	readonly expiresAt: Date;
	readonly scopes: readonly string[];
}

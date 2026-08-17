/**
 * Preview Ticket service (WB-005 / SPEC §6.3, §7).
 *
 * Issues short-lived (5 min default) opaque JWS tickets bound to a specific
 * `(tenantId, appId, versionId)`. Tickets are single-use (consumed on first
 * verify) and never logged, written to storage, or accepted after expiry.
 *
 * Signing key: derived from the platform admin token (HMAC SHA-256, base64url).
 * This deliberately co-locates ticket trust with the existing admin-token
 * trust anchor: a leaked admin token already allows ticket issuance, so a
 * separate key would not reduce risk.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PreviewTicket } from "@earendil-works/pi-protocol";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import type { SecretRegistry } from "../logging/redact.ts";
import type { PublishedAppId, PublishedAppVersionId, TenantId } from "./domain/ids.ts";

/** Default ticket TTL (5 minutes). */
export const PREVIEW_TICKET_DEFAULT_TTL_SEC = 300;
/** Lower bound on ticket TTL. */
export const PREVIEW_TICKET_MIN_TTL_SEC = 60;
/** Upper bound on ticket TTL. */
export const PREVIEW_TICKET_MAX_TTL_SEC = 3600;
/** Allowed clock skew for ticket expiry check. */
const TICKET_CLOCK_SKEW_SEC = 30;
/** Bounded consumed-set to avoid unbounded memory growth under load. */
const DEFAULT_MAX_CONSUMED = 1024;

interface PreviewTicketClaims extends JWTPayload {
	readonly appId: string; // bare uuid
	readonly versionId: string; // bare uuid
	readonly tenantId: string; // bare uuid
	readonly publicAppId: string;
	readonly origin: string;
	readonly jti: string;
}

interface ConsumedTicket {
	readonly appId: PublishedAppId;
	readonly versionId: PublishedAppVersionId;
	readonly tenantId: TenantId;
	readonly consumedAt: number;
}

/**
 * Preview ticket service. Holds the in-memory consumed-set so a ticket can only
 * be redeemed once (single-use).
 */
export class PreviewTicketService {
	private readonly signingKey: Uint8Array;
	private readonly embedBaseUrl: string;
	private readonly consumed = new Map<string, ConsumedTicket>();
	private readonly maxConsumed: number;
	private readonly secrets: SecretRegistry | undefined;

	constructor(options: {
		readonly adminToken: string;
		readonly embedBaseUrl: string;
		readonly maxConsumed?: number;
		readonly secrets?: SecretRegistry;
	}) {
		this.signingKey = new Uint8Array(createHash("sha256").update(`preview-ticket:${options.adminToken}`).digest());
		this.embedBaseUrl = options.embedBaseUrl.replace(/\/+$/, "");
		this.maxConsumed = options.maxConsumed ?? DEFAULT_MAX_CONSUMED;
		this.secrets = options.secrets;
	}

	async issue(input: {
		readonly tenantId: TenantId;
		readonly appId: PublishedAppId;
		readonly versionId: PublishedAppVersionId;
		readonly publicAppId: string;
		readonly ttlSeconds?: number;
	}): Promise<PreviewTicket> {
		const ttl =
			input.ttlSeconds === undefined
				? PREVIEW_TICKET_DEFAULT_TTL_SEC
				: Math.min(Math.max(input.ttlSeconds, PREVIEW_TICKET_MIN_TTL_SEC), PREVIEW_TICKET_MAX_TTL_SEC);
		const jti = randomBytes(16).toString("hex");
		const now = Math.floor(Date.now() / 1000);
		const exp = now + ttl;
		const ticket = await new SignJWT({
			appId: input.appId,
			versionId: input.versionId,
			tenantId: input.tenantId,
			publicAppId: input.publicAppId,
			origin: new URL(this.embedBaseUrl).origin,
		})
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setIssuedAt(now)
			.setExpirationTime(exp)
			.setJti(jti)
			.sign(this.signingKey);
		this.secrets?.register(ticket);
		const previewUrl = `${this.embedBaseUrl}/preview/${encodeURIComponent(input.publicAppId)}`;
		return {
			ticket,
			expiresAt: new Date(exp * 1000).toISOString(),
			previewUrl,
		};
	}

	/**
	 * Verify a preview ticket and mark it consumed (single-use). Returns the
	 * app/version/tenant the caller should bind the conversation to.
	 */
	async consume(input: {
		readonly publicAppId: string;
		readonly origin: string | undefined;
		readonly ticket: string;
	}): Promise<
		| {
				readonly ok: true;
				readonly appId: PublishedAppId;
				readonly versionId: PublishedAppVersionId;
				readonly tenantId: TenantId;
		  }
		| { readonly ok: false; readonly code: "EXPIRED" | "INVALID" | "ALREADY_CONSUMED" }
	> {
		let payload: PreviewTicketClaims;
		try {
			const result = await jwtVerify<PreviewTicketClaims>(input.ticket, this.signingKey, {
				clockTolerance: TICKET_CLOCK_SKEW_SEC,
				algorithms: ["HS256"],
			});
			payload = result.payload;
		} catch (error) {
			const name = (error as { code?: string }).code ?? "";
			if (name.includes("EXPIRED")) return { ok: false, code: "EXPIRED" };
			return { ok: false, code: "INVALID" };
		}
		const jti = String(payload.jti ?? "");
		if (payload.publicAppId !== input.publicAppId || payload.origin !== input.origin)
			return { ok: false, code: "INVALID" };
		if (this.consumed.has(jti)) return { ok: false, code: "ALREADY_CONSUMED" };
		const appId = payload.appId as PublishedAppId | undefined;
		const versionId = payload.versionId as PublishedAppVersionId | undefined;
		const tenantId = payload.tenantId as TenantId | undefined;
		if (appId === undefined || versionId === undefined || tenantId === undefined) {
			return { ok: false, code: "INVALID" };
		}
		// FIFO eviction
		while (this.consumed.size >= this.maxConsumed) {
			const firstKey = this.consumed.keys().next().value;
			if (firstKey === undefined) break;
			this.consumed.delete(firstKey);
		}
		this.consumed.set(jti, { appId, versionId, tenantId, consumedAt: Date.now() });
		return { ok: true, appId, versionId, tenantId };
	}

	/** HMAC fingerprint for telemetry only (audit logs); never logs the bearer. */
	static fingerprint(ticket: string): string {
		return createHmac("sha256", "preview-ticket-fp").update(ticket).digest("hex").slice(0, 16);
	}
}

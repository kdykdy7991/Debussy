import type { PrincipalId, PublishedAppId, TenantId } from "../../publishing/domain/ids.ts";
import type { PrincipalType } from "../../publishing/domain/states.ts";
import { hashOf, newTicket, type TicketStore, WS_TICKET_DEFAULT_TTL_MS } from "./ws-ticket.ts";

export interface VoiceProxyTicketClaims {
	readonly purpose: "voice-engine";
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly principalId: PrincipalId;
	readonly principalType: PrincipalType;
	readonly tokenId: string;
	readonly origin: string | null;
}

export interface VoiceProxyTicketService {
	issue(input: Omit<VoiceProxyTicketClaims, "purpose" | "origin"> & { readonly origin: string | undefined }): Promise<{
		readonly ticket: string;
		readonly expiresAt: Date;
	}>;
	consume(ticket: string, expected: { readonly origin: string | undefined }): Promise<VoiceProxyTicketClaims | null>;
}

export function createVoiceProxyTicketService(
	store: TicketStore,
	options: { readonly ttlMs?: number } = {},
): VoiceProxyTicketService {
	const ttlMs = options.ttlMs ?? WS_TICKET_DEFAULT_TTL_MS;
	return {
		async issue(input) {
			const ticket = newTicket();
			const claims: VoiceProxyTicketClaims = {
				purpose: "voice-engine",
				tenantId: input.tenantId,
				publishedAppId: input.publishedAppId,
				principalId: input.principalId,
				principalType: input.principalType,
				tokenId: input.tokenId,
				origin: input.origin ?? null,
			};
			await store.set(hashOf(ticket), JSON.stringify(claims), Math.max(1, Math.ceil(ttlMs / 1000)));
			return { ticket, expiresAt: new Date(Date.now() + ttlMs) };
		},
		async consume(ticket, expected) {
			const raw = await store.consume(hashOf(ticket));
			if (raw === null) return null;
			try {
				const claims = JSON.parse(raw) as Partial<VoiceProxyTicketClaims>;
				if (claims.purpose !== "voice-engine" || claims.origin !== (expected.origin ?? null)) return null;
				if (
					claims.tenantId === undefined ||
					claims.publishedAppId === undefined ||
					claims.principalId === undefined ||
					claims.principalType === undefined ||
					claims.tokenId === undefined
				)
					return null;
				return claims as VoiceProxyTicketClaims;
			} catch {
				return null;
			}
		},
	};
}

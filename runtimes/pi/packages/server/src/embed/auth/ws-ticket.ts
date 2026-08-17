/**
 * WebSocket Ticket（spec 7.3 / 12.1 / 27.6，TASK-024）。
 *
 * 由已认证的 Access Token 申请：一次性、短 TTL（默认 45s）、绑定
 * Principal + Conversation + Origin。Ticket 是至少 256-bit 随机 opaque
 * 值，Redis 只存其 SHA-256 与 claims；消费用 Lua 原子 get+del，第二次使用
 * 必定失败（TOKEN_REPLAYED 语义）。Ticket 可出现在 WS URL 中，但长效
 * Access Token 绝不能进 URL 或访问日志（禁止继续条件）。
 */
import { createHash, randomBytes } from "node:crypto";
import type {
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	TenantId,
} from "../../publishing/domain/ids.ts";
import type { PrincipalType } from "../../publishing/domain/states.ts";

export interface TicketClaims {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly principalId: PrincipalId;
	readonly principalType: PrincipalType;
	readonly tokenId: string;
	readonly conversationId: ConversationId;
	/** Pinned version (WB-005). Preview conversations must not switch versions. */
	readonly publishedAppVersionId: PublishedAppVersionId | null;
	/** 签发时的请求 Origin；null 表示签发时无 Origin（严格模式应拒绝）。 */
	readonly origin: string | null;
}

export interface WsTicketService {
	/** 签发一次性 Ticket（绑定 scope + Origin）。 */
	issue(input: {
		readonly tenantId: TenantId;
		readonly publishedAppId: PublishedAppId;
		readonly principalId: PrincipalId;
		readonly principalType: PrincipalType;
		readonly tokenId: string;
		readonly conversationId: ConversationId;
		readonly origin: string | undefined;
		readonly publishedAppVersionId?: PublishedAppVersionId | null;
	}): Promise<{ readonly ticket: string; readonly expiresAt: Date }>;
	/**
	 * 单次消费：原子 get+del；ticket 不存在/已消费，或 claims 与期望的
	 * conversation/origin 不匹配时返回 null（调用方映射 401/403）。
	 * `conversationId` 可选：Realtime upgrade 时未知（由 claims 携带），
	 * 提供时强制校验。
	 */
	consume(
		ticket: string,
		expected: { readonly conversationId?: ConversationId; readonly origin: string | undefined },
	): Promise<TicketClaims | null>;
}

export interface TicketStore {
	/** 以 hash 为键存 claims（TTL 秒）。 */
	set(hash: string, claims: string, ttlSeconds: number): Promise<void>;
	/** 原子 get+del；不存在返回 null。 */
	consume(hash: string): Promise<string | null>;
}

export const WS_TICKET_DEFAULT_TTL_MS = 45_000; // spec 7.3：30-60 秒

export function createWsTicketService(store: TicketStore, options: { readonly ttlMs?: number } = {}): WsTicketService {
	const ttlMs = options.ttlMs ?? WS_TICKET_DEFAULT_TTL_MS;
	return {
		async issue(input) {
			const ticket = newTicket();
			const claims: TicketClaims = {
				tenantId: input.tenantId,
				publishedAppId: input.publishedAppId,
				principalId: input.principalId,
				principalType: input.principalType,
				tokenId: input.tokenId,
				conversationId: input.conversationId,
				publishedAppVersionId: input.publishedAppVersionId ?? null,
				origin: input.origin ?? null,
			};
			const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
			await store.set(hashOf(ticket), JSON.stringify(claims), ttlSeconds);
			return { ticket, expiresAt: new Date(Date.now() + ttlMs) };
		},
		async consume(ticket, expected) {
			const raw = await store.consume(hashOf(ticket));
			if (raw === null) return null;
			let claims: TicketClaims;
			try {
				claims = JSON.parse(raw) as TicketClaims;
			} catch {
				return null;
			}
			if (expected.conversationId !== undefined && claims.conversationId !== expected.conversationId) return null;
			if (claims.origin !== (expected.origin ?? null)) return null;
			return claims;
		},
	};
}

/** 256-bit 随机 opaque ticket（base64url，43 字符）。 */
export function newTicket(): string {
	return randomBytes(32).toString("base64url");
}

/** Redis 只存 ticket 的 SHA-256（ticket 本身不落存储，防泄库重放）。 */
export function hashOf(ticket: string): string {
	return createHash("sha256").update(ticket, "utf8").digest("hex");
}

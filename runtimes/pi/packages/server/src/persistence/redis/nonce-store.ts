/**
 * Redis Nonce Store（TASK-028，spec 7.2）。
 *
 * Launch Token 的 `nonce` 在有效期内只能被交换一次。Store 只保存
 * `sha256(nonce)`（与 WebSocket Ticket 同语义：明文 nonce 不落 Redis），
 * `SET ... NX EX` 原子占用：并发/重放时恰好一个消费者拿到 `OK`，其余得到
 * null —— 第二次使用必定失败（TOKEN_REPLAYED）。
 */
import { createHash } from "node:crypto";
import type { RedisClient } from "./client.ts";

const KEY_PREFIX = "embed:nonce:";

export interface NonceStore {
	/**
	 * Atomically claim a nonce for `ttlSeconds`. Returns `false` when the
	 * nonce was already claimed (replay) or is still within its window.
	 */
	consume(nonce: string, ttlSeconds: number): Promise<boolean>;
}

export function createRedisNonceStore(redis: RedisClient): NonceStore {
	return {
		async consume(nonce, ttlSeconds) {
			const hash = createHash("sha256").update(nonce, "utf8").digest("hex");
			// SET key value EX ttl NX: only sets when the key does not exist.
			const reply = await redis.run("SET", `${KEY_PREFIX}${hash}`, "1", "EX", ttlSeconds, "NX");
			return reply === "OK";
		},
	};
}

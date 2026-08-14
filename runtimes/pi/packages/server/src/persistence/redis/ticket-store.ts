/**
 * Redis Ticket Store（TASK-024）。
 *
 * `set` 存 `embed:ws-ticket:<sha256(ticket)> -> claims JSON`（TTL）；`consume`
 * 用 Lua 脚本原子 get+del——并发/重放下恰好一个消费者拿到 claims，其余得到
 * null（spec 7.3：单次消费，第二次必定失败）。
 */

import type { TicketStore } from "../../embed/auth/ws-ticket.ts";
import type { RedisClient } from "./client.ts";

const KEY_PREFIX = "embed:ws-ticket:";

/** 原子读取并删除：`GET` + `DEL`，返回旧值或 nil。 */
const CONSUME_LUA = `
local value = redis.call('get', KEYS[1])
if value then
  redis.call('del', KEYS[1])
end
return value
`;

export function createRedisTicketStore(redis: RedisClient): TicketStore {
	return {
		async set(hash, claims, ttlSeconds) {
			await redis.run("SET", `${KEY_PREFIX}${hash}`, claims, "EX", ttlSeconds);
		},
		async consume(hash) {
			const reply = await redis.run("EVAL", CONSUME_LUA, 1, `${KEY_PREFIX}${hash}`);
			return reply === null || reply === undefined ? null : String(reply);
		},
	};
}

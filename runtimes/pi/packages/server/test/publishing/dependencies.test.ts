/**
 * TASK-002 dependency smoke test: verifies the newly introduced direct
 * dependencies load under Node 22 ESM with their TypeScript types intact.
 * No external service is contacted here; connection behaviour is tested from
 * TASK-003 onward.
 */

import { Redis } from "ioredis";
import { generateKeyPair, SignJWT } from "jose";
import * as Minio from "minio";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import { z } from "zod";

describe("publishing dependencies load with types", () => {
	test("postgres exposes the tagged-template sql function", () => {
		expect(typeof postgres).toBe("function");
		const sql = postgres("postgresql://user:pass@127.0.0.1:5432/db");
		expect(typeof sql).toBe("function");
		// sql template helpers must exist; no query is executed here.
		expect(typeof sql.unsafe).toBe("function");
		void sql.end({ timeout: 1 }).catch(() => {});
	});

	test("ioredis exposes the Redis client class", () => {
		expect(typeof Redis).toBe("function");
		const client = new Redis("redis://127.0.0.1:6379", { lazyConnect: true });
		expect(typeof client.connect).toBe("function");
		expect(typeof client.quit).toBe("function");
		client.disconnect();
	});

	test("jose exposes JWS signing primitives", () => {
		expect(typeof SignJWT).toBe("function");
		expect(typeof generateKeyPair).toBe("function");
	});

	test("minio exposes the S3-compatible client", () => {
		expect(typeof Minio.Client).toBe("function");
		const client = new Minio.Client({
			endPoint: "127.0.0.1",
			port: 9000,
			useSSL: false,
			accessKey: "test",
			secretKey: "test",
		});
		expect(typeof client.putObject).toBe("function");
		expect(typeof client.getObject).toBe("function");
		expect(typeof client.removeObject).toBe("function");
	});

	test("zod runtime validation works without any", () => {
		const schema = z.object({ publicAppId: z.string().min(4), enabled: z.boolean() });
		expect(schema.safeParse({ publicAppId: "pub_x", enabled: true }).success).toBe(true);
		expect(schema.safeParse({ publicAppId: "", enabled: true }).success).toBe(false);
	});
});

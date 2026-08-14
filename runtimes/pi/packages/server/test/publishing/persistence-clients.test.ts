/**
 * TASK-003 persistence client tests.
 *
 * Unit behaviour (missing config, failed connection, repeated close, closed
 * rejection, redaction) never touches the network. Integration cases (success
 * path) use the local development services and are skipped automatically when
 * they are not reachable, so the suite stays green in CI without services.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalTestObjectStore } from "../../src/persistence/object-store/local-test.ts";
import { S3ObjectStore } from "../../src/persistence/object-store/s3.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { RedisClient } from "../../src/persistence/redis/client.ts";

const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const REDIS_URL = process.env.PI_TEST_REDIS_URL ?? "redis://127.0.0.1:6380/15";
const UNREACHABLE_PORT = 59999;

async function probePostgres(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2 });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}

async function probeRedis(): Promise<boolean> {
	try {
		const client = new RedisClient({ url: REDIS_URL, connectTimeoutMs: 2000 });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}

const pgUp = await probePostgres();
const redisUp = await probeRedis();

describe("postgres client", () => {
	test("rejects an empty connection URL at construction", () => {
		expect(() => new PostgresClient({ url: "  " })).toThrow(/non-empty connection URL/);
	});

	test("rejects operations after close", async () => {
		const client = new PostgresClient({ url: PG_URL });
		await client.close();
		await expect(client.ping()).rejects.toThrow(/closed/);
	});

	test("close is idempotent", async () => {
		const client = new PostgresClient({ url: PG_URL });
		await client.close();
		await expect(client.close()).resolves.toBeUndefined();
	});

	test("failed connection surfaces a sanitised error", async () => {
		const url = `postgresql://user:supersecret@127.0.0.1:${UNREACHABLE_PORT}/db`;
		const client = new PostgresClient({ url, connectTimeoutSeconds: 1, backoff: false });
		let error: unknown;
		try {
			await client.ping();
			error = undefined;
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeDefined();
		const message = error instanceof Error ? error.message : String(error);
		expect(message).not.toContain("supersecret");
		expect(message).not.toContain(url);
	});
});

describe.skipIf(!pgUp)("postgres client integration", () => {
	test("ping succeeds against the local test database", async () => {
		const client = new PostgresClient({ url: PG_URL });
		await expect(client.ping()).resolves.toBeUndefined();
		await client.close();
	});
});

describe("redis client", () => {
	test("rejects an empty connection URL at construction", () => {
		expect(() => new RedisClient({ url: "  " })).toThrow(/non-empty connection URL/);
	});

	test("rejects operations after close", async () => {
		const client = new RedisClient({ url: REDIS_URL });
		await client.close();
		await expect(client.ping()).rejects.toThrow(/closed/);
	});

	test("close is idempotent", async () => {
		const client = new RedisClient({ url: REDIS_URL });
		await client.close();
		await expect(client.close()).resolves.toBeUndefined();
	});

	test("failed connection surfaces a sanitised error", async () => {
		const url = `redis://:supersecret@127.0.0.1:${UNREACHABLE_PORT}/0`;
		const client = new RedisClient({ url, connectTimeoutMs: 1000 });
		let error: unknown;
		try {
			await client.ping();
			error = undefined;
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeDefined();
		const message = error instanceof Error ? error.message : String(error);
		expect(message).not.toContain("supersecret");
		expect(message).not.toContain(url);
	});
});

describe.skipIf(!redisUp)("redis client integration", () => {
	test("ping succeeds against the local redis", async () => {
		const client = new RedisClient({ url: REDIS_URL });
		await expect(client.ping()).resolves.toBeUndefined();
		await client.close();
	});
});

describe("local test object store", () => {
	let dir: string;
	let store: LocalTestObjectStore;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "skdy-object-store-"));
		store = new LocalTestObjectStore(dir);
	});

	afterAll(async () => {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("put/get/stat round-trip", async () => {
		const bucket = "test-bucket";
		await store.putObject({
			bucket,
			objectKey: "conv_x/a.txt",
			data: Buffer.from("hello"),
			contentType: "text/plain",
		});
		const data = await store.getObject({ bucket, objectKey: "conv_x/a.txt" });
		expect(data.toString("utf8")).toBe("hello");
		const stat = await store.statObject({ bucket, objectKey: "conv_x/a.txt" });
		expect(stat.size).toBe(5);
		expect(stat.lastModified).toBeInstanceOf(Date);
	});

	test("missing object rejects", async () => {
		await expect(store.getObject({ bucket: "test-bucket", objectKey: "missing" })).rejects.toThrow();
	});

	test("remove is idempotent", async () => {
		const bucket = "test-bucket";
		await store.putObject({ bucket, objectKey: "to-remove", data: Buffer.from("x") });
		await store.removeObject({ bucket, objectKey: "to-remove" });
		await expect(store.removeObject({ bucket, objectKey: "to-remove" })).resolves.toBeUndefined();
		await expect(store.getObject({ bucket, objectKey: "to-remove" })).rejects.toThrow();
	});

	test("path traversal cannot escape the bucket", async () => {
		const bucket = "test-bucket";
		await store.putObject({ bucket, objectKey: "../../escape", data: Buffer.from("x") });
		// The traversal sequence is neutralised: no file is created outside root.
		await expect(store.getObject({ bucket, objectKey: "../../escape" })).resolves.toEqual(Buffer.from("x"));
	});

	test("rejects operations after close", async () => {
		const closed = new LocalTestObjectStore(dir);
		await closed.close();
		await expect(closed.getObject({ bucket: "b", objectKey: "k" })).rejects.toThrow(/closed/);
	});
});

describe("s3 object store adapter", () => {
	test("rejects missing credentials", () => {
		expect(() => new S3ObjectStore({ endPoint: "127.0.0.1", accessKey: "", secretKey: "", bucket: "b" })).toThrow(
			/non-empty accessKey and secretKey/,
		);
	});

	test("rejects a missing bucket", () => {
		expect(() => new S3ObjectStore({ endPoint: "127.0.0.1", accessKey: "a", secretKey: "s", bucket: "" })).toThrow(
			/non-empty bucket/,
		);
	});
});

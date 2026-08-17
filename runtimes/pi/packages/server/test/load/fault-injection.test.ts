/** TASK-038 fault injection: real TCP interruption and recovery for PG/Redis clients. */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { RedisClient } from "../../src/persistence/redis/client.ts";

const RUN = process.env.PI_FAULT_LOAD !== undefined;
const PG_URL = new URL(process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test");
const REDIS_URL = new URL(process.env.PI_TEST_REDIS_URL ?? "redis://127.0.0.1:6380/15");

class TcpFaultProxy {
	private readonly upstreamHost: string;
	private readonly upstreamPort: number;
	private readonly sockets = new Set<Socket>();
	private server: Server | undefined;
	private enabled = true;
	port = 0;

	constructor(upstreamHost: string, upstreamPort: number) {
		this.upstreamHost = upstreamHost;
		this.upstreamPort = upstreamPort;
	}

	async start(): Promise<void> {
		this.server = createServer((client) => {
			if (!this.enabled) {
				client.destroy();
				return;
			}
			const upstream = createConnection({ host: this.upstreamHost, port: this.upstreamPort });
			this.track(client);
			this.track(upstream);
			client.pipe(upstream);
			upstream.pipe(client);
			client.on("error", () => upstream.destroy());
			upstream.on("error", () => client.destroy());
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
		this.port = (this.server.address() as { port: number }).port;
	}

	interrupt(): void {
		this.enabled = false;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
	}

	restore(): void {
		this.enabled = true;
	}

	async close(): Promise<void> {
		this.interrupt();
		if (this.server !== undefined) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	private track(socket: Socket): void {
		this.sockets.add(socket);
		socket.once("close", () => this.sockets.delete(socket));
	}
}

async function eventually(action: () => Promise<void>, timeoutMs = 10_000): Promise<number> {
	const started = performance.now();
	let lastError: unknown;
	while (performance.now() - started < timeoutMs) {
		try {
			await action();
			return performance.now() - started;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("recovery timed out");
}

describe.runIf(RUN)("publishing infrastructure fault injection", () => {
	let pgProxy: TcpFaultProxy;
	let redisProxy: TcpFaultProxy;

	beforeAll(async () => {
		pgProxy = new TcpFaultProxy(PG_URL.hostname, Number(PG_URL.port));
		redisProxy = new TcpFaultProxy(REDIS_URL.hostname, Number(REDIS_URL.port));
		await Promise.all([pgProxy.start(), redisProxy.start()]);
	});

	afterAll(async () => Promise.all([pgProxy.close(), redisProxy.close()]));

	test("PostgreSQL fails during a real socket interruption and recovers without recreating the client", async () => {
		const url = new URL(PG_URL);
		url.hostname = "127.0.0.1";
		url.port = String(pgProxy.port);
		const client = new PostgresClient({ url: url.toString(), max: 1, connectTimeoutSeconds: 1, backoff: false });
		await client.ping();
		pgProxy.interrupt();
		await expect(client.ping()).rejects.toBeDefined();
		pgProxy.restore();
		const recoveryMs = await eventually(() => client.ping());
		console.log(`[fault] postgres recoveredMs=${recoveryMs.toFixed(1)}`);
		await client.close();
	});

	test("Redis fails closed during a real socket interruption and recovers without recreating the client", async () => {
		const url = new URL(REDIS_URL);
		url.hostname = "127.0.0.1";
		url.port = String(redisProxy.port);
		const client = new RedisClient({ url: url.toString(), connectTimeoutMs: 1000, maxRetriesPerRequest: 0 });
		await client.ping();
		redisProxy.interrupt();
		await expect(client.ping()).rejects.toBeDefined();
		redisProxy.restore();
		const recoveryMs = await eventually(() => client.ping());
		console.log(`[fault] redis recoveredMs=${recoveryMs.toFixed(1)}`);
		await client.close();
	});
});

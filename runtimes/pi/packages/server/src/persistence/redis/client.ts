/**
 * Lazily-initialised Redis client wrapper (ioredis).
 *
 * The underlying client is created with `lazyConnect`; the first `ping` or
 * `run` call triggers the connection. `close()` is idempotent and prefers a
 * graceful `quit` with a bounded timeout, falling back to `disconnect`.
 * Errors are sanitised so the connection URL (and any password inside it)
 * never leaks into logs or client-visible messages.
 */
import { Redis } from "ioredis";

export interface RedisClientOptions {
	/** Redis connection URL, e.g. `redis://:password@127.0.0.1:6379/0`. */
	readonly url: string;
	/** Connect timeout in milliseconds. Defaults to 5000. */
	readonly connectTimeoutMs?: number;
	/** Max retries per request before failing. Defaults to 1. */
	readonly maxRetriesPerRequest?: number;
}

export class RedisClient {
	private readonly url: string;
	private readonly connectTimeoutMs: number;
	private readonly maxRetriesPerRequest: number;
	private client: Redis | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(options: RedisClientOptions) {
		const url = options.url.trim();
		if (url === "") {
			throw new Error("Redis client requires a non-empty connection URL");
		}
		this.url = url;
		this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
		this.maxRetriesPerRequest = options.maxRetriesPerRequest ?? 1;
	}

	/** Lazily create (or return the existing) `Redis` handle. */
	get handle(): Redis {
		if (this.closed) {
			throw new Error("Redis client is closed");
		}
		if (this.client === undefined) {
			const client = new Redis(this.url, {
				lazyConnect: true,
				connectTimeout: this.connectTimeoutMs,
				maxRetriesPerRequest: this.maxRetriesPerRequest,
				enableOfflineQueue: false,
				retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 500)),
			});
			// Connection errors surface through the command promises; without a
			// listener ioredis would raise an unhandled 'error' event.
			client.on("error", () => {});
			this.client = client;
		}
		return this.client;
	}

	/** Health check: `PING` must answer `PONG`. */
	async ping(): Promise<void> {
		const reply = await this.run("PING");
		if (reply !== "PONG") {
			throw new Error(`Redis health check failed: unexpected PING reply`);
		}
	}

	/** Run a single command, sanitising any error that crosses the boundary. */
	async run(command: string, ...args: readonly (string | number | Buffer)[]): Promise<unknown> {
		const handle = this.handle;
		try {
			if (handle.status !== "ready" && handle.status !== "connecting") {
				await handle.connect();
			}
			return await handle.call(command, ...args);
		} catch (error) {
			throw this.sanitizeError(error);
		}
	}

	/** Idempotent shutdown: quit gracefully, then force-disconnect on timeout. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.closing === undefined) {
			const handle = this.client;
			this.client = undefined;
			this.closing = (async () => {
				if (handle === undefined) return;
				if (handle.status === "end") return;
				try {
					await handle.quit();
				} catch {
					handle.disconnect();
				}
			})();
		}
		await this.closing;
	}

	private sanitizeError(error: unknown): unknown {
		if (!(error instanceof Error)) return error;
		const message = error.message;
		if (message.includes(this.url)) {
			const redacted = new Error(message.split(this.url).join("[REDACTED]"));
			redacted.stack = undefined;
			return redacted;
		}
		const password = extractPassword(this.url);
		if (password !== null && message.includes(password)) {
			const redacted = new Error(message.split(password).join("[REDACTED]"));
			redacted.stack = undefined;
			return redacted;
		}
		return error;
	}
}

/** Extract the password portion of a `redis://` URL, if present. */
function extractPassword(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.password === "" ? null : parsed.password;
	} catch {
		return null;
	}
}

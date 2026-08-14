/**
 * Lazily-initialised PostgreSQL client wrapper.
 *
 * The underlying `postgres` driver starts its pool as soon as the `Sql` object
 * is constructed, so the wrapper defers creation until the first use
 * (`sql`, `ping`). `close()` is idempotent; after close every operation is
 * rejected. Errors are sanitised so the connection URL (and any password
 * inside it) never leaks into logs or client-visible messages.
 */
import postgres, { type Sql, type TransactionSql } from "postgres";

/**
 * A query parameter accepted by `PostgresClient.run`. JSON columns (jsonb)
 * accept plain objects/arrays: postgres.js serialises them to JSON text at
 * runtime. The union mirrors postgres.js's `SerializableParameter | JSONValue`.
 */
export type SqlParameter =
	| string
	| number
	| boolean
	| null
	| Date
	| Uint8Array
	| readonly unknown[]
	| Record<string, unknown>
	| object;

export interface PostgresClientOptions {
	/** PostgreSQL connection URL, e.g. `postgresql://user:pass@host:5432/db`. */
	readonly url: string;
	/** Max pool connections. Defaults to 10. */
	readonly max?: number;
	/** Connection timeout in seconds. Defaults to 5. */
	readonly connectTimeoutSeconds?: number;
	/** Idle connection timeout in seconds. Defaults to 30. */
	readonly idleTimeoutSeconds?: number;
	/** Whether to back off and retry failed connections. Defaults to true. */
	readonly backoff?: boolean;
	/** Session `search_path` (typically a dedicated schema for tests). */
	readonly searchPath?: string;
}

export class PostgresClient {
	private readonly url: string;
	private readonly max: number;
	private readonly connectTimeoutSeconds: number;
	private readonly idleTimeoutSeconds: number;
	private readonly backoff: boolean;
	private readonly searchPath: string | undefined;
	private sql: Sql | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(options: PostgresClientOptions) {
		const url = options.url.trim();
		if (url === "") {
			throw new Error("Postgres client requires a non-empty connection URL");
		}
		this.url = url;
		this.max = options.max ?? 10;
		this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? 5;
		this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? 30;
		this.backoff = options.backoff ?? true;
		this.searchPath = options.searchPath;
	}

	/** Lazily create (or return the existing) `Sql` handle. */
	get handle(): Sql {
		if (this.closed) {
			throw new Error("Postgres client is closed");
		}
		if (this.sql === undefined) {
			this.sql = postgres(this.url, {
				max: this.max,
				connect_timeout: this.connectTimeoutSeconds,
				idle_timeout: this.idleTimeoutSeconds,
				backoff: this.backoff,
				connection: this.searchPath !== undefined ? { search_path: this.searchPath } : undefined,
				onnotice: () => {},
				onparameter: () => {},
			});
		}
		return this.sql;
	}

	/** Health check: runs `select 1` against the configured database. */
	async ping(): Promise<void> {
		await this.run("select 1");
	}

	/**
	 * Execute a parameterised query through the lazy handle, sanitising any
	 * error so the connection URL never crosses the client boundary.
	 */
	async run(
		query: TemplateStringsArray | string,
		...parameters: readonly SqlParameter[]
	): Promise<readonly Record<string, unknown>[]> {
		const handle = this.handle;
		try {
			const rows = await (Array.isArray(query)
				? handle(query as TemplateStringsArray, ...(parameters as never[]))
				: handle.unsafe(query as string, parameters as unknown as Parameters<typeof handle.unsafe>[1]));
			return rows as readonly Record<string, unknown>[];
		} catch (error) {
			throw this.sanitizeError(error);
		}
	}

	/** Access to the raw driver for repositories that need transactions. */
	withDriver<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
		const handle = this.handle;
		return fn(handle).catch((error: unknown) => {
			throw this.sanitizeError(error);
		});
	}

	/**
	 * Run `fn` inside a single database transaction. `fn` receives the
	 * transaction handle and must use it for every statement; when it throws,
	 * the whole transaction (including any sequence bumps) is rolled back.
	 * Errors are sanitised like `run`.
	 */
	async transaction<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
		const handle = this.handle;
		try {
			return (await handle.begin(fn)) as T;
		} catch (error) {
			throw this.sanitizeError(error);
		}
	}

	/** Idempotent shutdown: ends the pool exactly once. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.closing === undefined) {
			const handle = this.sql;
			this.sql = undefined;
			this.closing = handle
				? handle.end({ timeout: 5 }).catch((error: unknown) => {
						throw this.sanitizeError(error);
					})
				: Promise.resolve();
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

/** Extract the password portion of a `postgresql://` URL, if present. */
function extractPassword(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.password === "" ? null : parsed.password;
	} catch {
		return null;
	}
}

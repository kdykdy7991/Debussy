import { OrchestrationError } from "./contracts.ts";

/** Fixed, content-free codes. Never carry raw MCP responses or credential values. */
export const MCP_RESULT_BLOCKED = "MCP_RESULT_BLOCKED";
export const MCP_AUTH_FAILED = "MCP_AUTH_FAILED";
export const CREDENTIAL_EXPIRED = "CREDENTIAL_EXPIRED";
export const EXECUTION_NOT_AUTHORIZED = "EXECUTION_NOT_AUTHORIZED";
/**
 * Safe generic execution failure for a connection-layer error whose auth status
 * is unknown. It is fatal for the Run but is never reported as an auth failure.
 */
export const CONNECTION_FAILED = "EXECUTION_FAILED";

/** Notified as soon as a fatal hit is recorded for a Run. */
export type McpFatalListener = (code: string) => void;

/**
 * Per-Run fatal signal. Tool errors are normally returned to the model, which may
 * continue and produce a successful report; a hit in the safety boundary must
 * instead terminate the Run with a fixed code.
 */
export class McpRunGuard {
	private readonly fatal = new Map<string, string>();
	private readonly listeners = new Map<string, Set<McpFatalListener>>();

	mark(conversationId: string, code: string): void {
		this.fatal.set(conversationId, code);
		for (const listener of [...(this.listeners.get(conversationId) ?? [])]) {
			try {
				listener(code);
			} catch {
				// A failing waiter must never replace the boundary's own error.
			}
		}
	}

	/** Records a fatal code only when the Run has no more specific cause yet. */
	markIfAbsent(conversationId: string, code: string): void {
		if (this.fatal.has(conversationId)) return;
		this.mark(conversationId, code);
	}

	/** Returns and clears the fatal code for this Run, if any. */
	take(conversationId: string): string | undefined {
		const code = this.fatal.get(conversationId);
		this.fatal.delete(conversationId);
		return code;
	}

	clear(conversationId: string): void {
		this.fatal.delete(conversationId);
	}

	/**
	 * Subscribes to the fatal hits of one Run. The hit is delivered synchronously
	 * with `mark`; the returned function releases the subscription.
	 */
	onFatal(conversationId: string, listener: McpFatalListener): () => void {
		const listeners = this.listeners.get(conversationId) ?? new Set<McpFatalListener>();
		listeners.add(listener);
		this.listeners.set(conversationId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(conversationId);
		};
	}
}

export interface McpTaskBoundary {
	/** Revalidate the assignment and its credential lifetime immediately before a connection. */
	checkFresh(): Promise<void>;
	/** All known Run secrets, used only by the inspector, never sent to a Server or Tool. */
	readonly secrets: readonly string[];
	/** Task-only connection credential; never falls back to a platform MCP secret. */
	connectionCredential(serverId: string, authentication: "none" | "bearer" | "api_key"): string | undefined;
	/** Fail the Run when the remote server rejects its connection credential. */
	authenticationFailed(): void;
	/**
	 * Fail the Run with a safe generic execution error when the connection layer
	 * fails in a way that is not a recognized auth failure. Never mislabels it as
	 * an auth failure and never lets the model turn it into a success report.
	 */
	connectionFailed(): void;
	/** Inspect the unredacted MCP result before it becomes a message, reference or audit record. */
	inspect(content: unknown): void;
}

function encodedForms(secret: string): readonly string[] {
	return [
		secret,
		JSON.stringify(secret).slice(1, -1),
		Buffer.from(secret, "utf8").toString("base64"),
		encodeURIComponent(secret),
	];
}

/**
 * V1 checks the exact secret text plus explicitly supported encodings. It does
 * not promise to detect arbitrary obfuscation. Content that cannot be safely
 * inspected (oversized, binary/resource blocks, unserialisable) is rejected.
 */
export function checkMcpResult(content: unknown, secrets: readonly string[], maxBytes: number): void {
	let text: string;
	try {
		text = JSON.stringify(content);
	} catch {
		throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容无法安全检查");
	}
	if (text === undefined || Buffer.byteLength(text, "utf8") > maxBytes)
		throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容无法安全检查");
	const record = content as { content?: unknown; contents?: unknown };
	if (Array.isArray(record.content)) {
		for (const block of record.content) {
			if (block === null || typeof block !== "object") continue;
			const type = (block as { type?: unknown }).type;
			// Only plain text can be scanned. A missing or binary/resource type is
			// treated as uncheckable instead of being delivered unchecked.
			if (type !== "text") throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容无法安全检查");
		}
	}
	if (Array.isArray(record.contents)) {
		for (const resource of record.contents) {
			if (
				resource === null ||
				typeof resource !== "object" ||
				"blob" in resource ||
				typeof (resource as { text?: unknown }).text !== "string"
			)
				throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容无法安全检查");
		}
	}
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		if (encodedForms(secret).some((form) => form.length > 0 && text.includes(form)))
			throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容未通过安全检查");
	}
}

/** Builds the new-Key boundary from Run-sealed credentials. Returns undefined for legacy Runs. */
export function createTaskBoundary(options: {
	readonly keyId: string | null;
	readonly values: Readonly<Record<string, string>>;
	readonly maxBytes: number;
	readonly guard: McpRunGuard;
	readonly conversationId: string;
	readonly validateCredentials?: () => Promise<void>;
}): McpTaskBoundary | undefined {
	if (options.keyId === null) return undefined;
	const { values, maxBytes, guard, conversationId } = options;
	return {
		secrets: Object.values(values),
		async checkFresh() {
			try {
				await options.validateCredentials?.();
			} catch (error) {
				if (error instanceof OrchestrationError && error.code === CREDENTIAL_EXPIRED)
					guard.mark(conversationId, CREDENTIAL_EXPIRED);
				throw error;
			}
		},
		authenticationFailed() {
			guard.mark(conversationId, MCP_AUTH_FAILED);
		},
		connectionFailed() {
			// A more specific fatal cause (auth rejection or unsafe content) wins.
			guard.markIfAbsent(conversationId, CONNECTION_FAILED);
		},
		connectionCredential(serverId, authentication) {
			if (authentication === "none") return undefined;
			const value = values[`srv:${serverId}:connection`];
			if (value === undefined) {
				guard.mark(conversationId, MCP_AUTH_FAILED);
				throw new OrchestrationError(500, MCP_AUTH_FAILED, "MCP 连接凭据不可用");
			}
			return value;
		},
		inspect(content) {
			try {
				checkMcpResult(content, Object.values(values), maxBytes);
			} catch (error) {
				guard.mark(conversationId, MCP_RESULT_BLOCKED);
				throw error;
			}
		},
	};
}

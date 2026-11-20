/**
 * Sensitive-value redaction for logs (spec 13.3 / 15 / TASK-035).
 *
 * Requirement: operators must be able to diagnose problems without the logs
 * being able to reconstruct credentials or full identities. This module
 * redacts:
 * - credential-bearing query params in URLs: `ticket=`, `key=`, `code=`
 *   (e.g. the one-time WebSocket ticket that appears in the realtime URL);
 * - `Authorization: Bearer <jwt>` headers;
 * - registered secret values (short-lived access token, launch token,
 *   external user id, ...) passed in by callers at runtime.
 *
 * The redaction is word-substring based and applied before any line reaches
 * the underlying sink, so a value can never afterwards appear verbatim.
 */
const REDACTED = "[REDACTED]";

/** Replace credential-bearing query-param values in a URL string. */
export function redactQueryParams(text: string): string {
	return text.replace(
		/([?&](?:ticket|key|code|token|api_key|secret)=)([^&\s"'<>]+)/gi,
		(_match, prefix: string) => `${prefix}${REDACTED}`,
	);
}

/** Redact `Authorization: Bearer <jwt>` (any method header) values. */
export function redactBearerTokens(text: string): string {
	return text.replace(/((?:\b[Aa]uthorization\s*:\s*[Bb]earer\s+))([^\s,;]+)/g, `$1${REDACTED}`);
}

/** Replace each registered secret verbatim with `[REDACTED]`. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret === undefined || secret.length < 4) continue;
		out = out.split(secret).join(REDACTED);
	}
	return out;
}

/** Apply all redaction passes in a stable order. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
	return redactBearerTokens(redactQueryParams(redactSecrets(text, secrets)));
}

/**
 * Keys / value shapes that must never leave the control plane verbatim in a
 * raw LLM payload. Mirrors `session-events.ts`' write-side guard so the admin
 * "view original request" path applies the same boundary on the way out.
 * The stored audit payload itself is never modified.
 */
const SENSITIVE_STRUCTURED_KEYS: readonly string[] = [
	"adminToken",
	"admin_token",
	"accessToken",
	"access_token",
	"launchToken",
	"launch_token",
	"authorization",
	"providerApiKey",
	"provider_api_key",
	"apiKey",
	"api_key",
	"privateKey",
	"private_key",
	"secret",
	"password",
	"externalUserId",
	"external_user_id",
	"visitorId",
	"visitor_id",
];
const SENSITIVE_STRUCTURED_SHAPES: readonly RegExp[] = [
	/^Bearer\s+/i,
	/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
	/^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/^sk-[A-Za-z0-9_-]{16,}$/,
];

/** Recursively replace sensitive values; returns whether anything changed. */
export function redactStructured(value: unknown): { readonly value: unknown; readonly redacted: boolean } {
	let redacted = false;
	const walk = (node: unknown, key: string | undefined): unknown => {
		if (typeof node === "string") {
			if (
				(key !== undefined && SENSITIVE_STRUCTURED_KEYS.includes(key)) ||
				SENSITIVE_STRUCTURED_SHAPES.some((pattern) => pattern.test(node))
			) {
				redacted = true;
				return REDACTED;
			}
			return node;
		}
		if (Array.isArray(node)) return node.map((child) => walk(child, undefined));
		if (node !== null && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
				out[childKey] = walk(child, childKey);
			}
			return out;
		}
		return node;
	};
	return { value: walk(value, undefined), redacted };
}

/** A mutable registry of live secret values to redact (runtime-tracked). */
export interface SecretRegistry {
	register(value: string | undefined): void;
	list(): readonly string[];
}

export function createSecretRegistry(): SecretRegistry {
	const secrets = new Set<string>();
	return {
		register(value) {
			if (value !== undefined && value.length >= 4) secrets.add(value);
		},
		list() {
			return [...secrets];
		},
	};
}

export type LogSink = (line: string) => void;

/**
 * A logging sink wrapper that redacts every line before delegating to the
 * underlying sink. `secrets()` is a live producer so values registered after
 * construction are still redacted.
 */
export function createRedactingSink(sink: LogSink, secrets: () => readonly string[] = () => []): LogSink {
	return (line) => {
		sink(redact(line, secrets()));
	};
}

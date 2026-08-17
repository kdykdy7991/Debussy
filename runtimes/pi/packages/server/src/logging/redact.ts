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

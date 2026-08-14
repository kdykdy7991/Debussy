/**
 * Strict Origin policy (spec 13.1 + TASK-014).
 *
 * Single shared policy function used by every browser-facing entry point:
 * the control plane (allowedOrigins validation on app creation), the embed
 * Exchange endpoint and the Realtime upgrade — never three different matchers.
 *
 * Rules:
 *  - only `http` / `https` schemes; production (non-loopback) hosts must use
 *    HTTPS, with localhost / 127.0.0.1 / ::1 as the explicit MVP exception,
 *  - no path, query, fragment, or userinfo,
 *  - host matching is case-insensitive (canonicalised to lowercase),
 *  - default ports are equivalent (`http://h` === `http://h:80`,
 *    `https://h` === `https://h:443`),
 *  - allowlist entries may use a single-level wildcard `*.sub.example.com`
 *    (sub-domain wildcard) but never a bare `*` or a wildcard TLD (`*.com`),
 *  - `null` origins (sandboxed iframes) and missing Origin headers are
 *    rejected.
 *
 * CSP `frame-ancestors` is generated from the same allowlist so the header
 * and the runtime matcher can never drift apart.
 */
import { URL } from "node:url";

export type OriginScheme = "http" | "https";

export interface StrictOrigin {
	readonly scheme: OriginScheme;
	/** Lowercase hostname without brackets/port. */
	readonly host: string;
	/** Explicit port when present; defaults collapse to null. */
	readonly port: number | null;
	/** Canonical `scheme://host[:port]`. */
	readonly canonical: string;
}

export interface OriginListValidation {
	readonly ok: boolean;
	/** Indexed messages describing the first offending entry, when invalid. */
	readonly errors: readonly string[];
}

const DEFAULT_PORTS: Readonly<Record<OriginScheme, number>> = { http: 80, https: 443 };

/** Loopback hosts allowed to use plain HTTP in MVP. */
export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d{1,3}(\.\d{1,3}){2}$/.test(host);
}

/**
 * Parse and strictly validate one origin string.
 * Returns null for anything that is not a valid, policy-conformant origin.
 */
export function parseStrictOrigin(value: string): StrictOrigin | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const trimmed = value.trim();
	if (trimmed === "null") return null; // sandboxed iframe origin
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username !== "" || url.password !== "") return null; // userinfo
	// Reject any path/query/fragment beyond the empty "/" URL normalises to.
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
	const host = url.hostname.toLowerCase();
	if (host === "") return null;
	const scheme = url.protocol === "https:" ? "https" : "http";
	// Production requires HTTPS; loopback is the explicit exception.
	if (scheme === "http" && !isLoopbackHost(host)) return null;

	// Default ports are equivalent to omitting the port.
	const port = url.port === "" ? null : Number(url.port);
	const effectivePort = port ?? DEFAULT_PORTS[scheme];
	if (effectivePort === DEFAULT_PORTS[scheme]) {
		return { scheme, host, port: null, canonical: `${scheme}://${host}` };
	}
	return { scheme, host, port, canonical: `${scheme}://${host}:${port}` };
}

/**
 * Match a request `Origin` header against the app allowlist.
 * Every allowlist entry is parsed strictly; an invalid entry never matches.
 */
export function originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
	if (origin === undefined || origin === "null") return false;
	const request = parseStrictOrigin(origin);
	if (request === null) return false;
	for (const entry of allowedOrigins) {
		if (entryMatches(entry, request)) return true;
	}
	return false;
}

/**
 * Validate an allowlist (used when creating an app so a bad entry is a 400,
 * not a silent runtime denial). Returns per-entry errors.
 */
export function validateOriginList(list: readonly string[]): OriginListValidation {
	const errors: string[] = [];
	list.forEach((entry, index) => {
		const error = entryError(entry);
		if (error !== null) errors.push(`allowedOrigins[${index}]: ${error}`);
	});
	return { ok: errors.length === 0, errors };
}

/** Strip an optional `https://` prefix and return the wildcard base host. */
function wildcardBase(trimmed: string): string | null {
	if (trimmed.startsWith("*.")) return trimmed.slice(2);
	if (trimmed.startsWith("https://*.")) return trimmed.slice("https://*.".length);
	return null;
}

function entryError(entry: string): string | null {
	if (typeof entry !== "string" || entry.trim() === "") return "must be a non-empty string";
	const trimmed = entry.trim();
	const base = wildcardBase(trimmed);
	const isWildcard = base !== null;
	if (trimmed === "*" || (trimmed.startsWith("*") && !isWildcard)) return "bare wildcards are not allowed";
	const concrete = isWildcard ? `https://${base}` : trimmed;
	const parsed = parseStrictOrigin(concrete);
	if (parsed === null) return "must be a valid http(s) origin without path/userinfo; production hosts require https";
	if (isWildcard) {
		const labels = parsed.host.split(".");
		if (labels.length < 2 || labels.some((label) => label === "")) return "wildcard TLDs are not allowed";
		if (parsed.port !== null) return "wildcard entries must not carry a port";
	}
	return null;
}

/**
 * Does `entry` (possibly a `*.sub.example.com` wildcard) match `request`?
 * `request` is null when validating an entry standalone; entries that would
 * never match anything still validate syntactically via `entryError`.
 */
function entryMatches(entry: string, request: StrictOrigin | null): boolean {
	if (request === null) return false;
	if (typeof entry !== "string") return false;
	const trimmed = entry.trim();
	if (trimmed === "*" || trimmed === "") return false;
	const base = wildcardBase(trimmed);
	if (base !== null) {
		// Only the leading label is wildcarded: `*.example.com` matches
		// `a.example.com` but never `example.com` or `a.b.example.com.evil.com`.
		const parsed = parseStrictOrigin(`https://${base}`);
		if (parsed === null) return false;
		if (request.scheme !== "https") return false;
		const expectedSuffix = `.${parsed.host}`;
		if (request.host === parsed.host) return false;
		return request.host.endsWith(expectedSuffix);
	}
	const parsed = parseStrictOrigin(trimmed);
	if (parsed === null) return false;
	if (parsed.scheme !== request.scheme) return false;
	if (parsed.host !== request.host) return false;
	return parsed.port === request.port; // both defaulted -> null === null
}

/**
 * CSP `frame-ancestors` directive value derived from the same allowlist.
 * `'none'` when the allowlist is empty (nothing may frame the app).
 */
export function buildFrameAncestors(allowedOrigins: readonly string[]): string {
	const sources: string[] = ["'self'"];
	for (const entry of allowedOrigins) {
		if (entryError(entry) !== null) continue;
		if (wildcardBase(entry.trim()) !== null) {
			// CSP host-source supports sub-domain wildcards directly.
			sources.push(entry.trim());
		} else {
			const parsed = parseStrictOrigin(entry);
			if (parsed !== null) sources.push(parsed.canonical);
		}
	}
	if (sources.length === 1) return "frame-ancestors 'none'";
	return `frame-ancestors ${sources.join(" ")}`;
}

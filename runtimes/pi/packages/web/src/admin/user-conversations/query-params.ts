/**
 * Query-parameter helpers for the admin conversations module (MVP-06).
 *
 * The app detail "用户会话" tab jumps to `/conversations?appId=...` and the
 * conversations index reads that filter on mount. Route parsing ignores the
 * query portion (the router uses the path only), so these helpers bridge the
 * hash query string.
 */

/** Reads a query param from the current hash (`#/path?key=value`). Injectable Location for tests. */
export function readInitialQueryParam(key: string, location?: Location): string {
	const loc = location ?? (typeof window !== "undefined" ? window.location : undefined);
	if (loc === undefined) return "";
	const hash = loc.hash ?? "";
	const qIdx = hash.indexOf("?");
	if (qIdx === -1) return "";
	const query = hash.slice(qIdx + 1);
	return new URLSearchParams(query).get(key) ?? "";
}

/** Builds the conversations route with an `appId` prefilter. */
export function adminConversationsPath(appId: string): string {
	return `/conversations?appId=${encodeURIComponent(appId)}`;
}

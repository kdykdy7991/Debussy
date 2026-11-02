/**
 * TASK-014: Strict Origin policy (spec 13.1).
 *
 * Case-insensitivity, default-port equivalence, sub-domain wildcard only,
 * `null` origin rejection, malformed URLs, HTTP and HTTPS support,
 * allow/deny matching, and CSP frame-ancestors
 * generation — all from the single shared policy module.
 */
import { describe, expect, test } from "vitest";
import {
	buildFrameAncestors,
	isLoopbackHost,
	originAllowed,
	parseStrictOrigin,
	validateOriginList,
} from "../../src/embed/auth/origin.ts";

describe("parseStrictOrigin", () => {
	test("parses a canonical https origin", () => {
		const parsed = parseStrictOrigin("https://project-a.example.com");
		expect(parsed).toEqual({
			scheme: "https",
			host: "project-a.example.com",
			port: null,
			canonical: "https://project-a.example.com",
		});
	});

	test("host is case-insensitive and canonicalised to lowercase", () => {
		const parsed = parseStrictOrigin("HTTPS://Project-A.Example.COM");
		expect(parsed?.host).toBe("project-a.example.com");
		expect(parsed?.canonical).toBe("https://project-a.example.com");
	});

	test("default ports collapse to portless canonical form", () => {
		expect(parseStrictOrigin("https://example.com:443")?.canonical).toBe("https://example.com");
		expect(parseStrictOrigin("https://example.com")?.canonical).toBe("https://example.com");
	});

	test("explicit non-default ports are preserved", () => {
		const parsed = parseStrictOrigin("https://example.com:8443");
		expect(parsed?.port).toBe(8443);
		expect(parsed?.canonical).toBe("https://example.com:8443");
	});

	test("http is accepted for non-loopback hosts", () => {
		expect(parseStrictOrigin("http://project-a.example.com")?.canonical).toBe("http://project-a.example.com");
		expect(parseStrictOrigin("http://10.113.114.88:8003")?.canonical).toBe("http://10.113.114.88:8003");
	});

	test("http is allowed for loopback hosts", () => {
		expect(parseStrictOrigin("http://localhost:5173")?.canonical).toBe("http://localhost:5173");
		expect(parseStrictOrigin("http://127.0.0.1:5173")?.canonical).toBe("http://127.0.0.1:5173");
		expect(parseStrictOrigin("http://[::1]:5173")?.host).toBe("[::1]");
	});

	test("non-loopback HTTP still requires an exact allowlist match", () => {
		expect(validateOriginList(["http://10.113.114.88:8003", "http://127.0.0.1:5173"]).ok).toBe(true);
		expect(originAllowed("http://10.113.114.88:8003", ["http://10.113.114.88:8003"])).toBe(true);
		expect(originAllowed("http://10.113.114.88:8004", ["http://10.113.114.88:8003"])).toBe(false);
		expect(originAllowed("http://10.113.114.89:8003", ["http://10.113.114.88:8003"])).toBe(false);
		expect(parseStrictOrigin("http://10.113.114.88:8003/path")).toBeNull();
	});

	test("rejects paths, query, fragment and userinfo", () => {
		expect(parseStrictOrigin("https://example.com/path")).toBeNull();
		expect(parseStrictOrigin("https://example.com/?q=1")).toBeNull();
		expect(parseStrictOrigin("https://example.com/#frag")).toBeNull();
		expect(parseStrictOrigin("https://user:pass@example.com")).toBeNull();
		expect(parseStrictOrigin("https://user@example.com")).toBeNull();
	});

	test("rejects null origins, other schemes and malformed input", () => {
		expect(parseStrictOrigin("null")).toBeNull();
		expect(parseStrictOrigin("ftp://example.com")).toBeNull();
		expect(parseStrictOrigin("not a url")).toBeNull();
		expect(parseStrictOrigin("")).toBeNull();
		expect(parseStrictOrigin("https://")).toBeNull();
	});
});

describe("isLoopbackHost", () => {
	test("recognises localhost, 127.0.0.0/8 and ::1", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127.8.8.8")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("example.com")).toBe(false);
		expect(isLoopbackHost("127.0.0")).toBe(false);
	});
});

describe("originAllowed", () => {
	const allowlist = ["https://project-a.example.com", "https://*.internal.example.com", "http://localhost:5173"];

	test("matches exact origins", () => {
		expect(originAllowed("https://project-a.example.com", allowlist)).toBe(true);
		expect(originAllowed("https://PROJECT-A.EXAMPLE.COM", allowlist)).toBe(true);
	});

	test("rejects non-allowlisted origins", () => {
		expect(originAllowed("https://evil.example.com", allowlist)).toBe(false);
		expect(originAllowed("https://project-b.example.com", allowlist)).toBe(false);
	});

	test("sub-domain wildcard matches children but not the apex or lookalikes", () => {
		expect(originAllowed("https://api.internal.example.com", allowlist)).toBe(true);
		expect(originAllowed("https://internal.example.com", allowlist)).toBe(false);
		expect(originAllowed("https://internal.example.com.evil.com", allowlist)).toBe(false);
	});

	test("explicit HTTP wildcard matches HTTP hosts only", () => {
		expect(validateOriginList(["http://*.internal.example.com"]).ok).toBe(true);
		expect(originAllowed("http://api.internal.example.com", ["http://*.internal.example.com"])).toBe(true);
		expect(originAllowed("https://api.internal.example.com", ["http://*.internal.example.com"])).toBe(false);
	});

	test("ports must match exactly", () => {
		expect(originAllowed("http://localhost:5173", allowlist)).toBe(true);
		expect(originAllowed("http://localhost:8080", allowlist)).toBe(false);
	});

	test("default-port equivalence holds in matching", () => {
		expect(originAllowed("https://project-a.example.com:443", ["https://project-a.example.com"])).toBe(true);
	});

	test("rejects null, missing and malformed origins", () => {
		expect(originAllowed("null", allowlist)).toBe(false);
		expect(originAllowed(undefined, allowlist)).toBe(false);
		expect(originAllowed("https://project-a.example.com/path", allowlist)).toBe(false);
		expect(originAllowed("", allowlist)).toBe(false);
	});

	test("an empty allowlist denies everything", () => {
		expect(originAllowed("https://project-a.example.com", [])).toBe(false);
	});
});

describe("validateOriginList", () => {
	test("accepts valid entries", () => {
		const result = validateOriginList([
			"https://a.example.com",
			"https://*.sub.example.com",
			"http://localhost:5173",
			"http://10.113.114.88:8003",
		]);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("rejects bare wildcards, wildcard TLDs and ports on wildcards", () => {
		expect(validateOriginList(["*"]).ok).toBe(false);
		expect(validateOriginList(["https://*.com"]).ok).toBe(false);
		expect(validateOriginList(["https://*.example.com:8443"]).ok).toBe(false);
	});

	test("rejects paths, userinfo and junk", () => {
		expect(validateOriginList(["https://a.example.com/x"]).ok).toBe(false);
		expect(validateOriginList(["https://u@a.example.com"]).ok).toBe(false);
		expect(validateOriginList(["junk"]).ok).toBe(false);
		expect(validateOriginList([""]).ok).toBe(false);
	});
});

describe("buildFrameAncestors", () => {
	test("produces frame-ancestors 'none' for an empty allowlist", () => {
		expect(buildFrameAncestors([])).toBe("frame-ancestors 'none'");
	});

	test("lists self plus the canonical allowlist origins", () => {
		const header = buildFrameAncestors(["https://project-a.example.com", "http://localhost:5173"]);
		expect(header).toBe("frame-ancestors 'self' https://project-a.example.com http://localhost:5173");
	});

	test("keeps sub-domain wildcards for CSP", () => {
		const header = buildFrameAncestors(["https://*.internal.example.com", "http://*.internal.example.com"]);
		expect(header).toBe("frame-ancestors 'self' https://*.internal.example.com http://*.internal.example.com");
	});

	test("drops invalid entries instead of weakening the policy", () => {
		const header = buildFrameAncestors(["https://ok.example.com", "junk", "https://u@x.example.com"]);
		expect(header).toBe("frame-ancestors 'self' https://ok.example.com");
	});
});

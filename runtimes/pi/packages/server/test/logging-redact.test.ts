/**
 * TASK-035：日志脱敏单测（spec 13.3 / 15）。
 *
 * 覆盖：URL 中凭据 query（ticket/key/code/token/api_key）脱敏；Authorization
 * Bearer 头脱敏；运行时注册的敏感值（Access Token / Launch Token /
 * externalUserId / visitorId）逐字脱敏；短值（<4 字符）不替换（避免把普通
 * 词打码）；**注入测试**：把一批敏感字符串拼进日志行后扫描，不得出现任何
 * 明文凭据。
 */
import { describe, expect, test } from "vitest";
import {
	createRedactingSink,
	createSecretRegistry,
	redact,
	redactBearerTokens,
	redactQueryParams,
} from "../src/logging/redact.ts";

describe("log redaction", () => {
	test("redacts credential-bearing URL query params", () => {
		const line = "connecting to ws://x/realtime?ticket=onetime&key=abc123&code=zzz&id=3";
		const out = redactQueryParams(line);
		expect(out).not.toContain("onetime");
		expect(out).not.toContain("abc123");
		expect(out).not.toContain("zzz");
		expect(out).toContain("ticket=[REDACTED]");
		expect(out).toContain("id=3");
	});

	test("redacts Authorization Bearer headers", () => {
		const line = "request Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload done";
		expect(redactBearerTokens(line)).toContain("Bearer [REDACTED]");
		expect(redactBearerTokens(line)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});

	test("registers runtime secret values and redacts them verbatim", () => {
		const out = redact("issued access token jwt-aaaaaaaa-1111 visitor zzzzzzzzzz ext extUser-x", [
			"jwt-aaaaaaaa-1111",
			"zzzzzzzzzz",
			"extUser-x",
		]);
		expect(out).toContain("[REDACTED]");
		expect(out).not.toContain("jwt-aaaaaaaa-1111");
		expect(out).not.toContain("zzzzzzzzzz");
		expect(out).not.toContain("extUser-x");
	});

	test("short secrets (<4 chars) are not replaced", () => {
		expect(redact("word abc word", ["abc"])).toBe("word abc word");
	});

	test("injection scan: sensitive strings never survive a redacting sink", () => {
		const leaked = `token=abc`,
			ticket = "ticket_tok_xyz";
		const secrets = createSecretRegistry();
		for (const value of [leaked, ticket, "jwt-signature.payload."]) secrets.register(value);
		const observed: string[] = [];
		const sink = createRedactingSink(
			(line) => observed.push(line),
			() => secrets.list(),
		);
		sink(`exchange ok token=abc ticket=ticket_tok_xyz Authorization: Bearer jwt-signature.payload. token=abc`);
		const joined = observed.join("\n");
		expect(joined).not.toContain("ticket_tok_xyz");
		expect(joined).not.toContain("jwt-signature.payload.");
		// query param `token=` is redacted by the query layer even though token
		// isn't in SENSITIVE_QUERY_PARAMS (Bearer handled separately).
		expect(joined).not.toContain("=abc");
	});
});

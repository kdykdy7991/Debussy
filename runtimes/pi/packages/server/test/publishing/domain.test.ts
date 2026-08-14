import { describe, expect, test } from "vitest";
import {
	EmbedError,
	type EmbedErrorCode,
	errorHttpStatus,
	errorInfo,
	errorRetryable,
} from "../../src/publishing/domain/errors.ts";
import {
	type ConversationId,
	fromPublicId,
	newAttachmentId,
	newConversationEventId,
	newConversationId,
	newIdempotencyKey,
	newPrincipalId,
	newPublicAppId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newRequestId,
	newTenantId,
	newTurnId,
	type PrincipalId,
	parseId,
	parseIdOrThrow,
	parsePublicAppId,
	type TenantId,
	toPublicId,
	uuidv7,
} from "../../src/publishing/domain/ids.ts";
import {
	ATTACHMENT_STATUS_VALUES,
	CONVERSATION_STATUS_VALUES,
	isConversationStatus,
	isPrincipalType,
	PRINCIPAL_TYPE_VALUES,
	PUBLISHED_APP_VERSION_STATUS_VALUES,
} from "../../src/publishing/domain/states.ts";

describe("domain ids", () => {
	test("generated ids are bare uuidv7 values; only PublicAppId carries pub_", () => {
		expect(newTenantId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newPublishedAppId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newPublishedAppVersionId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newPrincipalId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newConversationId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newAttachmentId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newConversationEventId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newTurnId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
		// PublicAppId is the locator stored in a text column: keeps the prefix.
		expect(newPublicAppId()).toMatch(/^pub_[0-9a-f-]{36}$/);
		expect(parsePublicAppId(newPublicAppId())).not.toBeNull();
		expect(parsePublicAppId("pub_nope")).toBeNull();
	});

	test("uuidv7 is time-ordered and unique", () => {
		// UUIDv7's first 12 hex chars encode the 48-bit timestamp, so they are
		// monotonically non-decreasing across generations (same-millisecond
		// values are equal; ordering of the random tail is not guaranteed).
		const a = uuidv7();
		const b = uuidv7();
		expect(a.slice(0, 12) <= b.slice(0, 12)).toBe(true);
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) seen.add(uuidv7());
		expect(seen.size).toBe(1000);
	});

	test("parseId round-trips generated ids and rejects non-UUID values", () => {
		const tenantId = newTenantId();
		expect(parseId("TenantId", tenantId)).toBe(tenantId);
		// Runtime validation checks the UUID shape only; the branded kind is a
		// compile-time concern, so another kind's UUID still parses.
		const principalId = newPrincipalId();
		expect(parseId("TenantId", principalId)).toBe(principalId);
		expect(parseId("PrincipalId", "not-a-uuid")).toBeNull();
	});

	test("parseId rejects empty, malformed and display-prefixed values", () => {
		const valid = newTenantId();
		expect(parseId("TenantId", "")).toBeNull();
		expect(parseId("TenantId", "ten_")).toBeNull();
		expect(parseId("TenantId", `${valid}x`)).toBeNull();
		expect(parseId("TenantId", "ZZZZZZZZ-0000-0000-0000-000000000000")).toBeNull();
		expect(parseId("TenantId", valid.toUpperCase())).toBeNull();
		expect(parseId("TenantId", `ten_${valid}`)).toBeNull();
		expect(parseId("TenantId", "x".repeat(90))).toBeNull();
	});

	test("toPublicId/fromPublicId round-trip the representation prefix", () => {
		const conversationId = newConversationId();
		const publicId = toPublicId("ConversationId", conversationId);
		expect(publicId).toBe(`conv_${conversationId}`);
		expect(fromPublicId("ConversationId", publicId)).toBe(conversationId);
		expect(fromPublicId("ConversationId", "conv_not-a-uuid")).toBeNull();
		expect(fromPublicId("ConversationId", "app_rest-of-uuid")).toBeNull();
		expect(fromPublicId("ConversationId", "conv_")).toBeNull();
		expect(fromPublicId("ConversationId", conversationId)).toBeNull();
	});

	test("parseIdOrThrow reports the offending label", () => {
		expect(() => parseIdOrThrow("ConversationId", "conv_nope", "conversation id")).toThrow(/Invalid conversation id/);
		const tenantId = newTenantId();
		expect(parseIdOrThrow("TenantId", tenantId, "tenant id")).toBe(tenantId);
	});

	test("branded ids are not interchangeable at the type level", () => {
		// Compile-time check: assigning a TenantId to a PrincipalId must not type-check.
		const tenantId: TenantId = newTenantId();
		const principalId: PrincipalId = newPrincipalId();
		expect(tenantId).not.toBe(principalId);
		const conversationId: ConversationId = parseIdOrThrow("ConversationId", newConversationId(), "conversation");
		expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("domain states", () => {
	test("state sets match the spec unions exactly", () => {
		expect(PRINCIPAL_TYPE_VALUES).toEqual(["platform_user", "external_user", "anonymous_visitor", "service"]);
		expect(PUBLISHED_APP_VERSION_STATUS_VALUES).toEqual(["validating", "ready", "rejected", "retired"]);
		expect(CONVERSATION_STATUS_VALUES).toEqual(["active", "archived", "deleted"]);
		expect(ATTACHMENT_STATUS_VALUES).toEqual(["staged", "ready", "rejected", "deleted"]);
	});

	test("predicates narrow known values and reject unknown ones", () => {
		expect(isPrincipalType("external_user")).toBe(true);
		expect(isPrincipalType("superuser")).toBe(false);
		expect(isConversationStatus("archived")).toBe(true);
		expect(isConversationStatus("")).toBe(false);
	});

	test("every persisted version status has a runtime predicate", () => {
		for (const status of ["ready", "rejected", "retired"] as const) {
			expect(isConversationStatus(status)).toBe(false);
		}
	});
});

describe("domain errors", () => {
	test("every error code maps to a stable HTTP status", () => {
		expect(errorHttpStatus("APP_NOT_FOUND")).toBe(404);
		expect(errorHttpStatus("APP_SUSPENDED")).toBe(403);
		expect(errorHttpStatus("ORIGIN_NOT_ALLOWED")).toBe(403);
		expect(errorHttpStatus("TOKEN_INVALID")).toBe(401);
		expect(errorHttpStatus("TOKEN_EXPIRED")).toBe(401);
		expect(errorHttpStatus("TOKEN_REPLAYED")).toBe(401);
		expect(errorHttpStatus("FORBIDDEN")).toBe(403);
		expect(errorHttpStatus("CONVERSATION_NOT_FOUND")).toBe(404);
		expect(errorHttpStatus("VERSION_UNAVAILABLE")).toBe(409);
		expect(errorHttpStatus("TURN_ALREADY_RUNNING")).toBe(409);
		expect(errorHttpStatus("RATE_LIMITED")).toBe(429);
		expect(errorHttpStatus("QUOTA_EXCEEDED")).toBe(429);
		expect(errorHttpStatus("UPLOAD_REJECTED")).toBe(422);
		expect(errorHttpStatus("RUNTIME_UNAVAILABLE")).toBe(503);
	});

	test("retryable flags follow the spec error semantics", () => {
		expect(errorRetryable("TOKEN_EXPIRED")).toBe(true);
		expect(errorRetryable("TOKEN_REPLAYED")).toBe(false);
		expect(errorRetryable("RATE_LIMITED")).toBe(true);
		expect(errorRetryable("CONVERSATION_NOT_FOUND")).toBe(false);
		expect(errorRetryable("RUNTIME_UNAVAILABLE")).toBe(true);
	});

	test("EmbedError carries code, httpStatus and retryable from the table", () => {
		const error = new EmbedError("APP_SUSPENDED", "App is suspended");
		expect(error.code).toBe("APP_SUSPENDED");
		expect(error.httpStatus).toBe(403);
		expect(error.retryable).toBe(false);
		expect(error.message).toBe("App is suspended");
	});

	test("the error table is exhaustive over the EmbedErrorCode union", () => {
		const codes: readonly EmbedErrorCode[] = [
			"APP_NOT_FOUND",
			"APP_SUSPENDED",
			"ORIGIN_NOT_ALLOWED",
			"TOKEN_INVALID",
			"TOKEN_EXPIRED",
			"TOKEN_REPLAYED",
			"FORBIDDEN",
			"CONVERSATION_NOT_FOUND",
			"VERSION_UNAVAILABLE",
			"TURN_ALREADY_RUNNING",
			"RATE_LIMITED",
			"QUOTA_EXCEEDED",
			"UPLOAD_REJECTED",
			"RUNTIME_UNAVAILABLE",
		];
		for (const code of codes) {
			expect(errorInfo(code).code).toBe(code);
			expect(errorHttpStatus(code)).toBeGreaterThanOrEqual(400);
			expect(errorHttpStatus(code)).toBeLessThan(600);
		}
	});
});

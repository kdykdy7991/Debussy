/**
 * Stable error codes and HTTP mapping for the publishing/embed planes
 * (spec section 8.3 and 27.7).
 *
 * Every embed error has a stable machine-readable code, an HTTP status and a
 * retryable flag. Error responses must never leak whether a resource belongs
 * to another principal: cross-scope access is reported with the same
 * "resource unavailable" code the owner would see for a missing resource.
 */
import type { IdempotencyKey, RequestId } from "./ids.ts";

export type EmbedErrorCode =
	| "APP_NOT_FOUND"
	| "APP_SUSPENDED"
	| "ORIGIN_NOT_ALLOWED"
	| "TOKEN_INVALID"
	| "TOKEN_EXPIRED"
	| "TOKEN_REPLAYED"
	| "FORBIDDEN"
	| "CONVERSATION_NOT_FOUND"
	| "VERSION_UNAVAILABLE"
	| "TURN_ALREADY_RUNNING"
	| "RATE_LIMITED"
	| "QUOTA_EXCEEDED"
	| "UPLOAD_REJECTED"
	| "RUNTIME_UNAVAILABLE";

export interface EmbedErrorInfo {
	readonly code: EmbedErrorCode;
	readonly httpStatus: number;
	readonly retryable: boolean;
}

const ERROR_TABLE: Readonly<Record<EmbedErrorCode, EmbedErrorInfo>> = {
	APP_NOT_FOUND: { code: "APP_NOT_FOUND", httpStatus: 404, retryable: false },
	APP_SUSPENDED: { code: "APP_SUSPENDED", httpStatus: 403, retryable: false },
	ORIGIN_NOT_ALLOWED: { code: "ORIGIN_NOT_ALLOWED", httpStatus: 403, retryable: false },
	TOKEN_INVALID: { code: "TOKEN_INVALID", httpStatus: 401, retryable: false },
	TOKEN_EXPIRED: { code: "TOKEN_EXPIRED", httpStatus: 401, retryable: true },
	TOKEN_REPLAYED: { code: "TOKEN_REPLAYED", httpStatus: 401, retryable: false },
	FORBIDDEN: { code: "FORBIDDEN", httpStatus: 403, retryable: false },
	CONVERSATION_NOT_FOUND: { code: "CONVERSATION_NOT_FOUND", httpStatus: 404, retryable: false },
	VERSION_UNAVAILABLE: { code: "VERSION_UNAVAILABLE", httpStatus: 409, retryable: false },
	TURN_ALREADY_RUNNING: { code: "TURN_ALREADY_RUNNING", httpStatus: 409, retryable: true },
	RATE_LIMITED: { code: "RATE_LIMITED", httpStatus: 429, retryable: true },
	QUOTA_EXCEEDED: { code: "QUOTA_EXCEEDED", httpStatus: 429, retryable: true },
	UPLOAD_REJECTED: { code: "UPLOAD_REJECTED", httpStatus: 422, retryable: false },
	RUNTIME_UNAVAILABLE: { code: "RUNTIME_UNAVAILABLE", httpStatus: 503, retryable: true },
};

export function errorInfo(code: EmbedErrorCode): EmbedErrorInfo {
	return ERROR_TABLE[code];
}

export function errorHttpStatus(code: EmbedErrorCode): number {
	return ERROR_TABLE[code].httpStatus;
}

export function errorRetryable(code: EmbedErrorCode): boolean {
	return ERROR_TABLE[code].retryable;
}

/** Error carrying a stable embed error code for HTTP/realtime responses. */
export class EmbedError extends Error {
	readonly code: EmbedErrorCode;
	readonly httpStatus: number;
	readonly retryable: boolean;
	/** Populated by the request pipeline before the error crosses a boundary. */
	requestId: RequestId | undefined;
	/** Client-supplied idempotency key when known; echoed back for correlation. */
	idempotencyKey: IdempotencyKey | undefined;

	constructor(code: EmbedErrorCode, message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = "EmbedError";
		this.code = code;
		this.httpStatus = ERROR_TABLE[code].httpStatus;
		this.retryable = ERROR_TABLE[code].retryable;
	}
}

/** Convenience constructors for the most common embed errors. */
export function appNotFound(message = "App is unavailable"): EmbedError {
	return new EmbedError("APP_NOT_FOUND", message);
}
export function appSuspended(message = "App is suspended"): EmbedError {
	return new EmbedError("APP_SUSPENDED", message);
}
export function originNotAllowed(message = "Origin is not allowed"): EmbedError {
	return new EmbedError("ORIGIN_NOT_ALLOWED", message);
}
export function tokenInvalid(message = "Token is invalid"): EmbedError {
	return new EmbedError("TOKEN_INVALID", message);
}
export function tokenExpired(message = "Token has expired"): EmbedError {
	return new EmbedError("TOKEN_EXPIRED", message);
}
export function tokenReplayed(message = "Token was already used"): EmbedError {
	return new EmbedError("TOKEN_REPLAYED", message);
}
export function forbidden(message = "Forbidden"): EmbedError {
	return new EmbedError("FORBIDDEN", message);
}
export function conversationNotFound(message = "Conversation is unavailable"): EmbedError {
	return new EmbedError("CONVERSATION_NOT_FOUND", message);
}
export function versionUnavailable(message = "Version is unavailable"): EmbedError {
	return new EmbedError("VERSION_UNAVAILABLE", message);
}
export function turnAlreadyRunning(message = "A turn is already running for this conversation"): EmbedError {
	return new EmbedError("TURN_ALREADY_RUNNING", message);
}
export function rateLimited(message = "Rate limit exceeded"): EmbedError {
	return new EmbedError("RATE_LIMITED", message);
}
export function quotaExceeded(message = "Quota exceeded"): EmbedError {
	return new EmbedError("QUOTA_EXCEEDED", message);
}
export function uploadRejected(message = "Upload rejected"): EmbedError {
	return new EmbedError("UPLOAD_REJECTED", message);
}
export function runtimeUnavailable(message = "Runtime is temporarily unavailable"): EmbedError {
	return new EmbedError("RUNTIME_UNAVAILABLE", message);
}

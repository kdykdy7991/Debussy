/**
 * Control-plane HTTP API (spec 27.1-27.3, 33.2, 33.3; TASK-013).
 *
 * Mounted on the existing loopback WebSocket listener's HTTP handler; the
 * reverse proxy terminates public TLS. Every control route requires
 * `Authorization: Bearer <platform-admin-token>` (constant-time comparison,
 * spec 33.2); a missing/invalid token is a uniform 401 that leaks nothing.
 *
 * All write operations accept `Idempotency-Key` and are replayed from the
 * idempotency store when the same key + request hash repeats (spec 8.3/9.3).
 * Every response carries a `requestId` (echoed in the `X-Request-Id` header
 * and the body) and errors follow the uniform envelope
 * `{ error: { code, message, requestId, retryable } }` — never leaking
 * whether a resource belongs to another tenant.
 *
 * The handler is a thin adapter over `ControlService`: it owns HTTP concerns
 * (parsing, auth, routing, idempotency, envelopes) and the service owns
 * business rules. The bootstrap tenant (33.1) is injected at construction and
 * every operation maps to it.
 */
import type { IncomingMessage } from "node:http";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import { jsonBody } from "../../web/http-shared.ts";
import type { PrincipalId, PublishedAppId, TenantId } from "../domain/ids.ts";
import { fromPublicId, newRequestId, toPublicId } from "../domain/ids.ts";
import type { AccessMode } from "../domain/states.ts";
import type { IdempotencyScope, PublishedAppRecord, PublishingRepositories } from "../repositories.ts";
import type { ControlService, CurrentAgentDefinitionSource } from "./service.ts";
import { secureEqual } from "./token.ts";

export const CONTROL_API_PREFIX = "/api/control/v1";

/** Default cap for a control request body (1 MiB); oversized -> 413. */
export const CONTROL_MAX_BODY_BYTES = 1024 * 1024;
/** Idempotency slot TTL for control writes. */
export const CONTROL_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

export interface ControlHttpHandlerOptions {
	readonly service: ControlService;
	readonly repositories: PublishingRepositories;
	/** Platform admin token (spec 33.2); compared in constant time. */
	readonly adminToken: string;
	/** Every control operation maps to this bootstrap tenant (spec 33.1). */
	readonly tenantId: TenantId;
	/** Collects the current agent configuration for import-current (33.3). */
	readonly source: CurrentAgentDefinitionSource;
	readonly idempotencyTtlMs?: number;
	readonly maxBodyBytes?: number;
	readonly onError?: (error: unknown) => void;
}

interface Route {
	readonly method: "POST";
	readonly pattern: RegExp;
	readonly operation: string;
	readonly handler: (ctx: {
		requestId: string;
		body: unknown;
		appId?: string;
	}) => Promise<{ status: number; body: unknown }>;
}

interface Envelope {
	readonly status: number;
	readonly body: unknown;
}

/** Body shape validation failure: mapped to a 400 by the dispatcher. */
class HttpValidationError extends Error {}

/**
 * Build the control-plane HTTP handler. Routes under `CONTROL_API_PREFIX`
 * are claimed; anything else falls through to the next handler.
 */
export function createControlHttpHandler(options: ControlHttpHandlerOptions): HttpRequestHandler {
	const maxBodyBytes = options.maxBodyBytes ?? CONTROL_MAX_BODY_BYTES;
	const idempotencyTtlMs = options.idempotencyTtlMs ?? CONTROL_IDEMPOTENCY_TTL_MS;
	const tenantId = options.tenantId;
	const service = options.service;
	const repos = options.repositories;
	// 33.1: the control principal of a tenant IS the tenant (platform service
	// principal id = tenantId), so the idempotency/audit scope is the tenant.
	// 33.1: the control principal of a tenant IS the tenant (platform service
	// principal id = tenantId), so the idempotency/audit scope is the tenant.
	const idempotencyScope: IdempotencyScope = { tenantId, principalId: tenantId as unknown as PrincipalId };

	const routes: readonly Route[] = [
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/agent-definitions\/import-current$/,
			operation: "agent-definitions.import-current",
			handler: async ({ requestId, body }) => {
				const parsed = parseBody(body, { name: "string", expectedSourceHash: ["string", "null"] });
				const expectedSourceHash = parsed.expectedSourceHash;
				const imported = await service.importAgent(
					{
						tenantId,
						expectedSourceHash:
							expectedSourceHash === undefined ? undefined : (expectedSourceHash as string | null),
					},
					options.source,
				);
				if (!imported.ok) return serviceError(imported.error, requestId);
				return {
					status: 201,
					body: {
						data: {
							agentDefinitionId: toPublicId("AgentDefinitionId", imported.data.agentDefinitionId),
							revision: imported.data.revision,
							sourceHash: imported.data.sourceHash,
							warnings: imported.data.warnings,
						},
						requestId,
					},
				};
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps$/,
			operation: "published-apps.create",
			handler: async ({ requestId, body }) => {
				const parsed = parseBody(body, {
					agentDefinitionId: "string",
					name: "string",
					accessMode: "string",
					allowedOrigins: ["array", "undefined"],
					theme: ["object", "undefined"],
				});
				const agentDefinitionId = fromPublicId("AgentDefinitionId", parsed.agentDefinitionId as string);
				if (agentDefinitionId === null) {
					return badRequest("agentDefinitionId must be a bare agent_<uuid> id", requestId);
				}
				const accessMode = parsed.accessMode as AccessMode;
				if (accessMode !== "anonymous" && accessMode !== "signed_user" && accessMode !== "mixed") {
					return badRequest("accessMode must be anonymous | signed_user | mixed", requestId);
				}
				const allowedOrigins = parsed.allowedOrigins;
				const theme = parsed.theme;
				const created = await service.createPublishedApp({
					tenantId,
					agentDefinitionId,
					name: parsed.name as string,
					accessMode,
					allowedOrigins: allowedOrigins === undefined ? undefined : (allowedOrigins as readonly string[]),
					theme: theme === undefined ? undefined : (theme as { primaryColor?: string; welcomeMessage?: string }),
				});
				if (!created.ok) return serviceError(created.error, requestId);
				return {
					status: 201,
					body: {
						data: {
							id: toPublicId("PublishedAppId", created.data.app.publishedAppId),
							publicAppId: created.data.publicAppId,
							status: created.data.app.status,
							currentVersionId:
								created.data.app.currentVersionId === null
									? null
									: toPublicId("PublishedAppVersionId", created.data.app.currentVersionId),
							embedUrl: created.data.embedUrl,
						},
						requestId,
					},
				};
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/versions$/,
			operation: "published-apps.create-version",
			handler: async ({ requestId, body, appId }) => {
				const parsed = parseBody(body, { sourceAgentRevision: "number" });
				const publishedAppId = parseAppId(appId);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const created = await service.createPublishedAppVersion({
					tenantId,
					publishedAppId,
					sourceAgentRevision: parsed.sourceAgentRevision as number,
				});
				if (!created.ok) return serviceError(created.error, requestId);
				const version = created.data.version;
				// A rejected version is still created (for audit) but the API
				// reports 422 + validationErrors (spec 27.2/27.7).
				return {
					status: version.status === "ready" ? 201 : 422,
					body: {
						data: {
							version: {
								id: toPublicId("PublishedAppVersionId", version.publishedAppVersionId),
								versionNumber: version.versionNumber,
								status: version.status,
								sourceAgentRevision: version.sourceAgentRevision,
								validationErrors: version.validationErrors,
							},
						},
						requestId,
					},
				};
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/activate$/,
			operation: "published-apps.activate",
			handler: (ctx) => transition("activate", ctx),
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/rollback$/,
			operation: "published-apps.rollback",
			handler: (ctx) => transition("rollback", ctx),
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/suspend$/,
			operation: "published-apps.suspend",
			handler: async ({ requestId, body, appId }) => {
				const parsed = parseBody(body, { reason: ["string", "undefined"] });
				const publishedAppId = parseAppId(appId);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const reason = parsed.reason;
				const result = await service.suspendApp({
					tenantId,
					publishedAppId,
					reason: reason === undefined ? undefined : (reason as string),
				});
				if (!result.ok) return serviceError(result.error, requestId);
				return {
					status: 200,
					body: {
						data: {
							app: appView(result.data.app),
							auditEventId: toPublicId("AuditEventId", result.data.auditEventId),
						},
						requestId,
					},
				};
			},
		},
	];

	async function transition(
		kind: "activate" | "rollback",
		ctx: { requestId: string; body: unknown; appId?: string },
	): Promise<Envelope> {
		const parsed = parseBody(ctx.body, { versionId: "string" });
		const publishedAppId = parseAppId(ctx.appId);
		if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", ctx.requestId);
		const versionId = fromPublicId("PublishedAppVersionId", parsed.versionId as string);
		if (versionId === null) return badRequest("versionId must be a bare pav_<uuid> id", ctx.requestId);
		const result =
			kind === "activate"
				? await service.activateApp({ tenantId, publishedAppId, versionId })
				: await service.rollbackApp({ tenantId, publishedAppId, versionId });
		if (!result.ok) return serviceError(result.error, ctx.requestId);
		return {
			status: 200,
			body: {
				data: {
					app: appView(result.data.app),
					previousVersionId:
						result.data.previousVersionId === null
							? null
							: toPublicId("PublishedAppVersionId", result.data.previousVersionId),
					auditEventId: toPublicId("AuditEventId", result.data.auditEventId),
				},
				requestId: ctx.requestId,
			},
		};
	}

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || !pathname.startsWith(`${CONTROL_API_PREFIX}/`)) {
			return false;
		}
		try {
			// Auth first: uniform 401 for missing/invalid token (33.2).
			if (!authorized(request, options.adminToken)) {
				jsonBody(response, 401, errorEnvelope("UNAUTHORIZED", "Missing or invalid bearer token", "", false));
				return true;
			}
			const requestId = readRequestId(request);
			response.setHeader("X-Request-Id", requestId);

			const route = routes.find((r) => r.method === request.method && r.pattern.test(pathname));
			if (!route) {
				jsonBody(response, 404, errorEnvelope("NOT_FOUND", "Unknown control route", requestId, false));
				return true;
			}
			const appId = pathname.match(route.pattern)?.[1];

			const raw = await readBody(request, maxBodyBytes);
			if (raw === null) {
				jsonBody(response, 413, errorEnvelope("PAYLOAD_TOO_LARGE", "Request body too large", requestId, false));
				return true;
			}
			let body: unknown;
			try {
				body = raw.length === 0 ? undefined : JSON.parse(raw);
			} catch {
				jsonBody(response, 400, errorEnvelope("INVALID_JSON", "Request body must be valid JSON", requestId, false));
				return true;
			}

			const idempotencyKey = readIdempotencyKey(request);
			const envelope =
				idempotencyKey === undefined
					? await route.handler({ requestId, body, appId })
					: await withIdempotency(route, { requestId, body, appId, idempotencyKey });
			jsonBody(response, envelope.status, envelope.body);
			return true;
		} catch (error) {
			if (error instanceof HttpValidationError) {
				jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", error.message, "", false));
				return true;
			}
			options.onError?.(error);
			if (!response.headersSent) {
				jsonBody(response, 500, errorEnvelope("INTERNAL", "Internal server error", "", true));
			}
			return true;
		}
	};

	async function withIdempotency(
		route: Route,
		ctx: { requestId: string; body: unknown; appId?: string; idempotencyKey: string },
	): Promise<Envelope> {
		const requestHash = hashRequest(route, ctx.body, ctx.appId);
		const began = await repos.idempotency.begin(
			idempotencyScope,
			route.operation,
			ctx.idempotencyKey,
			requestHash,
			idempotencyTtlMs,
		);
		if (began.outcome === "replay") {
			return { status: began.record.responseStatus ?? 200, body: began.record.responseBody };
		}
		if (began.outcome === "conflict") {
			return {
				status: 409,
				body: errorEnvelope(
					"IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different request",
					ctx.requestId,
					false,
				),
			};
		}
		if (began.outcome === "in_progress") {
			return {
				status: 409,
				body: errorEnvelope(
					"IDEMPOTENCY_IN_PROGRESS",
					"A request with this idempotency key is already running",
					ctx.requestId,
					true,
				),
			};
		}
		try {
			const result = await route.handler(ctx);
			await repos.idempotency.complete(
				idempotencyScope,
				route.operation,
				ctx.idempotencyKey,
				result.status,
				result.body,
			);
			return result;
		} catch (error) {
			await repos.idempotency.fail(idempotencyScope, route.operation, ctx.idempotencyKey);
			throw error;
		}
	}
}

function parseAppId(appId: string | undefined): PublishedAppId | null {
	if (appId === undefined) return null;
	return fromPublicId("PublishedAppId", appId);
}

/** View of a published app for API responses (27.1/27.3). */
function appView(app: PublishedAppRecord): {
	id: string;
	publicAppId: string;
	status: string;
	currentVersionId: string | null;
} {
	return {
		id: toPublicId("PublishedAppId", app.publishedAppId),
		publicAppId: app.publicAppId,
		status: app.status,
		currentVersionId:
			app.currentVersionId === null ? null : toPublicId("PublishedAppVersionId", app.currentVersionId),
	};
}

function serviceError(error: { code: string; httpStatus: number; message: string }, requestId: string): Envelope {
	return {
		status: error.httpStatus,
		body: errorEnvelope(error.code, error.message, requestId, error.httpStatus >= 500),
	};
}

function badRequest(message: string, requestId: string): Envelope {
	return { status: 400, body: errorEnvelope("INVALID_REQUEST", message, requestId, false) };
}

function errorEnvelope(
	code: string,
	message: string,
	requestId: string,
	retryable: boolean,
): { error: { code: string; message: string; requestId: string; retryable: boolean } } {
	return { error: { code, message, requestId, retryable } };
}

function authorized(request: IncomingMessage, token: string): boolean {
	const authorization = request.headers.authorization ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/);
	if (!match) return false;
	return secureEqual(match[1]!.trim(), token);
}

function readRequestId(request: IncomingMessage): string {
	const header = request.headers["x-request-id"];
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : newRequestId();
}

function readIdempotencyKey(request: IncomingMessage): string | undefined {
	const header = request.headers["idempotency-key"];
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function hashRequest(route: Route, body: unknown, appId: string | undefined): string {
	// Deterministic request fingerprint (no canonical sorting needed: the
	// idempotency contract keys on the exact submitted request).
	return `${route.operation}|${appId ?? ""}|${JSON.stringify(body ?? null)}`;
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		request.on("data", (chunk: Buffer) => {
			if (overflow) return; // keep draining so the client gets a response
			size += chunk.length;
			if (size > maxBytes) {
				overflow = true;
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(overflow ? null : Buffer.concat(chunks).toString("utf-8")));
		request.on("error", reject);
	});
}

type FieldSpec = "string" | "number" | "boolean" | "null" | "undefined" | "object" | "array" | readonly string[];

/**
 * Shallow-validate a parsed JSON body against a field spec. Unknown fields are
 * ignored; a missing field whose spec does not allow `undefined` throws
 * `HttpValidationError` (mapped to 400 by the dispatcher).
 */
function parseBody(body: unknown, spec: Record<string, FieldSpec>): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new HttpValidationError("request body must be a JSON object");
	}
	const record = body as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, expected] of Object.entries(spec)) {
		const value = record[key];
		if (!matchField(value, expected)) {
			throw new HttpValidationError(`body.${key} does not match the expected type`);
		}
		out[key] = value;
	}
	return out;
}

function matchField(value: unknown, expected: FieldSpec): boolean {
	if (Array.isArray(expected)) {
		return expected.some((entry) => matchField(value, entry));
	}
	switch (expected) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "undefined":
			return value === undefined;
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		default:
			return false;
	}
}

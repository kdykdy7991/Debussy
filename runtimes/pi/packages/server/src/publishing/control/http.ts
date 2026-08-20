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
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { ConversationExportMode, CustomLlmApi } from "@earendil-works/pi-protocol";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import { jsonBody } from "../../web/http-shared.ts";
import type {
	AgentDefinitionId,
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	RequestId,
	TenantId,
} from "../domain/ids.ts";
import { fromPublicId, newRequestId, toPublicId } from "../domain/ids.ts";
import type { AccessMode } from "../domain/states.ts";
import type { IdempotencyScope, PublishedAppRecord, PublishingRepositories } from "../repositories.ts";
import type { ControlService, CurrentAgentDefinitionSource } from "./service.ts";
import { ConversationExportNotFound } from "./service.ts";
import { secureEqual } from "./token.ts";

export const CONTROL_API_PREFIX = "/api/control/v1";

/** Module-scoped empty query for POST route handlers that ignore the query. */
const emptyQuery = new URLSearchParams();

/** Default cap for a control request body (1 MiB); oversized -> 413. */
export const CONTROL_MAX_BODY_BYTES = 1024 * 1024;
/** Idempotency slot TTL for control writes. */
export const CONTROL_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/** OpenAI protocols the Custom LLM console can bind a provider to. */
const KNOWN_LLM_APIS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses"]);

export interface ControlHttpHandlerOptions {
	readonly service: ControlService;
	readonly repositories: PublishingRepositories;
	/** Platform admin token (spec 33.2); compared in constant time. */
	readonly adminToken: string;
	/** Every control operation maps to this bootstrap tenant (spec 33.1). */
	readonly tenantId: TenantId;
	/** Display name exposed only on authenticated control responses. */
	readonly tenantName?: string;
	/** Collects the current agent configuration for import-current (33.3). */
	readonly source: CurrentAgentDefinitionSource;
	readonly idempotencyTtlMs?: number;
	readonly maxBodyBytes?: number;
	readonly onError?: (error: unknown) => void;
}

interface Route {
	readonly method: "GET" | "POST";
	readonly pattern: RegExp;
	readonly operation: string;
	readonly handler: (ctx: {
		requestId: string;
		body: unknown;
		/** Query-string parameters for GET routes (empty for POST routes). */
		query: URLSearchParams;
		/** Regex capture groups from the path, e.g. `[appId]` or `[appId, keyId]`. */
		params: readonly string[];
		/** The raw HTTP response, exposed only for streaming routes (WB-009). */
		response: ServerResponse;
	}) => Promise<Envelope | { readonly kind: "stream" }>;
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
	const idempotencyScope: IdempotencyScope = { tenantId, principalId: tenantId as unknown as PrincipalId };

	const routes: readonly Route[] = [
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/agent-definitions\/import-current$/,
			operation: "agent-definitions.import-current",
			handler: async ({ requestId, body }) => {
				// NOTE: `expectedSourceHash` is optional end-to-end (the web client
				// sends `{}` when absent); `undefined` must be an accepted shape or
				// the import button 400s against the real route. Found by MVP-08
				// live acceptance (import-current with empty body -> INVALID_REQUEST).
				const parsed = parseBody(body, { expectedSourceHash: ["string", "null", "undefined"] });
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
			handler: async ({ requestId, body, params }) => {
				const parsed = parseBody(body, { sourceAgentRevision: "number" });
				const publishedAppId = parseAppId(params[0]);
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
			handler: async ({ requestId, body, params }) => {
				const parsed = parseBody(body, { reason: ["string", "undefined"] });
				const publishedAppId = parseAppId(params[0]);
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
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/launch-keys$/,
			operation: "published-apps.create-launch-key",
			handler: async ({ requestId, body, params }) => {
				const parsed = parseBody(body, {
					keyId: "string",
					algorithm: ["string", "undefined"],
					publicKeyPem: "string",
					notBefore: ["string", "undefined"],
					expiresAt: ["string", "null", "undefined"],
				});
				const publishedAppId = parseAppId(params[0]);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const created = await service.createLaunchKey({
					tenantId,
					publishedAppId,
					keyId: parsed.keyId as string,
					algorithm: parsed.algorithm === undefined ? undefined : (parsed.algorithm as string),
					publicKeyPem: parsed.publicKeyPem as string,
					notBefore: parsed.notBefore === undefined ? undefined : (parsed.notBefore as string),
					expiresAt: parsed.expiresAt === undefined ? undefined : (parsed.expiresAt as string | null),
				});
				if (!created.ok) return serviceError(created.error, requestId);
				return {
					status: 201,
					body: {
						data: {
							id: toPublicId("LaunchKeyId", created.data.key.launchKeyId),
							keyId: created.data.key.keyId,
							algorithm: created.data.key.algorithm,
							status: created.data.key.status,
							notBefore: created.data.key.notBefore.toISOString(),
							expiresAt: created.data.key.expiresAt === null ? null : created.data.key.expiresAt.toISOString(),
							retiredKeyIds: created.data.retired.map((key) => key.keyId),
							auditEventId: toPublicId("AuditEventId", created.data.auditEventId),
						},
						requestId,
					},
				};
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/launch-keys\/([^/]+)\/revoke$/,
			operation: "published-apps.revoke-launch-key",
			handler: async ({ requestId, params }) => {
				const publishedAppId = parseAppId(params[0]);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const keyId = params[1] as string;
				if (keyId === undefined || keyId === "") {
					return badRequest("keyId must not be empty", requestId);
				}
				const revoked = await service.revokeLaunchKey({ tenantId, publishedAppId, keyId });
				if (!revoked.ok) return serviceError(revoked.error, requestId);
				return {
					status: 200,
					body: {
						data: {
							id: toPublicId("LaunchKeyId", revoked.data.key.launchKeyId),
							keyId: revoked.data.key.keyId,
							status: revoked.data.key.status,
							auditEventId: toPublicId("AuditEventId", revoked.data.auditEventId),
						},
						requestId,
					},
				};
			},
		},
		// ---- Query routes (ADMIN-002). GETs are authenticated reads; they
		// never read a request body and never write idempotency records. ----
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/usage$/,
			operation: "usage.summary",
			handler: async ({ requestId, query }) => {
				const range = parseUsageRange(query);
				if (!range.ok) return badRequest(range.message, requestId);
				const summary = await service.getUsageSummary({ tenantId, from: range.from, to: range.to });
				if (!summary.ok) return serviceError(summary.error, requestId);
				return { status: 200, body: { data: summary.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/agent-definitions$/,
			operation: "agent-definitions.list",
			handler: async ({ requestId, query }) => {
				const parsed = parseListQuery(query, { includeRevisions: true });
				if (!parsed.ok) return badRequest(parsed.message, requestId);
				const listed = await service.listAgentDefinitions({
					tenantId,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
					includeRevisions: parsed.data.includeRevisions,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/published-apps$/,
			operation: "published-apps.list",
			handler: async ({ requestId, query }) => {
				const parsed = parseListQuery(query, { status: true });
				if (!parsed.ok) return badRequest(parsed.message, requestId);
				const listed = await service.listPublishedApps({
					tenantId,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
					status: parsed.data.status,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)$/,
			operation: "published-apps.get",
			handler: async ({ requestId, params }) => {
				const publishedAppId = parseAppId(params[0]);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const detail = await service.getPublishedAppDetail({ tenantId, publishedAppId });
				if (!detail.ok) return serviceError(detail.error, requestId);
				return { status: 200, body: { data: detail.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/versions$/,
			operation: "published-apps.list-versions",
			handler: async ({ requestId, query, params }) => {
				const parsed = parseListQuery(query, {});
				if (!parsed.ok) return badRequest(parsed.message, requestId);
				const publishedAppId = parseAppId(params[0]);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const listed = await service.listPublishedAppVersions({
					tenantId,
					publishedAppId,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/launch-keys$/,
			operation: "published-apps.list-launch-keys",
			handler: async ({ requestId, params }) => {
				const publishedAppId = parseAppId(params[0]);
				if (publishedAppId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				const listed = await service.listLaunchKeys({ tenantId, publishedAppId });
				if (!listed.ok) return serviceError(listed.error, requestId);
				// Never return PEM material: only keyId/algorithm/status/times.
				return {
					status: 200,
					body: {
						data: {
							items: listed.data.keys.map((key) => ({
								id: toPublicId("LaunchKeyId", key.launchKeyId),
								keyId: key.keyId,
								algorithm: key.algorithm,
								status: key.status,
								notBefore: key.notBefore.toISOString(),
								expiresAt: key.expiresAt === null ? null : key.expiresAt.toISOString(),
								createdAt: key.createdAt.toISOString(),
							})),
						},
						requestId,
					},
				};
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/audit-events$/,
			operation: "audit-events.list",
			handler: async ({ requestId, query }) => {
				const parsed = parseListQuery(query, {});
				if (!parsed.ok) return badRequest(parsed.message, requestId);
				const appIdParam = query.get("appId") ?? undefined;
				if (appIdParam !== undefined && fromPublicId("PublishedAppId", appIdParam) === null) {
					return badRequest("appId must be a bare app_<uuid> id", requestId);
				}
				const appId =
					appIdParam === undefined ? undefined : (fromPublicId("PublishedAppId", appIdParam) ?? undefined);
				const listed = await service.listAuditEvents({
					tenantId,
					appId,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		// ---- User conversations (WB-006 / SPEC §5.4). ----
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/conversations$/,
			operation: "conversations.list",
			handler: async ({ requestId, query }) => {
				const parsed = parseConversationListQuery(query);
				if (!parsed.ok) return badRequest(parsed.message, requestId);
				const listed = await service.listConversations({
					tenantId,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
					publishedAppId: parsed.data.publishedAppId,
					status: parsed.data.status,
					agentId: parsed.data.agentId,
					hasErrors: parsed.data.hasErrors,
					principalType: parsed.data.principalType,
					publishedAppVersionId: parsed.data.publishedAppVersionId,
					createdAfter: parsed.data.createdAfter,
					createdBefore: parsed.data.createdBefore,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/conversations\/([^/]+)$/,
			operation: "conversations.get",
			handler: async ({ requestId, params }) => {
				const conversationId = parseConversationId(params[0]);
				if (conversationId === null) return badRequest("conversationId must be a bare conv_<uuid> id", requestId);
				const detail = await service.getConversationAdminDetail({ tenantId, conversationId, requestId });
				if (!detail.ok) return serviceError(detail.error, requestId);
				return { status: 200, body: { data: detail.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/conversations\/([^/]+)\/events$/,
			operation: "conversations.list-events",
			handler: async ({ requestId, query, params }) => {
				const conversationId = parseConversationId(params[0]);
				if (conversationId === null) return badRequest("conversationId must be a bare conv_<uuid> id", requestId);
				const limit = parsePositiveInt(query.get("limit"), 50, 500);
				if (limit === null) return badRequest("limit must be a positive integer", requestId);
				const afterRaw = query.get("afterSequence");
				const afterSequence = (() => {
					if (afterRaw === null || afterRaw.trim() === "") return undefined;
					return parsePositiveInt(afterRaw, 0, 1e9);
				})();
				if (afterSequence === null) {
					return badRequest("afterSequence must be a non-negative integer", requestId);
				}
				const listed = await service.listConversationEvents({
					tenantId,
					conversationId,
					limit,
					afterSequence,
					requestId,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/conversations\/([^/]+)\/attachments$/,
			operation: "conversations.list-attachments",
			handler: async ({ requestId, params }) => {
				const conversationId = parseConversationId(params[0]);
				if (conversationId === null) return badRequest("conversationId must be a bare conv_<uuid> id", requestId);
				const listed = await service.listConversationAttachments({ tenantId, conversationId, requestId });
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/conversations\/([^/]+)\/export$/,
			operation: "conversations.export",
			handler: async ({ requestId, query, params, response }) => {
				const conversationId = parseConversationId(params[0]);
				if (conversationId === null) {
					jsonBody(
						response,
						400,
						errorEnvelope("INVALID_REQUEST", "conversationId must be a bare conv_<uuid> id", requestId, false),
					);
					return { kind: "stream" };
				}
				const modeRaw = query.get("mode") ?? "full";
				if (modeRaw !== "full" && modeRaw !== "diagnostics" && modeRaw !== "transcript") {
					jsonBody(
						response,
						400,
						errorEnvelope("INVALID_REQUEST", "mode must be full | diagnostics | transcript", requestId, false),
					);
					return { kind: "stream" };
				}
				const mode = modeRaw as ConversationExportMode;
				// 背压/取消 + 流式压缩：generator -> Readable -> gzip -> response。
				response.statusCode = 200;
				response.setHeader("Content-Type", "application/jsonl+gzip");
				response.setHeader("Content-Disposition", `attachment; filename="${conversationId}.jsonl.gz"`);
				response.setHeader("X-Request-Id", requestId);
				response.setHeader("X-Tenant-Id", String(tenantId));

				let generator: AsyncGenerator<string, void, unknown>;
				try {
					generator = service.streamConversationExport({ tenantId, conversationId, mode, requestId });
					// Prime the generator once so not-found is detected before
					// any bytes are written (uniform 404).
					await generator.next();
				} catch (error) {
					if (error instanceof ConversationExportNotFound) {
						if (!response.headersSent) {
							response.statusCode = 404;
							response.setHeader("Content-Type", "application/json");
							response.end(
								JSON.stringify(
									errorEnvelope(
										"CONVERSATION_NOT_FOUND",
										"conversation not found in tenant scope",
										requestId,
										false,
									),
								),
							);
						}
					} else {
						options.onError?.(error);
						if (!response.headersSent) {
							response.statusCode = 500;
							response.setHeader("Content-Type", "application/json");
							response.end(JSON.stringify(errorEnvelope("INTERNAL", "Internal server error", requestId, true)));
						}
					}
					return { kind: "stream" };
				}

				// Streaming pipeline with backpressure + client-cancel propagation.
				const jsonl = Readable.from(generator, { objectMode: false });
				const gzip = createGzip();
				const pipelineDone = pipeline(jsonl, gzip, response, (err) => {
					// err === undefined on clean end; on client abort (response
					// destroyed) err is set, which stops the DB + compression work
					// and propagates cancellation to the async generator below.
					if (err !== undefined && !response.destroyed) {
						options.onError?.(err);
					}
					if (!response.headersSent) response.end();
				});
				void pipelineDone;
				return { kind: "stream" };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/conversations\/([^/]+)\/summaries$/,
			operation: "conversations.list-summaries",
			handler: async ({ requestId, params }) => {
				const conversationId = parseConversationId(params[0]);
				if (conversationId === null) return badRequest("conversationId must be a bare conv_<uuid> id", requestId);
				const listed = await service.listConversationSummaries({ tenantId, conversationId, requestId });
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		// ---- Dashboard summary (WB-004 / SPEC §5.3). ----
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/dashboard\/summary$/,
			operation: "dashboard.summary",
			handler: async ({ requestId }) => {
				const result = await service.getDashboardSummary({ tenantId });
				if (!result.ok) return serviceError(result.error, requestId);
				return { status: 200, body: { data: result.data, requestId } };
			},
		},
		// ---- Session / whoami (MVP-01). ----
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/session$/,
			operation: "session.get",
			handler: async ({ requestId }) => {
				const result = await service.getSession({ tenantId });
				if (!result.ok) return serviceError(result.error, requestId);
				const session = result.data;
				return {
					status: 200,
					body: {
						data: {
							tenantId: session.tenantId,
							tenantName: session.tenantName,
							tenantStatus: session.tenantStatus,
							baseUrl: session.baseUrl,
							capabilities: [...session.capabilities],
						},
						requestId,
					},
				};
			},
		},
		// ---- Preview ticket (WB-005 / SPEC §6.3). ----
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/published-apps\/([^/]+)\/preview-ticket$/,
			operation: "published-apps.preview-ticket",
			handler: async ({ requestId, body, params }) => {
				const appId = parseAppId(params[0]);
				if (appId === null) return badRequest("appId must be a bare app_<uuid> id", requestId);
				if (body === undefined || typeof body !== "object" || body === null) {
					return badRequest("body must be a JSON object", requestId);
				}
				const draft = body as Record<string, unknown>;
				const versionIdRaw = draft.versionId;
				if (typeof versionIdRaw !== "string" || versionIdRaw === "") {
					return badRequest("versionId must be a non-empty string", requestId);
				}
				const versionId = fromPublicId("PublishedAppVersionId", versionIdRaw);
				if (versionId === null) return badRequest("versionId must be a bare pav_<uuid> id", requestId);
				const ttlSeconds =
					typeof draft.ttlSeconds === "number" && Number.isFinite(draft.ttlSeconds) ? draft.ttlSeconds : undefined;
				const result = await service.createPreviewTicket({
					tenantId,
					publishedAppId: appId,
					versionId,
					ttlSeconds,
					requestId: requestId as RequestId,
				});
				if (!result.ok) return serviceError(result.error, requestId);
				return { status: 201, body: { data: result.data, requestId } };
			},
		},
		// ---- AgentDefinition detail (WB-003 / SPEC §5.2 / §15.1). ----
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/agent-definitions\/([^/]+)$/,
			operation: "agent-definitions.get",
			handler: async ({ requestId, params }) => {
				const agentDefinitionId = parseAgentId(params[0]);
				if (agentDefinitionId === null) return badRequest("agentId must be a bare agent_<uuid> id", requestId);
				const detail = await service.getAgentDefinitionDetail({ tenantId, agentDefinitionId });
				if (!detail.ok) return serviceError(detail.error, requestId);
				return { status: 200, body: { data: detail.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/agent-definitions\/([^/]+)\/revisions$/,
			operation: "agent-definitions.list-revisions",
			handler: async ({ requestId, query, params }) => {
				const parsed = parseListQuery(query, {});
				if (!parsed.ok) return badRequest(parsed.message, requestId);
				const agentDefinitionId = parseAgentId(params[0]);
				if (agentDefinitionId === null) return badRequest("agentId must be a bare agent_<uuid> id", requestId);
				const listed = await service.listAgentDefinitionRevisions({
					tenantId,
					agentDefinitionId,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
				});
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/agent-definitions\/([^/]+)\/revisions\/(\d+)$/,
			operation: "agent-definitions.get-revision",
			handler: async ({ requestId, params }) => {
				const agentDefinitionId = parseAgentId(params[0]);
				if (agentDefinitionId === null) return badRequest("agentId must be a bare agent_<uuid> id", requestId);
				const revision = Number.parseInt(params[1] ?? "", 10);
				if (!Number.isInteger(revision) || revision < 1)
					return badRequest("revision must be a positive integer", requestId);
				const detail = await service.getAgentDefinitionRevision({
					tenantId,
					agentDefinitionId,
					revision,
				});
				if (!detail.ok) return serviceError(detail.error, requestId);
				return { status: 200, body: { data: detail.data, requestId } };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/agent-definitions\/([^/]+)\/revisions$/,
			operation: "agent-definitions.save-revision",
			handler: async ({ requestId, body, params }) => {
				const agentDefinitionId = parseAgentId(params[0]);
				if (agentDefinitionId === null) return badRequest("agentId must be a bare agent_<uuid> id", requestId);
				if (body === undefined || typeof body !== "object" || body === null)
					return badRequest("body must be a JSON object", requestId);
				const draft = body as Record<string, unknown>;
				const result = await service.saveAgentRevision({
					tenantId,
					agentDefinitionId,
					request: {
						modelId: typeof draft.modelId === "string" ? draft.modelId : null,
						systemPrompt: typeof draft.systemPrompt === "string" ? draft.systemPrompt : "",
						parameters:
							draft.parameters !== null && typeof draft.parameters === "object"
								? (draft.parameters as Record<string, unknown>)
								: {},
						toolIds: Array.isArray(draft.toolIds) ? (draft.toolIds as string[]) : [],
						knowledgeBaseIds: Array.isArray(draft.knowledgeBaseIds) ? (draft.knowledgeBaseIds as string[]) : [],
						capabilities: parseCapabilities(draft.capabilities),
						changeSummary: typeof draft.changeSummary === "string" ? draft.changeSummary : "",
					},
				});
				if (!result.ok) return serviceError(result.error, requestId);
				return { status: 201, body: { data: result.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/agent-definitions\/([^/]+)\/apps$/,
			operation: "agent-definitions.list-apps",
			handler: async ({ requestId, params }) => {
				const agentDefinitionId = parseAgentId(params[0]);
				if (agentDefinitionId === null) return badRequest("agentId must be a bare agent_<uuid> id", requestId);
				const listed = await service.listAgentDefinitionApps({ tenantId, agentDefinitionId });
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/llm-providers$/,
			operation: "llm-providers.list",
			handler: async ({ requestId }) => {
				const listed = await service.listLlmProviders();
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/control\/v1\/llm-providers\/models$/,
			operation: "llm-providers.list-models",
			handler: async ({ requestId }) => {
				const listed = await service.listLlmModels();
				if (!listed.ok) return serviceError(listed.error, requestId);
				return { status: 200, body: { data: listed.data, requestId } };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/llm-providers$/,
			operation: "llm-providers.upsert",
			handler: async ({ requestId, body }) => {
				const parsed = parseBody(body, {
					id: "string",
					name: "string",
					baseUrl: "string",
					api: "string",
					models: "array",
					apiKey: ["string", "undefined"],
				});
				if (!KNOWN_LLM_APIS.has(parsed.api as string)) {
					return badRequest("api must be openai-completions | openai-responses", requestId);
				}
				const result = await service.upsertLlmProvider({
					id: parsed.id as string,
					name: parsed.name as string,
					baseUrl: parsed.baseUrl as string,
					api: parsed.api as CustomLlmApi,
					models: (parsed.models as unknown[]).map(String),
					apiKey: parsed.apiKey as string | undefined,
				});
				if (!result.ok) return serviceError(result.error, requestId);
				return { status: 201, body: { data: result.data, requestId } };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/llm-providers\/([^/]+)\/delete$/,
			operation: "llm-providers.delete",
			handler: async ({ requestId, params }) => {
				const id = params[0] as string;
				const result = await service.removeLlmProvider({ id });
				if (!result.ok) return serviceError(result.error, requestId);
				return { status: 200, body: { data: result.data, requestId } };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/control\/v1\/llm-providers\/test$/,
			operation: "llm-providers.test",
			handler: async ({ requestId, body }) => {
				const parsed = parseBody(body, {
					baseUrl: "string",
					api: "string",
					apiKey: ["string", "undefined"],
				});
				const result = await service.testLlmProvider({
					baseUrl: parsed.baseUrl as string,
					api: parsed.api as CustomLlmApi,
					apiKey: parsed.apiKey as string | undefined,
				});
				if (!result.ok) return serviceError(result.error, requestId);
				return { status: 200, body: { data: result.data, requestId } };
			},
		},
	];

	async function transition(
		kind: "activate" | "rollback",
		ctx: { requestId: string; body: unknown; params: readonly string[] },
	): Promise<Envelope> {
		const parsed = parseBody(ctx.body, { versionId: "string" });
		const publishedAppId = parseAppId(ctx.params[0]);
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
			response.setHeader("X-Tenant-Id", String(tenantId));
			if (options.tenantName !== undefined) response.setHeader("X-Tenant-Name", options.tenantName);

			const route = routes.find((r) => r.method === request.method && r.pattern.test(pathname));
			if (!route) {
				jsonBody(response, 404, errorEnvelope("NOT_FOUND", "Unknown control route", requestId, false));
				return true;
			}
			const params = pathname.match(route.pattern)?.slice(1) ?? [];

			// GETs are authenticated reads: they never read a body and never
			// write idempotency records (spec review: read paths skip slots).
			if (request.method === "GET") {
				const query = new URL(request.url ?? "", "http://control.local").searchParams;
				const result = await route.handler({ requestId, body: undefined, query, params, response });
				// Streaming routes (WB-009) write bytes + end the response
				// themselves and return `{ kind: "stream" }`.
				if ("kind" in result && result.kind === "stream") return true;
				const envelope = result as Envelope;
				jsonBody(response, envelope.status, envelope.body);
				return true;
			}

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
			const handlerResult =
				idempotencyKey === undefined
					? await route.handler({ requestId, body, query: emptyQuery, params, response })
					: await withIdempotency(route, {
							requestId,
							body,
							query: emptyQuery,
							params,
							idempotencyKey,
							response,
						});
			// POST handlers never return { kind: "stream" }; the union is a static
			// artifact of sharing the Route.handler signature with the single
			// GET streaming route above.
			const envelope = handlerResult as Envelope;
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
		ctx: {
			requestId: string;
			body: unknown;
			query: URLSearchParams;
			params: readonly string[];
			idempotencyKey: string;
			response: ServerResponse;
		},
	): Promise<Envelope> {
		const requestHash = hashRequest(route, ctx.body, ctx.params);
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
			const result = (await route.handler(ctx)) as Envelope;
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

/** Parse a bare `conv_<uuid>` public id from a path segment. */
function parseConversationId(cid: string | undefined): ConversationId | null {
	if (cid === undefined) return null;
	return fromPublicId("ConversationId", cid);
}

/** Parse an integer query param, clamped to [min, max]; null when invalid. */
function parsePositiveInt(raw: string | null, min: number, max: number): number | null {
	if (raw === null || raw.trim() === "") {
		// A blank value is not an error when the route treats it as optional;
		// callers pass min=0 and accept null as "unset".
		return min === 0 ? null : min;
	}
	if (!/^\d+$/.test(raw.trim())) return null;
	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value < min || value > max) return null;
	return value;
}

/** Parse a bare `agent_<uuid>` public id from a path segment. */
function parseAgentId(agentId: string | undefined): AgentDefinitionId | null {
	if (agentId === undefined) return null;
	return fromPublicId("AgentDefinitionId", agentId);
}

/** Narrow an arbitrary JSON value to `AgentCapabilities`; missing keys default to false. */
function parseCapabilities(value: unknown): import("@earendil-works/pi-protocol").AgentCapabilities {
	const obj = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const asBool = (v: unknown): boolean => v === true;
	return {
		liveSpeech: asBool(obj.liveSpeech),
		avatar: asBool(obj.avatar),
		attachments: asBool(obj.attachments),
		citations: asBool(obj.citations),
		realtime: asBool(obj.realtime),
		webSearch: asBool(obj.webSearch),
	};
}

/** Parse shared list query params, validating limit/status for the console. */
function parseListQuery(
	query: URLSearchParams,
	opts: { readonly includeRevisions?: boolean; readonly status?: boolean },
):
	| {
			readonly ok: true;
			readonly data: {
				readonly limit: number;
				readonly cursor?: string;
				readonly includeRevisions?: boolean;
				readonly status?: string;
			};
	  }
	| { readonly ok: false; readonly message: string } {
	const rawLimit = query.get("limit") ?? "50";
	if (!/^\d+$/.test(rawLimit)) return { ok: false, message: "limit must be a positive integer" };
	const limit = Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1) return { ok: false, message: "limit must be a positive integer" };
	const cursorRaw = query.get("cursor") ?? "";
	const cursor = cursorRaw.trim() === "" ? undefined : cursorRaw.trim();
	let includeRevisions: boolean | undefined;
	if (opts.includeRevisions === true) {
		const raw = query.get("includeRevisions");
		includeRevisions = raw === "true" ? true : raw === "false" ? false : undefined;
	}
	let status: string | undefined;
	if (opts.status === true) {
		const raw = query.get("status") ?? "";
		status = raw.trim() === "" ? undefined : raw.trim();
		if (status !== undefined && !["draft", "active", "suspended", "archived"].includes(status)) {
			return { ok: false, message: "status must be draft | active | suspended | archived" };
		}
	}
	const data: { limit: number; cursor?: string; includeRevisions?: boolean; status?: string } = { limit };
	if (cursor !== undefined) data.cursor = cursor;
	if (includeRevisions !== undefined) data.includeRevisions = includeRevisions;
	if (status !== undefined) data.status = status;
	return { ok: true, data };
}

/** WB-006: parse admin conversation list filters from query params. */
function parseConversationListQuery(query: URLSearchParams):
	| {
			readonly ok: true;
			readonly data: {
				readonly limit: number;
				readonly cursor?: string;
				readonly publishedAppId?: PublishedAppId;
				readonly status?: "active" | "archived" | "deleted";
				readonly agentId?: AgentDefinitionId;
				readonly hasErrors?: boolean;
				readonly principalType?: "external_user" | "anonymous_visitor";
				readonly publishedAppVersionId?: PublishedAppVersionId;
				readonly createdAfter?: Date;
				readonly createdBefore?: Date;
			};
	  }
	| { readonly ok: false; readonly message: string } {
	const rawLimit = query.get("limit") ?? "50";
	if (!/^\d+$/.test(rawLimit)) return { ok: false, message: "limit must be a positive integer" };
	const limit = Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		return { ok: false, message: "limit must be an integer in [1, 100]" };
	}
	const cursorRaw = query.get("cursor") ?? "";
	const cursor = cursorRaw.trim() === "" ? undefined : cursorRaw.trim();

	const appRaw = query.get("appId") ?? "";
	const publishedAppId =
		appRaw.trim() === "" ? undefined : (fromPublicId("PublishedAppId", appRaw.trim()) ?? undefined);
	if (appRaw.trim() !== "" && publishedAppId === undefined) {
		return { ok: false, message: "appId must be a bare app_<uuid> id" };
	}
	const agentRaw = query.get("agentId") ?? "";
	const agentId =
		agentRaw.trim() === "" ? undefined : (fromPublicId("AgentDefinitionId", agentRaw.trim()) ?? undefined);
	if (agentRaw.trim() !== "" && agentId === undefined) {
		return { ok: false, message: "agentId must be a bare agent_<uuid> id" };
	}
	const verRaw = query.get("publishedAppVersionId") ?? "";
	const publishedAppVersionId =
		verRaw.trim() === "" ? undefined : (fromPublicId("PublishedAppVersionId", verRaw.trim()) ?? undefined);
	if (verRaw.trim() !== "" && publishedAppVersionId === undefined) {
		return { ok: false, message: "publishedAppVersionId must be a bare pav_<uuid> id" };
	}

	const statusRaw = query.get("status") ?? "";
	const status = statusRaw.trim() === "" ? undefined : (statusRaw.trim() as "active" | "archived" | "deleted");
	if (status !== undefined && !["active", "archived", "deleted"].includes(status)) {
		return { ok: false, message: "status must be active | archived | deleted" };
	}
	const hasErrorsRaw = query.get("hasErrors") ?? "";
	const hasErrors = hasErrorsRaw === "true" ? true : hasErrorsRaw === "false" ? false : undefined;
	if (hasErrorsRaw !== "" && hasErrorsRaw !== "true" && hasErrorsRaw !== "false") {
		return { ok: false, message: "hasErrors must be true | false" };
	}
	const principalRaw = query.get("principalType") ?? "";
	const principalType = principalRaw === "" ? undefined : (principalRaw as "external_user" | "anonymous_visitor");
	if (principalType !== undefined && !["external_user", "anonymous_visitor"].includes(principalType)) {
		return { ok: false, message: "principalType must be external_user | anonymous_visitor" };
	}

	const createdAfter = parseIsoOrNull(query.get("createdAfter"));
	if (createdAfter.invalid) return { ok: false, message: createdAfter.message };
	const createdBefore = parseIsoOrNull(query.get("createdBefore"));
	if (createdBefore.invalid) return { ok: false, message: createdBefore.message };

	return {
		ok: true,
		data: {
			limit,
			cursor,
			publishedAppId,
			status,
			agentId,
			hasErrors,
			principalType,
			publishedAppVersionId,
			createdAfter: createdAfter.value,
			createdBefore: createdBefore.value,
		},
	};
}

/** Parse an optional ISO-8601 timestamp from a query param. */
function parseIsoOrNull(raw: string | null):
	| { readonly invalid: true; readonly message: string; readonly value?: undefined }
	| {
			readonly invalid: false;
			readonly value: Date | undefined;
	  } {
	if (raw === null || raw.trim() === "") return { invalid: false, value: undefined };
	const millis = Date.parse(raw.trim());
	if (Number.isNaN(millis)) {
		return { invalid: true, message: "timestamp params must be ISO-8601" };
	}
	return { invalid: false, value: new Date(millis) };
}

function parseUsageRange(
	query: URLSearchParams,
): { readonly ok: true; readonly from: Date; readonly to: Date } | { readonly ok: false; readonly message: string } {
	const from = parseIsoOrNull(query.get("from"));
	const to = parseIsoOrNull(query.get("to"));
	if (from.invalid || to.invalid || from.value === undefined || to.value === undefined) {
		return { ok: false, message: "from and to must be ISO-8601 timestamps" };
	}
	if (from.value >= to.value) return { ok: false, message: "from must be earlier than to" };
	const maxRangeMs = 90 * 24 * 60 * 60 * 1000;
	if (to.value.getTime() - from.value.getTime() > maxRangeMs) {
		return { ok: false, message: "usage range must not exceed 90 days" };
	}
	return { ok: true, from: from.value, to: to.value };
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

function hashRequest(route: Route, body: unknown, params: readonly string[]): string {
	// Deterministic request fingerprint (no canonical sorting needed: the
	// idempotency contract keys on the exact submitted request).
	return `${route.operation}|${params.join("/")}|${JSON.stringify(body ?? null)}`;
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

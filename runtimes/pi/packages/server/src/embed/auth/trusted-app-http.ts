import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SecretRegistry } from "../../logging/redact.ts";
import type { PostgresClient } from "../../persistence/postgres/client.ts";
import type { RedisClient } from "../../persistence/redis/client.ts";
import type { PublishedAppId, TenantId } from "../../publishing/domain/ids.ts";
import { parsePublicAppId } from "../../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../publishing/repositories.ts";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import {
	errorEnvelope,
	jsonBody,
	readJsonBody,
	readRequestId,
	respondPreflight,
	setEmbedCorsHeaders,
} from "../http-shared.ts";
import { parseStrictOrigin } from "./origin.ts";
import type { ExchangeService } from "./principal.ts";

const CODE_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 16 * 1024;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

interface TrustedAppRow {
	readonly id: string;
	readonly tenant_id: string;
	readonly published_app_id: string;
	readonly client_id: string;
	readonly secret_hash: string;
	readonly enabled: boolean;
	readonly allowed_origins: unknown;
}

/** Accept both JSONB arrays and legacy JSON-string values, always matching whole origins. */
function trustedOrigins(value: unknown): readonly string[] {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return [];
		}
	}
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

interface CodeClaims {
	readonly trustedAppId: string;
	readonly publicAppId: string;
	readonly userId: string;
	readonly name: string;
	readonly roles: readonly string[];
	readonly origin: string;
}

function validOrigin(value: unknown): value is string {
	return typeof value === "string" && parseStrictOrigin(value)?.canonical === value;
}

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Admin CRUD and server-to-server exchange share the same persisted credentials. */
export function createTrustedAppHttpHandlers(options: {
	readonly client: PostgresClient;
	readonly redis: RedisClient;
	readonly repositories: PublishingRepositories;
	readonly exchange: ExchangeService;
	readonly tenantId: string;
	readonly isAdmin: (request: import("node:http").IncomingMessage) => boolean;
	readonly secrets?: SecretRegistry;
}): { readonly admin: HttpRequestHandler; readonly public: HttpRequestHandler } {
	const { client, redis, repositories, exchange } = options;
	const fail = (
		response: import("node:http").ServerResponse,
		requestId: string,
		status: number,
		code: string,
		message: string,
	) => jsonBody(response, status, errorEnvelope(code, message, requestId, false));
	const read = async (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
		requestId: string,
	) => {
		const parsed = await readJsonBody(request, MAX_BODY_BYTES);
		if (parsed.kind !== "ok") {
			fail(response, requestId, parsed.kind === "too_large" ? 413 : 400, "INVALID_REQUEST", "Invalid request body");
			return null;
		}
		const body = object(parsed.value);
		if (body === null) fail(response, requestId, 400, "INVALID_REQUEST", "JSON object required");
		return body;
	};
	const load = async (clientId: string): Promise<TrustedAppRow | undefined> => {
		const rows = await client.run("select * from trusted_embed_apps where client_id = $1", clientId);
		return rows[0] as unknown as TrustedAppRow | undefined;
	};
	const admin: HttpRequestHandler = async (request, response) => {
		const path = requestPathname(request.url);
		if (path !== "/api/admin/v1/trusted-apps") return false;
		response.setHeader("Cache-Control", "no-store");
		const requestId = readRequestId(request);
		if (!options.isAdmin(request)) {
			fail(response, requestId, 401, "UNAUTHORIZED", "Unauthorized");
			return true;
		}
		try {
			if (request.method === "GET") {
				const rows = await client.run(
					"select id, name, client_id, enabled, allowed_origins, published_app_id, created_at from trusted_embed_apps where tenant_id = $1 order by created_at desc",
					options.tenantId,
				);
				jsonBody(response, 200, {
					data: rows.map((row) => ({ ...row, allowed_origins: trustedOrigins(row.allowed_origins) })),
					requestId,
				});
				return true;
			}
			if (request.method !== "POST" && request.method !== "PATCH") {
				fail(response, requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
				return true;
			}
			const body = await read(request, response, requestId);
			if (body === null) return true;
			if (request.method === "POST") {
				const publicAppId = typeof body.publicAppId === "string" ? parsePublicAppId(body.publicAppId) : null;
				const app =
					publicAppId === null ? undefined : await repositories.publishedApps.getByPublicAppId(publicAppId);
				const origins = body.allowedOrigins;
				if (
					app === undefined ||
					app.tenantId !== options.tenantId ||
					app.accessMode !== "trusted_app" ||
					typeof body.name !== "string" ||
					body.name.length < 1 ||
					body.name.length > 200 ||
					!Array.isArray(origins) ||
					origins.length === 0 ||
					!origins.every(validOrigin) ||
					!origins.every((origin) => app.allowedOrigins.includes(origin))
				) {
					fail(response, requestId, 400, "INVALID_REQUEST", "Invalid agent or trusted system configuration");
					return true;
				}
				const id = randomUUID();
				const clientId = `ta_${randomUUID()}`;
				const secret = randomBytes(32).toString("base64url");
				options.secrets?.register(secret);
				await client.run(
					"insert into trusted_embed_apps (id, tenant_id, published_app_id, name, client_id, secret_hash, allowed_origins) values ($1,$2,$3,$4,$5,$6,$7::jsonb)",
					id,
					options.tenantId,
					app.publishedAppId,
					body.name,
					clientId,
					sha256(secret),
					JSON.stringify(origins),
				);
				jsonBody(response, 201, { data: { id, clientId, clientSecret: secret }, requestId });
				return true;
			}
			if (
				typeof body.clientId !== "string" ||
				(body.action !== "rotate" &&
					body.action !== "enable" &&
					body.action !== "disable" &&
					body.action !== "update")
			) {
				fail(response, requestId, 400, "INVALID_REQUEST", "Invalid action");
				return true;
			}
			const app = await load(body.clientId);
			if (app === undefined || app.tenant_id !== options.tenantId) {
				fail(response, requestId, 404, "NOT_FOUND", "Trusted system unavailable");
				return true;
			}
			if (body.action === "update") {
				const published = await repositories.publishedApps.get(
					{ tenantId: options.tenantId as TenantId, publishedAppId: app.published_app_id as PublishedAppId },
					app.published_app_id as PublishedAppId,
				);
				const origins = body.allowedOrigins;
				if (
					published === undefined ||
					published.accessMode !== "trusted_app" ||
					typeof body.name !== "string" ||
					body.name.trim().length < 1 ||
					body.name.length > 200 ||
					!Array.isArray(origins) ||
					origins.length === 0 ||
					!origins.every(validOrigin) ||
					!origins.every((origin) => published.allowedOrigins.includes(origin))
				) {
					fail(response, requestId, 400, "INVALID_REQUEST", "Invalid trusted system configuration");
					return true;
				}
				await client.run(
					"update trusted_embed_apps set name = $1, allowed_origins = $2::jsonb, updated_at = now() where id = $3 and tenant_id = $4",
					body.name.trim(),
					JSON.stringify(origins),
					app.id,
					options.tenantId,
				);
				jsonBody(response, 200, { data: { clientId: app.client_id }, requestId });
				return true;
			}
			if (body.action === "rotate") {
				const secret = randomBytes(32).toString("base64url");
				options.secrets?.register(secret);
				await client.run(
					"update trusted_embed_apps set secret_hash = $1, updated_at = now() where id = $2 and tenant_id = $3",
					sha256(secret),
					app.id,
					options.tenantId,
				);
				jsonBody(response, 200, { data: { clientId: app.client_id, clientSecret: secret }, requestId });
				return true;
			}
			await client.run(
				"update trusted_embed_apps set enabled = $1, updated_at = now() where id = $2 and tenant_id = $3",
				body.action === "enable",
				app.id,
				options.tenantId,
			);
			jsonBody(response, 200, { data: { clientId: app.client_id, enabled: body.action === "enable" }, requestId });
			return true;
		} catch {
			fail(response, requestId, 500, "INTERNAL", "Internal server error");
			return true;
		}
	};
	const publicHandler: HttpRequestHandler = async (request, response) => {
		const path = requestPathname(request.url);
		if (path !== "/api/embed/v1/auth/exchange" && path !== "/api/embed/v1/auth/consume") return false;
		response.setHeader("Cache-Control", "no-store");
		const requestId = readRequestId(request);
		if (path.endsWith("/consume") && request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		if (request.method !== "POST") {
			fail(response, requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
			return true;
		}
		if (path.endsWith("/consume")) setEmbedCorsHeaders(response, request.headers.origin);
		try {
			const body = await read(request, response, requestId);
			if (body === null) return true;
			if (path.endsWith("/exchange")) {
				const authorization = request.headers.authorization;
				const match =
					typeof authorization === "string"
						? /^Bearer (ta_[0-9a-f-]+)\.([A-Za-z0-9_-]{40,100})$/.exec(authorization)
						: null;
				if (match === null) {
					fail(response, requestId, 401, "UNAUTHORIZED", "Unauthorized");
					return true;
				}
				const app = await load(match[1]);
				const presented = Buffer.from(sha256(match[2]), "hex");
				const expected = app === undefined ? Buffer.alloc(32) : Buffer.from(app.secret_hash, "hex");
				if (expected.length !== 32 || !timingSafeEqual(presented, expected) || !app?.enabled) {
					fail(response, requestId, 401, "UNAUTHORIZED", "Unauthorized");
					return true;
				}
				const publicAppId = typeof body.publicAppId === "string" ? parsePublicAppId(body.publicAppId) : null;
				const published =
					publicAppId === null ? undefined : await repositories.publishedApps.getByPublicAppId(publicAppId);
				if (
					published === undefined ||
					published.publishedAppId !== app.published_app_id ||
					published.status !== "active" ||
					published.accessMode !== "trusted_app" ||
					!validOrigin(body.origin) ||
					!trustedOrigins(app.allowed_origins).includes(body.origin) ||
					!published.allowedOrigins.includes(body.origin) ||
					typeof body.userId !== "string" ||
					body.userId.length < 1 ||
					body.userId.length > 256 ||
					typeof body.name !== "string" ||
					body.name.length < 1 ||
					body.name.length > 200 ||
					!Array.isArray(body.roles) ||
					body.roles.length > 32 ||
					!body.roles.every((role) => typeof role === "string" && role.length <= 100)
				) {
					fail(response, requestId, 400, "INVALID_REQUEST", "Invalid identity or agent");
					return true;
				}
				const code = randomBytes(32).toString("base64url");
				options.secrets?.register(code);
				const claims: CodeClaims = {
					trustedAppId: app.id,
					publicAppId: published.publicAppId,
					userId: body.userId,
					name: body.name,
					roles: body.roles as string[],
					origin: body.origin,
				};
				await redis.run(
					"SET",
					`embed:trusted-code:${sha256(code)}`,
					JSON.stringify(claims),
					"EX",
					CODE_TTL_SECONDS,
					"NX",
				);
				jsonBody(response, 200, { data: { code, expiresIn: CODE_TTL_SECONDS }, requestId });
				return true;
			}
			if (
				typeof body.code !== "string" ||
				!/^[A-Za-z0-9_-]{43}$/.test(body.code) ||
				typeof body.publicAppId !== "string" ||
				!validOrigin(body.hostOrigin)
			) {
				fail(response, requestId, 400, "INVALID_REQUEST", "Invalid code request");
				return true;
			}
			options.secrets?.register(body.code);
			const raw = await redis.run("GETDEL", `embed:trusted-code:${sha256(body.code)}`);
			if (typeof raw !== "string") {
				fail(response, requestId, 401, "TOKEN_INVALID", "Code invalid or expired");
				return true;
			}
			const claims = JSON.parse(raw) as CodeClaims;
			const trusted = await client.run(
				"select enabled, allowed_origins from trusted_embed_apps where id = $1",
				claims.trustedAppId,
			);
			if (
				claims.publicAppId !== body.publicAppId ||
				claims.origin !== body.hostOrigin ||
				trusted[0]?.enabled !== true ||
				!trustedOrigins(trusted[0]?.allowed_origins).includes(claims.origin)
			) {
				fail(response, requestId, 401, "TOKEN_INVALID", "Code invalid or expired");
				return true;
			}
			const publicAppId = parsePublicAppId(claims.publicAppId);
			if (publicAppId === null) {
				fail(response, requestId, 401, "TOKEN_INVALID", "Code invalid or expired");
				return true;
			}
			const result = await exchange.exchangeTrustedUser({
				publicAppId,
				trustedAppId: claims.trustedAppId,
				externalUserId: claims.userId,
				origin: claims.origin,
			});
			if (!result.ok) {
				fail(response, requestId, result.error.httpStatus, result.error.code, result.error.message);
				return true;
			}
			await client.run(
				"insert into trusted_embed_identity_profiles (principal_id, trusted_app_id, display_name, roles) values ($1,$2,$3,$4::jsonb) on conflict (principal_id) do update set display_name = excluded.display_name, roles = excluded.roles, updated_at = now()",
				result.data.principal.id.slice(4),
				claims.trustedAppId,
				claims.name,
				JSON.stringify(claims.roles),
			);
			options.secrets?.register(result.data.accessToken);
			jsonBody(response, 200, { data: result.data, requestId });
			return true;
		} catch {
			fail(response, requestId, 500, "INTERNAL", "Internal server error");
			return true;
		}
	};
	return { admin, public: publicHandler };
}

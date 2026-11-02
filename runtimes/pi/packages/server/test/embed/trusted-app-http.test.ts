import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import type { ExchangeService } from "../../src/embed/auth/principal.ts";
import { createTrustedAppHttpHandlers } from "../../src/embed/auth/trusted-app-http.ts";
import type { PostgresClient } from "../../src/persistence/postgres/client.ts";
import type { RedisClient } from "../../src/persistence/redis/client.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const app = {
	publicAppId: "pub_00000000-0000-4000-8000-000000000001",
	publishedAppId: "00000000-0000-4000-8000-000000000001",
	tenantId: "00000000-0000-4000-8000-000000000002",
	status: "active",
	accessMode: "trusted_app",
	allowedOrigins: ["https://ticket.example.com"],
};

let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
	if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
});

test("trusted backend can exchange once; replay and wrong origin fail", async () => {
	const clientId = "ta_00000000-0000-4000-8000-000000000003";
	const secret = "s".repeat(43);
	const trusted = {
		id: "00000000-0000-4000-8000-000000000003",
		tenant_id: app.tenantId,
		published_app_id: app.publishedAppId,
		client_id: clientId,
		secret_hash: hash(secret),
		enabled: true,
		allowed_origins: JSON.stringify(app.allowedOrigins),
	};
	const profiles: unknown[][] = [];
	const db = {
		async run(query: string, ...args: unknown[]) {
			if (query.includes("from trusted_embed_apps where client_id")) return args[0] === clientId ? [trusted] : [];
			if (query.includes("select enabled, allowed_origins from trusted_embed_apps")) return [trusted];
			if (query.includes("insert into trusted_embed_identity_profiles")) {
				profiles.push(args);
				return [];
			}
			return [];
		},
	} as unknown as PostgresClient;
	const codes = new Map<string, string>();
	const redis = {
		async run(command: string, key: string, value?: string) {
			if (command === "SET") {
				codes.set(key, value!);
				return "OK";
			}
			if (command === "GETDEL") {
				const found = codes.get(key) ?? null;
				codes.delete(key);
				return found;
			}
			throw new Error("unexpected Redis command");
		},
	} as unknown as RedisClient;
	const repositories = { publishedApps: { getByPublicAppId: async () => app } } as unknown as PublishingRepositories;
	const exchange = {
		exchangeTrustedUser: async () => ({
			ok: true,
			data: {
				accessToken: "short-lived-token",
				expiresAt: new Date(Date.now() + 60000).toISOString(),
				principal: { id: "prn_00000000-0000-4000-8000-000000000004", type: "external_user" },
				app: { publicAppId: app.publicAppId, name: "Agent", currentVersionId: null, features: {} },
			},
		}),
	} as unknown as ExchangeService;
	const handlers = createTrustedAppHttpHandlers({
		client: db,
		redis,
		repositories,
		exchange,
		tenantId: app.tenantId,
		isAdmin: () => false,
	});
	server = createServer((request, response) => {
		void Promise.resolve(handlers.public(request, response)).then((handled) => {
			if (!handled) response.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("server did not listen");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (path: string, body: unknown, authorization?: string) => {
		const response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization === undefined ? {} : { Authorization: authorization }),
			},
			body: JSON.stringify(body),
		});
		return {
			status: response.status,
			body: (await response.json()) as { data?: { code?: string; accessToken?: string } },
		};
	};
	const identity = {
		publicAppId: app.publicAppId,
		origin: app.allowedOrigins[0],
		userId: "user-123",
		name: "张三",
		roles: ["support"],
	};
	expect((await request("/api/embed/v1/auth/exchange", identity, `Bearer ${clientId}.wrong${secret}`)).status).toBe(
		401,
	);
	const substringIdentity = { ...identity, origin: "https://ticket.example.co" };
	const appWithSubstringOrigin = { ...app, allowedOrigins: [...app.allowedOrigins, substringIdentity.origin] };
	const originalGet = repositories.publishedApps.getByPublicAppId;
	Object.assign(repositories.publishedApps, { getByPublicAppId: async () => appWithSubstringOrigin });
	expect(
		(await request("/api/embed/v1/auth/exchange", substringIdentity, `Bearer ${clientId}.${secret}`)).status,
	).toBe(400);
	Object.assign(repositories.publishedApps, { getByPublicAppId: originalGet });
	const issued = await request("/api/embed/v1/auth/exchange", identity, `Bearer ${clientId}.${secret}`);
	expect(issued.status).toBe(200);
	const code = issued.body.data?.code;
	expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const consume = { publicAppId: app.publicAppId, code, hostOrigin: app.allowedOrigins[0] };
	expect(
		(await request("/api/embed/v1/auth/consume", { ...consume, hostOrigin: "https://evil.example.com" })).status,
	).toBe(401);
	expect((await request("/api/embed/v1/auth/consume", consume)).status).toBe(401);
	const issuedAgain = await request("/api/embed/v1/auth/exchange", identity, `Bearer ${clientId}.${secret}`);
	const success = await request("/api/embed/v1/auth/consume", { ...consume, code: issuedAgain.body.data?.code });
	expect(success.status).toBe(200);
	expect(success.body.data?.accessToken).toBe("short-lived-token");
	expect(profiles).toHaveLength(1);
	expect((await request("/api/embed/v1/auth/consume", { ...consume, code: issuedAgain.body.data?.code })).status).toBe(
		401,
	);
});

test("admin can update a trusted system without rotating its credentials", async () => {
	const clientId = "ta_00000000-0000-4000-8000-000000000003";
	const updates: unknown[][] = [];
	const trusted = {
		id: "00000000-0000-4000-8000-000000000003",
		tenant_id: app.tenantId,
		published_app_id: app.publishedAppId,
		client_id: clientId,
	};
	const db = {
		async run(query: string, ...args: unknown[]) {
			if (query.includes("from trusted_embed_apps where client_id")) return [trusted];
			if (query.startsWith("update trusted_embed_apps set name")) updates.push(args);
			return [];
		},
	} as unknown as PostgresClient;
	const repositories = {
		publishedApps: { get: async () => app },
	} as unknown as PublishingRepositories;
	const handlers = createTrustedAppHttpHandlers({
		client: db,
		redis: {} as RedisClient,
		repositories,
		exchange: {} as ExchangeService,
		tenantId: app.tenantId,
		isAdmin: () => true,
	});
	server = createServer((request, response) => {
		void Promise.resolve(handlers.admin(request, response)).then((handled) => {
			if (!handled) response.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("server did not listen");
	const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/v1/trusted-apps`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			clientId,
			action: "update",
			name: "客服工单系统",
			allowedOrigins: app.allowedOrigins,
		}),
	});
	expect(response.status).toBe(200);
	expect(updates).toEqual([["客服工单系统", JSON.stringify(app.allowedOrigins), trusted.id, app.tenantId]]);
});

/**
 * TASK-019: Embed Web 逻辑层测试（storage / api / auth / conversation）。
 *
 * 纯逻辑测试：内存 storage + fetch mock，不依赖浏览器 DOM，node 环境运行。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { EmbedApi, EmbedApiError } from "../../src/embed/api.ts";
import { EmbedAuthController } from "../../src/embed/auth-controller.ts";
import { EmbedConversationController, messagesFromEvents } from "../../src/embed/conversation-controller.ts";
import { createVisitorStorage, newVisitorId, type StorageLike } from "../../src/embed/storage.ts";

function memoryStorage(): StorageLike {
	const store = new Map<string, string>();
	return {
		getItem: (key) => store.get(key) ?? null,
		setItem: (key, value) => void store.set(key, value),
		removeItem: (key) => void store.delete(key),
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(status >= 200 && status < 300 ? { data } : data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("embed visitor storage", () => {
	test("creates a stable visitor id and clears it", () => {
		const storage = memoryStorage();
		const visitor = createVisitorStorage(storage);
		const first = visitor.getOrCreateVisitorId();
		const second = visitor.getOrCreateVisitorId();
		expect(second).toBe(first);
		expect(first.length).toBeGreaterThanOrEqual(32);
		visitor.clearVisitorId();
		expect(visitor.getVisitorId()).toBeNull();
		expect(visitor.getOrCreateVisitorId()).not.toBe(first);
	});

	test("newVisitorId is base64url without padding", () => {
		const id = newVisitorId();
		expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(id).not.toContain("=");
		expect(id).not.toContain("+");
		expect(id).not.toContain("/");
		expect(id.length).toBe(43); // 32 bytes -> base64url
	});
});

describe("embed api client", () => {
	test("parses success envelopes and error envelopes", async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			const path = String(url);
			if (path.includes("/bootstrap"))
				return jsonResponse({
					publicAppId: "pub_x",
					name: "X",
					status: "active",
					accessMode: "anonymous",
					allowedOrigins: ["https://host.example.com"],
					currentVersionId: null,
					features: { uploads: false, speech: false, avatar: false },
					theme: {},
				});
			if (path.includes("/exchange"))
				return jsonResponse({
					accessToken: "jwt",
					expiresAt: "2026-01-01T00:00:00Z",
					principal: { id: "prn_1", type: "anonymous_visitor" },
					app: {
						publicAppId: "pub_x",
						name: "X",
						currentVersionId: null,
						features: { uploads: false, speech: false, avatar: false },
					},
				});
			throw new Error(`unexpected ${path}`);
		});
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const summary = await api.bootstrap("pub_x");
		expect(summary.name).toBe("X");
		const exchange = await api.exchange({
			publicAppId: "pub_x",
			mode: "anonymous",
			anonymousVisitorId: "v".repeat(43),
		});
		expect(exchange.accessToken).toBe("jwt");
	});

	test("maps error envelopes to EmbedApiError with code and retryable", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(
				{ error: { code: "APP_SUSPENDED", message: "App is suspended", requestId: "req_1", retryable: false } },
				403,
			),
		);
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		await expect(
			api.exchange({ publicAppId: "pub_x", mode: "anonymous", anonymousVisitorId: "v".repeat(43) }),
		).rejects.toMatchObject({
			code: "APP_SUSPENDED",
			retryable: false,
		});
	});

	test("maps network failures to NETWORK_ERROR", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("failed to fetch");
		});
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		await expect(api.bootstrap("pub_x")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
	});

	test("sends the bearer token on authenticated calls", async () => {
		let seen: RequestInit | undefined;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			seen = init;
			return jsonResponse({ items: [], nextCursor: null });
		});
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		await api.listConversations("tok-1");
		expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
	});
});

describe("embed auth controller", () => {
	test("signs in anonymously with a persistent visitor id and logs out", async () => {
		const storage = memoryStorage();
		const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({
				accessToken: "jwt-1",
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
				principal: { id: "prn_1", type: "anonymous_visitor" },
				app: {
					publicAppId: "pub_x",
					name: "X",
					currentVersionId: null,
					features: { uploads: false, speech: false, avatar: false },
				},
			}),
		);
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const auth = new EmbedAuthController(api, storage);
		const state = await auth.signIn("pub_x");
		expect(state.appName).toBe("X");
		expect(auth.hasToken).toBe(true);
		expect(auth.getToken()).toBe("jwt-1");
		const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "")) as { anonymousVisitorId: string };
		expect(body.anonymousVisitorId.length).toBeGreaterThanOrEqual(32);
		await auth.logout();
		expect(auth.hasToken).toBe(false);
		expect(() => auth.getToken()).toThrow(EmbedApiError);
	});

	test("TASK-033: getToken throws TOKEN_EXPIRED near expiry and refresh re-signs in anonymously", async () => {
		const storage = memoryStorage();
		let expiresAt = new Date(Date.now() + 10_000).toISOString();
		const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({
				accessToken: "jwt-expiring",
				expiresAt,
				principal: { id: "prn_1", type: "anonymous_visitor" },
				app: {
					publicAppId: "pub_x",
					name: "X",
					currentVersionId: null,
					features: { uploads: false, speech: false, avatar: false },
				},
			}),
		);
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const auth = new EmbedAuthController(api, storage);
		await auth.signIn("pub_x");
		// 30 秒余量内视为过期：近过期 token 不可直接取用。
		expect(() => auth.getToken()).toThrow(EmbedApiError);
		// 匿名模式 refresh = 用同一 visitorId 重新 Exchange（身份稳定）。
		expiresAt = new Date(Date.now() + 600_000).toISOString();
		const refreshed = await auth.refresh("pub_x");
		expect(refreshed.accessToken).toBe("jwt-expiring");
		expect(fetchImpl.mock.calls.length).toBe(2); // signIn + refresh
		// signed_user 无法静默刷新（Launch Token 已即用即弃，PD-18）。
		await auth.signInWithLaunchToken("pub_x", "host-signed-jws");
		await expect(auth.refresh("pub_x")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
	});
});

describe("embed conversation controller", () => {
	test("derives chat messages from persistent events", () => {
		const messages = messagesFromEvents([
			{ id: "e1", sequence: 1, eventType: "user.message", turnId: "t1", payload: { text: "hi" }, createdAt: "" },
			{
				id: "e2",
				sequence: 2,
				eventType: "assistant.completed",
				turnId: "t1",
				payload: { text: "hello" },
				createdAt: "",
			},
			{ id: "e3", sequence: 3, eventType: "turn.failed", turnId: "t2", payload: { error: "boom" }, createdAt: "" },
		]);
		expect(messages).toEqual([
			{ role: "user", text: "hi", sequence: 1 },
			{ role: "assistant", text: "hello", sequence: 2 },
			{ role: "system", text: "回复失败：boom", sequence: 3 },
		]);
	});

	test("lists, creates and opens conversations through the api", async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			const path = String(url);
			if (path.includes("/conversations?limit=")) {
				return jsonResponse({
					items: [
						{
							id: "conv_1",
							publishedAppVersionId: "pav_1",
							status: "active",
							lastEventSequence: 0,
							createdAt: "2026-01-01T00:00:00Z",
						},
					],
					nextCursor: null,
				});
			}
			if (path.endsWith("/conversations") && _init?.method === "POST") {
				return jsonResponse(
					{
						id: "conv_2",
						publishedAppVersionId: "pav_1",
						status: "active",
						lastEventSequence: 0,
						createdAt: "2026-01-01T00:00:00Z",
					},
					201,
				);
			}
			if (path.includes("/conv_1")) {
				return jsonResponse({
					conversation: {
						id: "conv_1",
						publishedAppVersionId: "pav_1",
						status: "active",
						lastEventSequence: 2,
						createdAt: "2026-01-01T00:00:00Z",
					},
					events: [
						{
							id: "e1",
							sequence: 1,
							eventType: "user.message",
							turnId: "t1",
							payload: { text: "hi" },
							createdAt: "",
						},
						{
							id: "e2",
							sequence: 2,
							eventType: "assistant.completed",
							turnId: "t1",
							payload: { text: "hello" },
							createdAt: "",
						},
					],
				});
			}
			throw new Error(`unexpected ${path}`);
		});
		const api = new EmbedApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const controller = new EmbedConversationController(api);
		const list = await controller.list("tok");
		expect(list[0]?.id).toBe("conv_1");
		const created = await controller.create("tok", "t");
		expect(created.id).toBe("conv_2");
		const opened = await controller.open("tok", "conv_1");
		expect(opened.messages).toHaveLength(2);
		expect(opened.messages[1]?.text).toBe("hello");
	});
});

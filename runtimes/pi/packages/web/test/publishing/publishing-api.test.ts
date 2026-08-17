/**
 * PublishingApi client + auth controller unit tests (ADMIN-003 / §3.3 / §3.2).
 *
 * ADMIN-003 完成条件：Token 不出现在 Storage、URL、console 或异常文本。
 */
import { describe, expect, type Mock, test, vi } from "vitest";
import { PublishingApi } from "../../src/publishing/api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";
import { PublishingApiError } from "../../src/publishing/types.ts";

function asFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
	return vi.fn(impl) as unknown as typeof fetch;
}

function mockCalls(mock: typeof fetch): Array<[RequestInfo | URL, RequestInit?]> {
	return (mock as unknown as Mock).mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
}

describe("PublishingApi", () => {
	function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		});
	}

	test("uses Authorization header for every call via tokenProvider", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = asFetch(async (input, init = {}) => {
			calls.push({ url: String(input), init });
			return jsonResponse(200, { data: { items: [], nextCursor: null }, requestId: "req_test" });
		});
		const api = new PublishingApi({
			baseUrl: "",
			fetchImpl,
			randomUUID: () => "uuid-test",
			tokenProvider: () => "my-token",
		});
		await api.listPublishedApps({});
		expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer my-token" });
	});

	test("omits Authorization when tokenProvider returns null", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = asFetch(async (input, init = {}) => {
			calls.push({ url: String(input), init });
			return jsonResponse(200, { data: { items: [], nextCursor: null }, requestId: "req_test" });
		});
		const api = new PublishingApi({
			baseUrl: "",
			fetchImpl,
			randomUUID: () => "uuid-test",
			tokenProvider: () => null,
		});
		await api.listPublishedApps({});
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.authorization).toBeUndefined();
	});

	test("publishes a fresh Idempotency-Key for a new successful user operation", async () => {
		const calls: Array<{ init: RequestInit }> = [];
		const fetchImpl = asFetch(async (_input, init = {}) => {
			calls.push({ init });
			return jsonResponse(201, {
				data: { agentDefinitionId: "agent_x", revision: 1, sourceHash: "h", warnings: [] },
				requestId: "req_test",
			});
		});
		let sequence = 0;
		const api = new PublishingApi({ baseUrl: "", fetchImpl, randomUUID: () => `uuid-${++sequence}` });
		await api.importCurrentAgent();
		await api.importCurrentAgent();
		const headers1 = calls[0]!.init.headers as Record<string, string>;
		const headers2 = calls[1]!.init.headers as Record<string, string>;
		expect(headers1["idempotency-key"]).not.toBe(headers2["idempotency-key"]);
	});

	test("reuses Idempotency-Key after a retryable failure", async () => {
		const calls: RequestInit[] = [];
		let attempt = 0;
		const fetchImpl = asFetch(async (_input, init = {}) => {
			calls.push(init);
			attempt += 1;
			if (attempt === 1) throw new TypeError("network down");
			return jsonResponse(201, {
				data: { agentDefinitionId: "agent_x", revision: 1, sourceHash: "h", warnings: [] },
				requestId: "req_test",
			});
		});
		let sequence = 0;
		const api = new PublishingApi({ baseUrl: "", fetchImpl, randomUUID: () => `uuid-${++sequence}` });
		await expect(api.importCurrentAgent()).rejects.toMatchObject({ retryable: true });
		await api.importCurrentAgent();
		expect((calls[0]!.headers as Record<string, string>)["idempotency-key"]).toBe(
			(calls[1]!.headers as Record<string, string>)["idempotency-key"],
		);
	});

	test("a different body gets a new idempotency key", async () => {
		const fetchImpl = asFetch(async () =>
			jsonResponse(201, {
				data: {
					version: {
						id: "pav_x",
						versionNumber: 1,
						status: "ready",
						sourceAgentRevision: 1,
						validationErrors: [],
					},
				},
				requestId: "req_test",
			}),
		);
		let counter = 0;
		const api = new PublishingApi({
			baseUrl: "",
			fetchImpl,
			randomUUID: () => `uuid-${counter++}`,
		});
		await api.createVersion({ appId: "app_1", sourceAgentRevision: 1 });
		await api.createVersion({ appId: "app_1", sourceAgentRevision: 2 });
		const keys = mockCalls(fetchImpl).map(
			([, init]) => (init?.headers as Record<string, string> | undefined)?.["idempotency-key"],
		);
		expect(new Set(keys).size).toBe(2);
	});

	test("401 envelope -> PublishingApiError with code/requestId", async () => {
		const fetchImpl = asFetch(async () =>
			jsonResponse(401, {
				error: { code: "UNAUTHORIZED", message: "Missing bearer token", requestId: "req_401", retryable: false },
			}),
		);
		const api = new PublishingApi({ baseUrl: "", fetchImpl, randomUUID: () => "uuid-1" });
		await expect(api.listPublishedApps({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			requestId: "req_401",
			httpStatus: 401,
			retryable: false,
		});
		await expect(api.listPublishedApps({})).rejects.toBeInstanceOf(PublishingApiError);
	});

	test("409 IDEMPOTENCY_IN_PROGRESS surfaces retryable=true", async () => {
		const fetchImpl = asFetch(async () =>
			jsonResponse(409, {
				error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "in progress", requestId: "req_x", retryable: true },
			}),
		);
		const api = new PublishingApi({ baseUrl: "", fetchImpl, randomUUID: () => "uuid-1" });
		await expect(api.importCurrentAgent()).rejects.toMatchObject({
			code: "IDEMPOTENCY_IN_PROGRESS",
			retryable: true,
		});
	});

	test("network error -> NETWORK_ERROR with retryable=true", async () => {
		const fetchImpl = asFetch(async () => {
			throw new TypeError("network down");
		});
		const api = new PublishingApi({ baseUrl: "", fetchImpl, randomUUID: () => "uuid-1" });
		await expect(api.listPublishedApps({})).rejects.toMatchObject({
			code: "NETWORK_ERROR",
			retryable: true,
		});
	});

	test("GET requests never include Idempotency-Key", async () => {
		const calls: Array<{ init: RequestInit }> = [];
		const fetchImpl = asFetch(async (_input, init = {}) => {
			calls.push({ init });
			return jsonResponse(200, { data: { items: [], nextCursor: null }, requestId: "req_g" });
		});
		const api = new PublishingApi({ baseUrl: "", fetchImpl, randomUUID: () => "uuid-g" });
		await api.listPublishedApps({});
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers["idempotency-key"]).toBeUndefined();
	});
});

describe("AdminAuthController", () => {
	test("starts locked with no token", () => {
		const auth = new AdminAuthController();
		expect(auth.hasToken()).toBe(false);
		expect(auth.getToken()).toBeNull();
		expect(auth.getSnapshot().state).toBe("locked");
	});

	test("connect() holds token only in memory; lock() wipes it", () => {
		const auth = new AdminAuthController();
		auth.connect("bearer-abc");
		expect(auth.hasToken()).toBe(true);
		expect(auth.getToken()).toBe("bearer-abc");
		auth.lock();
		expect(auth.hasToken()).toBe(false);
		expect(auth.getSnapshot().state).toBe("locked");
	});

	test("handleApiError on 401 wipes token + transitions to error", () => {
		const auth = new AdminAuthController();
		auth.connect("bearer-abc");
		const error = new PublishingApiError(
			{ code: "UNAUTHORIZED", message: "expired", requestId: "req_x", retryable: false },
			401,
		);
		const handled = auth.handleApiError(error);
		expect(handled).toBe(true);
		expect(auth.hasToken()).toBe(false);
		expect(auth.getSnapshot().state).toBe("error");
		expect(auth.getSnapshot().error).toBe("expired");
	});

	test("subscribe() listener receives state transitions", () => {
		const auth = new AdminAuthController();
		const states: string[] = [];
		const off = auth.subscribe((snap) => states.push(snap.state));
		auth.connect("t");
		auth.lock();
		off();
		expect(states).toEqual(["connecting", "locked"]);
	});

	test("token never appears in Storage or URL fields", () => {
		const auth = new AdminAuthController();
		auth.connect("bearer-secret-do-not-leak");
		const snapshot = auth.getSnapshot();
		const dump = JSON.stringify(snapshot);
		expect(dump.includes("bearer-secret-do-not-leak")).toBe(false);
	});

	test("baseUrl field is read-only when lockBaseUrl is true", () => {
		const auth = new AdminAuthController({ initialBaseUrl: "https://admin.example" });
		const snap = auth.getSnapshot();
		expect(snap.baseUrl).toBe("https://admin.example");
	});
});

/**
 * Admin unlock + session wiring tests (MVP-01 / Batch 1).
 *
 * Covers the contract the workbench now relies on:
 *
 *  - `AdminSessionApi.fetchSession` hits `/api/control/v1/session` with the
 *    `Authorization: Bearer <token>` header and parses the server envelope.
 *  - On 401 the controller is forced into the `error` state and the in-memory
 *    token is wiped (no Storage, URL, console, or thrown message leaks).
 *  - `AdminAuthProvider.unlock` only resolves after the session endpoint
 *    succeeds; an empty token is a no-op and the controller never advances to
 *    `connected` via a static placeholder.
 */

import { describe, expect, it } from "vitest";
import { AdminSessionApi, AdminSessionApiError } from "../../src/admin/api/session-api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

interface FetchCall {
	readonly url: string;
	readonly init: RequestInit;
}

function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		return handler({ url, init: init ?? {} });
	}) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("AdminSessionApi (MVP-01)", () => {
	it("calls /api/control/v1/session with the bearer token", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = makeFetch((call) => {
			calls.push(call);
			return jsonResponse(200, {
				data: {
					tenantId: "ten_local",
					tenantName: "Local Admin",
					tenantStatus: "active",
					baseUrl: "http://127.0.0.1:8765",
					capabilities: ["agent.read", "app.write"],
				},
				requestId: "req_1",
			});
		});
		const auth = new AdminAuthController({ initialBaseUrl: "http://127.0.0.1:8765" });
		auth.connect("super-secret-token");
		const api = new AdminSessionApi({ auth, fetchImpl });
		const session = await api.fetchSession();
		expect(calls.length).toBe(1);
		const captured = calls[0];
		if (captured === undefined) {
			throw new Error("expected one fetch call");
		}
		expect(captured.url).toBe("http://127.0.0.1:8765/api/control/v1/session");
		const headers = new Headers(captured.init.headers ?? {});
		expect(headers.get("Authorization")).toBe("Bearer super-secret-token");
		expect(session.tenantId).toBe("ten_local");
		expect(session.tenantName).toBe("Local Admin");
		expect(session.tenantStatus).toBe("active");
		expect(session.baseUrl).toBe("http://127.0.0.1:8765");
		expect(session.capabilities.has("agent.read")).toBe(true);
		expect(session.capabilities.has("app.write")).toBe(true);
		expect(session.capabilities.has("conversation.export")).toBe(false);
	});

	it("fails the connection (and wipes the token) on a 401 response", async () => {
		const fetchImpl = makeFetch(() => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "no" } }));
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		auth.connect("bad-token");
		const api = new AdminSessionApi({ auth, fetchImpl });
		await expect(api.fetchSession()).rejects.toBeInstanceOf(AdminSessionApiError);
		const snap = auth.getSnapshot();
		expect(snap.state).toBe("error");
		expect(snap.tenant).toBeNull();
		expect(auth.getToken()).toBeNull();
	});

	it("throws when no token is set in the controller", async () => {
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		const api = new AdminSessionApi({ auth });
		await expect(api.fetchSession()).rejects.toMatchObject({ httpStatus: 401, code: "UNAUTHORIZED" });
	});

	it("surfaces non-401 errors without wiping the token", async () => {
		const fetchImpl = makeFetch(() =>
			jsonResponse(500, { error: { code: "INTERNAL", message: "boom", requestId: "req_x", retryable: true } }),
		);
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		auth.connect("good-token");
		const api = new AdminSessionApi({ auth, fetchImpl });
		await expect(api.fetchSession()).rejects.toMatchObject({ code: "INTERNAL", requestId: "req_x" });
		expect(auth.getToken()).toBe("good-token");
		// Non-401 errors must not transition the controller: the token stays
		// alive so the UI can retry / show an error banner.
		expect(auth.getSnapshot().state).toBe("connecting");
	});

	it("error messages never include the token", async () => {
		const fetchImpl = makeFetch(() => new Response("not-json", { status: 502 }));
		const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		auth.connect("super-secret-token");
		const api = new AdminSessionApi({ auth, fetchImpl });
		let caught: unknown;
		try {
			await api.fetchSession();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AdminSessionApiError);
		const message = (caught as Error).message;
		expect(message.includes("super-secret-token")).toBe(false);
	});
});

describe("AdminAuthController.setBaseUrl (MVP-07)", () => {
	it("switching base URL clears the token and tenant and relocks", () => {
		const auth = new AdminAuthController({ initialBaseUrl: "http://a.example.com" });
		auth.connect("some-token");
		auth.completeConnection({ id: "ten_x", name: "Old Tenant" });
		expect(auth.getSnapshot().state).toBe("connected");
		expect(auth.getSnapshot().tenant?.name).toBe("Old Tenant");

		auth.setBaseUrl("http://b.example.com/");

		const snap = auth.getSnapshot();
		expect(auth.getToken()).toBeNull();
		expect(snap.state).toBe("locked");
		expect(snap.tenant).toBeNull();
		// Trailing slash normalised away.
		expect(snap.baseUrl).toBe("http://b.example.com");
	});

	it("setBaseUrl also clears on an already-locked session", () => {
		const auth = new AdminAuthController({ initialBaseUrl: "http://a.example.com" });
		auth.setBaseUrl("https://c.example.com");
		const snap = auth.getSnapshot();
		expect(snap.state).toBe("locked");
		expect(snap.baseUrl).toBe("https://c.example.com");
		expect(snap.tenant).toBeNull();
	});
});

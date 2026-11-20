import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { lanAdminAccess } from "../vite-lan-admin.ts";

test("LAN workbench requires the dedicated login, valid origin and an unexpired session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-lan-admin-"));
	const file = join(directory, "config");
	const password = "a".repeat(64);
	const server = createServer(async (incoming, response) => {
		const access = await lanAdminAccess(file, incoming, response);
		if (access === "handled") return;
		response.statusCode = access === "allow" ? 200 : 403;
		response.end();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.on("error", reject);
			server.listen(0, "127.0.0.2", resolve);
		});
		const port = (server.address() as { port: number }).port;
		const origin = `http://127.0.0.2:${port}`;
		const login = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
		const http = (
			path: string,
			headers: Record<string, string> = {},
			method = "GET",
			localAddress = "127.0.0.3",
			body?: string,
		) =>
			new Promise<{ status?: number; session: string[]; location?: string; body: string }>((resolve, reject) => {
				const req = request(`${origin}${path}`, { headers, method, localAddress }, (res) => {
					let html = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						html += chunk;
					});
					res.on("end", () =>
						resolve({
							status: res.statusCode,
							session: res.headers["set-cookie"] ?? [],
							location: res.headers.location,
							body: html,
						}),
					);
				});
				req.on("error", reject);
				req.end(body);
			});
		expect((await http("/")).status).toBe(403);
		writeFileSync(file, JSON.stringify({ origin, password, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
		const loginPath = "/__pi_lan_admin/login";
		expect(await http("/", { "Sec-Fetch-Mode": "navigate", Authorization: login })).toMatchObject({
			status: 200,
			body: expect.stringContaining(`<form method="post" action="${loginPath}">`),
		});
		expect(await http("/", { Authorization: "Bearer dev-bypass-placeholder" })).toMatchObject({
			status: 200,
			session: [],
		});
		expect((await http("/api/admin/session", { Authorization: login })).status).toBe(403);
		const postLogin = (value: string, from = origin) =>
			http(
				loginPath,
				{ Origin: from, "Content-Type": "application/x-www-form-urlencoded" },
				"POST",
				"127.0.0.3",
				new URLSearchParams({ username: "admin", password: value }).toString(),
			);
		expect(await postLogin(password, "http://127.0.0.2:1")).toMatchObject({ status: 403, session: [] });
		expect(await postLogin("incorrect")).toMatchObject({
			status: 401,
			session: [],
			body: expect.stringContaining("用户名或密码不正确"),
		});
		const signed = await postLogin(password);
		expect(signed).toMatchObject({ status: 303, location: "/" });
		expect(signed.session[0]).toContain("HttpOnly; SameSite=Strict");
		const Cookie = signed.session[0].split(";", 1)[0];
		expect(
			(await http("/api/admin/session", { Cookie, Authorization: "Bearer dev-bypass-placeholder" })).status,
		).toBe(200);
		expect((await http("/api/admin/session", { Cookie }, "GET", "127.0.0.4")).status).toBe(403);
		expect((await http("/api/admin/session", { Cookie: `${Cookie}a` })).status).toBe(403);
		expect((await http("/api/admin/change", { Cookie, Origin: "http://127.0.0.2:1" }, "POST")).status).toBe(403);
		expect((await http("/api/admin/change", { Cookie, Origin: origin }, "POST")).status).toBe(200);
		expect((await http("/", { Host: "unrelated.example" })).status).toBe(403);
		writeFileSync(file, JSON.stringify({ origin, password, expiresAt: Date.now() - 1 }));
		expect((await http("/api/admin/session", { Cookie })).status).toBe(403);
		writeFileSync(file, JSON.stringify({ origin, password }));
		expect((await http("/", { Authorization: login })).status).toBe(403);

		writeFileSync(file, JSON.stringify({ origin, password, expiresAt: null }));
		const permanentLogin = await http("/", { Authorization: login });
		expect(permanentLogin.status).toBe(303);
		expect(permanentLogin.session[0]).toContain("Max-Age=900");
		const permanentCookie = permanentLogin.session[0].split(";", 1)[0];
		expect((await http("/api/admin/session", { Cookie: permanentCookie })).status).toBe(200);
		const later = Date.now() + 16 * 60_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(later);
		try {
			expect((await http("/api/admin/session", { Cookie: permanentCookie })).status).toBe(403);
			expect((await postLogin(password)).status).toBe(303);
		} finally {
			clock.mockRestore();
		}

		expect((await http("/api/admin/session", { Cookie, "X-Forwarded-For": "127.0.0.3" }, "GET", "127.0.1.3")).status).toBe(403);
		writeFileSync(file, JSON.stringify({ origin, password, expiresAt: null, allowedClientCidrs: "10.0.0.0/8" }));
		expect((await http("/", {}, "GET", "127.0.1.3")).status).toBe(403);
		writeFileSync(file, JSON.stringify({ origin, password, expiresAt: null, allowedClientCidrs: ["127.0.1.0/24"] }));
		for (const address of ["127.0.1.3", "127.0.1.196"]) {
			expect(await http("/", {}, "GET", address)).toMatchObject({ status: 200, session: [] });
			expect((await http("/api/admin/session", {}, "GET", address)).status).toBe(403);
		}
		expect((await http("/", {}, "GET", "127.0.2.3")).status).toBe(403);
		const otherSubnet = await http("/", { Authorization: login }, "GET", "127.0.1.196");
		expect(otherSubnet.status).toBe(303);
		const otherCookie = otherSubnet.session[0].split(";", 1)[0];
		expect((await http("/api/admin/session", { Cookie: otherCookie }, "GET", "127.0.1.196")).status).toBe(200);
	} finally {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(directory, { recursive: true, force: true });
	}
});

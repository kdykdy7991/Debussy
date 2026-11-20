import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIPv4 } from "node:net";

const COOKIE = "pi_lan_admin";
const SESSION_SECONDS = 15 * 60;
const LOGIN_PATH = "/__pi_lan_admin/login";

function loginPage(response: ServerResponse, invalid = false): void {
	response.statusCode = invalid ? 401 : 200;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
	response.end(`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>局域网管理员登录</title>
<style>
body { margin: 12vh auto 2rem; max-width: 24rem; padding: 0 1.25rem; font: 1rem/1.5 system-ui, sans-serif; color: #242522; }
h1 { font-size: 1.5rem; }
label { display: block; margin: 1rem 0; }
input, button { display: block; width: 100%; box-sizing: border-box; padding: .7rem; font: inherit; border: 1px solid #767973; border-radius: .35rem; }
input { margin-top: .35rem; }
button { background: #234c36; color: white; cursor: pointer; }
[role="alert"] { color: #a52323; }
</style>
<main>
<h1>局域网管理员登录</h1>
<p>请填写本机配置文件中 password 字段的值。</p>
${invalid ? '<p role="alert">用户名或密码不正确，请重试。</p>' : ""}
<form method="post" action="${LOGIN_PATH}">
<label>用户名<input name="username" value="admin" autocomplete="username" required></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required autofocus></label>
<button type="submit">登录</button>
</form>
</main>
</html>`);
}

async function readLoginForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
	if (request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") return;
	const chunks: Buffer[] = [];
	let bytes = 0;
	try {
		for await (const chunk of request) {
			const data = Buffer.from(chunk);
			bytes += data.length;
			if (bytes > 1024) return;
			chunks.push(data);
		}
		return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return;
	}
}

export async function lanAdminAccess(
	configFile: string, request: IncomingMessage, response: ServerResponse,
): Promise<"allow" | "handled" | undefined> {
	let config: { origin: URL; password: string; expiresAt: number | null; clientNetworks: BlockList };
	try {
		const local = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown> | null;
		if (!local || typeof local.origin !== "string") return;
		const origin = new URL(local.origin);
		const { expiresAt, allowedClientCidrs = [] } = local;
		if (
			origin.origin !== local.origin || origin.protocol !== "http:" || !isIPv4(origin.hostname) ||
			typeof local.password !== "string" || !/^[\da-f]{64}$/.test(local.password) ||
			(expiresAt !== null && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))
		) return;
		if (!Array.isArray(allowedClientCidrs)) return;
		const clientNetworks = new BlockList();
		clientNetworks.addSubnet(origin.hostname, 24, "ipv4");
		for (const cidr of allowedClientCidrs) {
			const subnet = typeof cidr === "string" ? /^([^/]+)\/(\d{1,2})$/.exec(cidr) : null;
			if (!subnet || !isIPv4(subnet[1]) || Number(subnet[2]) > 32) return;
			clientNetworks.addSubnet(subnet[1], Number(subnet[2]), "ipv4");
		}
		config = { origin, password: local.password, expiresAt, clientNetworks };
	} catch {
		return;
	}

	const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
	const localAddress = request.socket.localAddress?.replace(/^::ffff:/, "");
	if (
		!address || !isIPv4(address) || localAddress !== config.origin.hostname || request.headers.host !== config.origin.host ||
		!config.clientNetworks.check(address, "ipv4")
	) return;

	const method = request.method;
	const path = (request.url ?? "").split("?", 1)[0];
	const isLogin = method === "POST" && path === LOGIN_PATH;
	const writes = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
	if ((writes && request.headers.origin !== config.origin.origin) ||
		(request.headers.origin !== undefined && request.headers.origin !== config.origin.origin)) {
		response.statusCode = 403;
		response.end();
		return "handled";
	}
	const signature = (body: string) => createHmac("sha256", config.password).update(body).digest("hex");
	const cookie = request.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${COOKIE}=`));
	const sent = cookie ? /^(\d{10})\.([\da-f]{64})$/.exec(cookie.slice(COOKIE.length + 1)) : undefined;
	const now = Math.floor(Date.now() / 1000);
	if (!isLogin && sent && +sent[1] > now &&
		timingSafeEqual(Buffer.from(sent[2]), Buffer.from(signature(`${config.origin.origin} ${address} ${sent[1]}`)))) {
		response.setHeader("Cache-Control", "no-store");
		return "allow";
	}

	if (!isLogin && (method !== "GET" || path !== "/")) return;

	const commandLineLogin = !isLogin && request.headers["sec-fetch-mode"] !== "navigate" &&
		request.headers.authorization?.startsWith("Basic ");
	const form = isLogin ? await readLoginForm(request) : undefined;
	if (response.destroyed) return "handled";
	const expected = Buffer.from(commandLineLogin ? `Basic ${Buffer.from(`admin:${config.password}`).toString("base64")}` : config.password);
	const provided = Buffer.from(commandLineLogin ? (request.headers.authorization ?? "") :
		form?.get("username") === "admin" ? (form.get("password") ?? "") : "");
	response.setHeader("Cache-Control", "no-store");
	if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
		const loginTime = Math.floor(Date.now() / 1000);
		const sessionExpiry = loginTime + SESSION_SECONDS;
		const expires = config.expiresAt === null ? sessionExpiry : Math.min(sessionExpiry, Math.floor(config.expiresAt / 1000));
		if (expires <= loginTime) {
			response.statusCode = 403;
			response.end();
			return "handled";
		}
		response.setHeader("Set-Cookie",
			`${COOKIE}=${expires}.${signature(`${config.origin.origin} ${address} ${expires}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expires - loginTime}`);
		response.setHeader("Location", "/");
		response.statusCode = 303;
		response.end();
	} else {
		loginPage(response, isLogin || commandLineLogin === true);
	}
	return "handled";
}

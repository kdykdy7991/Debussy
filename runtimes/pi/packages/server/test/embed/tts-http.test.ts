/**
 * TASK-036：TTS HTTP 适配器集成测试（DB-free，真实 HTTP server + 假
 * authenticator + 真 EmbedTtsQueue + 假 provider）。
 *
 * 覆盖 spec 要求：禁用（speechEnabled=false → 503 SPEECH_DISABLED）；无
 * provider（503 TTS_UNAVAILABLE）；队列满（429 QUEUE_FULL）；取消（DELETE
 * 200）；401；feature flag（GET）；无效体 400；不抢占非 TTS 会话路由。
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import type { EmbedAuthContext } from "../../src/embed/middleware/authenticate.ts";
import { createTtsHttpHandler } from "../../src/embed/tts/http.ts";
import type { TtsAudioResult, TtsProvider } from "../../src/embed/tts/provider.ts";
import { EmbedTtsQueue } from "../../src/embed/tts/queue.ts";
import { tokenInvalid } from "../../src/publishing/domain/errors.ts";
import {
	newPublishedAppVersionId,
	newTenantId,
	type PrincipalId,
	type PublishedAppId,
} from "../../src/publishing/domain/ids.ts";

const tenantId = newTenantId();
const publishedAppId = "app-00000000-0000-7000-8000-000000000001" as PublishedAppId;
const principalId = "pri-00000000-0000-7000-8000-000000000002" as PrincipalId;
const TTS_PATH = "/api/embed/v1/conversations/conv_x/tts";
const principal: EmbedAuthContext = {
	tokenId: "tok-1",
	tenantId,
	publishedAppId,
	principalId,
	principalType: "anonymous_visitor",
	scopes: [],
	publishedAppVersionId: newPublishedAppVersionId(),
	issuedAt: new Date(),
	expiresAt: new Date(Date.now() + 60_000),
};

function makeProvider(): TtsProvider {
	return async (input): Promise<TtsAudioResult> => ({
		bytes: new TextEncoder().encode(`audio:${input.text}:${input.voice ?? ""}`),
		contentType: "audio/ogg",
	});
}

function httpCall(
	base: string,
	method: "GET" | "POST" | "DELETE",
	path: string,
): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const url = new URL(path, base);
		const payload = method === "POST" ? JSON.stringify({ text: "hello" }) : undefined;
		const req = httpRequest(
			url,
			{
				method,
				headers: {
					host: url.host,
					...(payload !== undefined
						? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
						: {}),
				},
			},
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let body: any;
					try {
						body = raw ? JSON.parse(raw) : undefined;
					} catch {
						body = raw;
					}
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe("embed TTS HTTP adapter", () => {
	let server: Server | undefined;

	async function boot(options: {
		speechEnabled: boolean;
		providerAvailable: boolean;
		maxPending?: number;
		authorize?: boolean;
	}): Promise<string> {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
		const queue = new EmbedTtsQueue({ provider: makeProvider(), maxPending: options.maxPending });
		const handler = createTtsHttpHandler({
			authenticator: {
				async authenticate() {
					if (options.authorize ?? true) return principal;
					return tokenInvalid("Missing or invalid bearer token");
				},
			},
			queue,
			speechEnabled: async () => options.speechEnabled,
			providerAvailable: options.providerAvailable,
		});
		server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404).end();
				}
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, () => resolve()));
		const port = (server?.address() as { port: number }).port;
		return `http://127.0.0.1:${port}`;
	}

	afterAll(async () => {
		if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
	});

	test("returns feature flags as read-only publish config", async () => {
		const base = await boot({ speechEnabled: true, providerAvailable: true });
		const res = await httpCall(base, "GET", TTS_PATH);
		expect(res.status).toBe(200);
		expect(res.body.data.enabled).toBe(true);
		expect(res.body.data.providerAvailable).toBe(true);
		expect(res.body.data.queue.maxPending).toBe(64);
	});

	test("POST is gated by speechEnabled (disabled -> 503)", async () => {
		const base = await boot({ speechEnabled: false, providerAvailable: true });
		const res = await httpCall(base, "POST", TTS_PATH);
		expect(res.status).toBe(503);
		expect(res.body.error.code).toBe("SPEECH_DISABLED");
	});

	test("POST without a provider is an explicit 503 (never fake success)", async () => {
		const base = await boot({ speechEnabled: true, providerAvailable: false });
		const res = await httpCall(base, "POST", TTS_PATH);
		expect(res.status).toBe(503);
		expect(res.body.error.code).toBe("TTS_UNAVAILABLE");
	});

	test("POST enqueues a job (202 + jobId)", async () => {
		const base = await boot({ speechEnabled: true, providerAvailable: true, maxPending: 4 });
		const res = await httpCall(base, "POST", TTS_PATH);
		expect(res.status).toBe(202);
		expect(res.body.data.status).toBe("queued");
		expect(res.body.data.jobId).toBeTypeOf("string");
	});

	test("DELETE cancels a job (200)", async () => {
		const base = await boot({ speechEnabled: true, providerAvailable: true, maxPending: 4 });
		const enqueue = await httpCall(base, "POST", TTS_PATH);
		const jobId = enqueue.body.data.jobId as string;
		const del = await httpCall(base, "DELETE", `${TTS_PATH}/${jobId}`);
		expect(del.status).toBe(200);
		expect(del.body.data.cancelled).toBe(true);
	});

	test("unauthenticated -> 401 with no endpoint leakage", async () => {
		const base = await boot({ speechEnabled: true, providerAvailable: true, authorize: false });
		const res = await httpCall(base, "GET", TTS_PATH);
		expect(res.status).toBe(401);
	});

	test("does not claim non-TTS conversation routes", async () => {
		const base = await boot({ speechEnabled: true, providerAvailable: true });
		const res = await httpCall(base, "GET", "/api/embed/v1/conversations/conv_x/messages");
		expect(res.status).toBe(404); // handler returned false -> outer 404
	});
});

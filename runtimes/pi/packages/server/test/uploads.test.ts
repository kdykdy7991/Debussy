import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSessionServices,
	createExtensionRuntime,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Attachment } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { CodingAgentPiSessionBackend } from "../src/coding-agent/index.ts";
import type { PiServer } from "../src/index.ts";
import { connectWebSocketTestClient, type ProtocolTestClient } from "../src/testing/index.ts";
import { createWebSocketServer } from "../src/transports/websocket/index.ts";
import type { HttpRequestHandler } from "../src/types.ts";
import { createDefaultUploadPipeline } from "../src/uploads/pipeline.ts";
import { AttachmentStore } from "../src/uploads/store.ts";
import { createUploadHttpHandler } from "../src/web/uploads.ts";

const TOKEN = "test-token";
const tempDirs: string[] = [];
const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

function makeResourceLoader(): AgentSessionServices["resourceLoader"] {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

interface Harness {
	backend: CodingAgentPiSessionBackend;
	store: AttachmentStore;
	server: PiServer;
	url: string;
	httpBase: string;
	faux: ReturnType<typeof fauxProvider>;
}

async function makeHarness(options: { token?: string; maxFileBytes?: number } = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-upload-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", name: "Faux One", reasoning: true }],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const services: AgentSessionServices = {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader: makeResourceLoader(),
		diagnostics: [],
	};
	const backend = await CodingAgentPiSessionBackend.create({
		cwd,
		agentDir,
		sessionDir: join(root, "sessions"),
		services,
	});

	const store = new AttachmentStore(join(agentDir, "uploads"));
	await store.init();
	const httpHandler: HttpRequestHandler = createUploadHttpHandler({
		store,
		pipeline: createDefaultUploadPipeline(),
		webToken: options.token ?? TOKEN,
		maxFileBytes: options.maxFileBytes ?? 4 * 1024,
		allowedOrigins: ["http://127.0.0.1:*"],
		allowedHosts: ["127.0.0.1", "localhost"],
	});
	const server = createWebSocketServer(backend, { port: 0, attachments: store, httpHandler });
	servers.add(server);
	await server.start();
	const address = server.addresses[0]!;
	const port = Number(address.slice(address.lastIndexOf(":") + 1));
	return {
		backend,
		store,
		server,
		url: `ws://127.0.0.1:${port}/api/pi/v1/ws`,
		httpBase: `http://127.0.0.1:${port}`,
		faux,
	};
}

/** Perform a raw HTTP request and return the parsed JSON body + status. */
function httpCall(options: {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: Buffer;
	base: string;
}): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, options.base);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: { host: url.host, origin: "http://127.0.0.1:5173", ...options.headers },
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
		if (options.body) req.write(options.body);
		req.end();
	});
}

/** Build a multipart/form-data body with one file field. */
function multipartBody(field: string, filename: string, contentType: string, content: Buffer): Buffer {
	const boundary = "----p1testboundary";
	const parts = [
		`--${boundary}\r\n`,
		`Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`,
		`Content-Type: ${contentType}\r\n\r\n`,
		content,
		`\r\n--${boundary}--\r\n`,
	];
	return Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)));
}

function sessionOf(result: unknown): any {
	return (result as { session?: unknown }).session;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
});

describe("HTTP upload endpoints", () => {
	test("POST accepts a text file and returns a ready attachment", async () => {
		const { httpBase } = await makeHarness();
		const body = multipartBody("files", "notes.txt", "text/plain", Buffer.from("hello world\n"));
		const { status, body: json } = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		expect(status).toBe(201);
		const [attachment] = json.attachments as Attachment[];
		expect(attachment.name).toBe("notes.txt");
		expect(attachment.mediaType).toBe("text/plain");
		expect(attachment.status).toBe("ready");
		expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("POST rejects a missing bearer token with 401", async () => {
		const { httpBase } = await makeHarness();
		const body = multipartBody("files", "notes.txt", "text/plain", Buffer.from("hi"));
		const { status, body: json } = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: { "content-type": "multipart/form-data; boundary=----p1testboundary" },
			body,
			base: httpBase,
		});
		expect(status).toBe(401);
		expect(json.error.code).toBe("unauthorized");
	});

	test("POST rejects a wrong bearer token with 401", async () => {
		const { httpBase } = await makeHarness();
		const body = multipartBody("files", "notes.txt", "text/plain", Buffer.from("hi"));
		const { status } = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: "Bearer wrong",
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		expect(status).toBe(401);
	});

	test("POST rejects a mismatched MIME type", async () => {
		const { httpBase } = await makeHarness();
		// A file claiming image/png whose bytes are plain text fails the MIME cross-check.
		const body = multipartBody("files", "fake.png", "image/png", Buffer.from("definitely not a png"));
		const { status, body: json } = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		expect(status).toBe(201);
		const [attachment] = json.attachments as Attachment[];
		expect(attachment.status).toBe("failed");
		expect(attachment.error?.code).toBe("invalid_file");
	});

	test("POST rejects an oversized file with 413", async () => {
		const { httpBase } = await makeHarness({ maxFileBytes: 16 });
		const body = multipartBody("files", "big.txt", "text/plain", Buffer.from("x".repeat(1024)));
		const { status, body: json } = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		expect(status).toBe(413);
		expect(json.error.code).toBe("payload_too_large");
	});

	test("POST rejects an unsupported binary type as restricted", async () => {
		const { httpBase } = await makeHarness();
		// Unknown binary (no magic, NUL bytes) → scan fails → failed attachment.
		const body = multipartBody("files", "data.bin", "application/octet-stream", Buffer.from([0, 1, 2, 3, 0xff]));
		const { status, body: json } = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		expect(status).toBe(201);
		const [attachment] = json.attachments as Attachment[];
		expect(attachment.status).toBe("failed");
	});

	test("GET returns the upload record; DELETE removes an unbound upload", async () => {
		const { httpBase } = await makeHarness();
		const body = multipartBody("files", "notes.txt", "text/plain", Buffer.from("hi"));
		const created = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		const [attachment] = created.body.attachments as Attachment[];
		const got = await httpCall({
			method: "GET",
			path: `/api/pi/v2/uploads/${attachment.id}`,
			headers: { authorization: `Bearer ${TOKEN}` },
			base: httpBase,
		});
		expect(got.status).toBe(200);
		expect(got.body.attachment.id).toBe(attachment.id);
		const deleted = await httpCall({
			method: "DELETE",
			path: `/api/pi/v2/uploads/${attachment.id}`,
			headers: { authorization: `Bearer ${TOKEN}` },
			base: httpBase,
		});
		expect(deleted.status).toBe(204);
		const gone = await httpCall({
			method: "GET",
			path: `/api/pi/v2/uploads/${attachment.id}`,
			headers: { authorization: `Bearer ${TOKEN}` },
			base: httpBase,
		});
		expect(gone.status).toBe(404);
	});
});

describe("session attachment flow over WebSocket", () => {
	test("attach_upload binds a ready upload and prompt injects content while the transcript keeps only the reference", async () => {
		const { httpBase, faux, url } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("got it")]);
		const body = multipartBody("files", "secret.txt", "text/plain", Buffer.from("SECRET FILE CONTENT 12345"));
		const created = await httpCall({
			method: "POST",
			path: "/api/pi/v2/uploads",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "multipart/form-data; boundary=----p1testboundary",
			},
			body,
			base: httpBase,
		});
		const [attachment] = created.body.attachments as Attachment[];
		expect(attachment.status).toBe("ready");

		const client = await connectWebSocketTestClient(url);
		clients.add(client);
		await client.hello();
		const createdSession = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(createdSession.ok).toBe(true);
		if (!createdSession.ok) return;
		const sessionId = sessionOf(createdSession.result).id;

		// Not-ready uploads cannot be attached directly; ours is ready, so bind it.
		const attached = await client.request({
			command: "attach_upload",
			sessionId,
			uploadId: attachment.id,
			scope: "turn",
		});
		expect(attached.ok).toBe(true);
		if (!attached.ok) return;
		expect(sessionOf(attached.result).attachments?.map((a: Attachment) => a.id)).toContain(attachment.id);

		const prompted = await client.request({
			command: "prompt",
			sessionId,
			text: "read the file",
			attachmentIds: [attachment.id],
		});
		expect(prompted.ok).toBe(true);
		if (!prompted.ok) return;
		const transcript = sessionOf(prompted.result).transcript as Array<{
			role: string;
			content: Array<{ type: string; text?: string }>;
		}>;
		const userItem = transcript.find((item) => item.role === "user");
		const userText = userItem?.content.map((part) => part.text ?? "").join("\n") ?? "";
		// Reference-only persistence: the transcript names the file but never leaks its content.
		expect(userText).toContain("[附件: secret.txt]");
		expect(userText).not.toContain("SECRET FILE CONTENT 12345");
		expect(transcript.some((item) => item.role === "assistant")).toBe(true);
	});

	test("attach_upload rejects an upload that is not ready", async () => {
		const { store, url } = await makeHarness();
		// Plant an unbound "restricted" record directly in the store.
		const restricted: Attachment = {
			id: "restricted-1",
			name: "blocked.bin",
			mediaType: "application/octet-stream",
			size: 0,
			sha256: "abc",
			status: "restricted",
			createdAt: 1,
			error: { code: "unsupported_media_type", message: "nope" },
		};
		const { mkdir, writeFile } = await import("node:fs/promises");
		const dir = join(store.root, restricted.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "file.bin"), Buffer.alloc(0));
		await store.adopt(restricted, join(dir, "file.bin"));

		const client = await connectWebSocketTestClient(url);
		clients.add(client);
		await client.hello();
		const createdSession = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(createdSession.ok).toBe(true);
		if (!createdSession.ok) return;
		const sessionId = sessionOf(createdSession.result).id;
		const attached = await client.request({
			command: "attach_upload",
			sessionId,
			uploadId: "restricted-1",
			scope: "turn",
		});
		expect(attached.ok).toBe(false);
		if (!attached.ok) expect(attached.error.code).toBe("invalid_state");
	});
});

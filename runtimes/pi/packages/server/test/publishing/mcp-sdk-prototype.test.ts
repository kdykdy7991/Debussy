import { once } from "node:events";
import { createServer } from "node:http";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { ControlService } from "../../src/publishing/control/service.ts";
import { newMcpServerId, newTenantId } from "../../src/publishing/domain/ids.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
import { connectSecureMcpClient } from "../../src/publishing/mcp/secure-client.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";

describe("official MCP SDK Streamable HTTP prototype", () => {
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((close) => close()));
	});

	it.each(["none", "bearer", "api_key"] as const)(
		"initializes, discovers, calls, aborts, and closes with %s authentication",
		async (authentication) => {
			const credential = "test-mcp-secret";
			let authenticatedRequests = 0;
			const handler = createMcpHandler(
				() => {
					const server = new McpServer({ name: "debussy-test", version: "1.0.0" });
					server.registerResource("logo", "test://logo", { mimeType: "image/png" }, async (uri) => ({
						contents: [
							{
								uri: uri.toString(),
								mimeType: "image/png",
								blob: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=",
							},
						],
					}));
					server.registerTool(
						"echo",
						{
							description: "Echo text",
							inputSchema: fromJsonSchema<{ text: string }>({
								type: "object",
								properties: { text: { type: "string" } },
								required: ["text"],
							}),
						},
						async ({ text }) => ({ content: [{ type: "text", text }], structuredContent: { text } }),
					);
					server.registerTool(
						"slow",
						{
							description: "Wait forever",
							inputSchema: fromJsonSchema<Record<string, never>>({ type: "object" }),
						},
						async () => new Promise(() => undefined),
					);
					return server;
				},
				{ responseMode: "json", keepAliveMs: 0 },
			);
			const httpServer = createServer(async (request, response) => {
				const authorized =
					authentication === "api_key"
						? request.headers["x-mcp-api-key"] === credential && request.headers.authorization === undefined
						: authentication === "bearer"
							? request.headers.authorization === `Bearer ${credential}` &&
								request.headers["x-mcp-api-key"] === undefined
							: request.headers.authorization === undefined && request.headers["x-mcp-api-key"] === undefined;
				if (!authorized) {
					response.writeHead(401).end();
					return;
				}
				authenticatedRequests += 1;
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const address = httpServer.address();
				if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
				const headers = new Headers();
				for (const [name, value] of Object.entries(request.headers)) {
					if (Array.isArray(value)) for (const item of value) headers.append(name, item);
					else if (value !== undefined) headers.set(name, value);
				}
				const webRequest = new Request(`http://127.0.0.1:${address.port}${request.url ?? "/"}`, {
					method: request.method,
					headers,
					body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
				});
				const webResponse = await handler.fetch(webRequest);
				response.statusCode = webResponse.status;
				webResponse.headers.forEach((value, name) => {
					response.setHeader(name, value);
				});
				response.end(Buffer.from(await webResponse.arrayBuffer()));
			});
			httpServer.listen(0, "127.0.0.1");
			await once(httpServer, "listening");
			const address = httpServer.address();
			if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
			closers.push(async () => {
				await handler.close();
				httpServer.closeAllConnections();
				await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			});

			const session = await connectSecureMcpClient({
				endpoint: `http://localhost:${address.port}/mcp`,
				apiKey: authentication === "api_key" ? credential : undefined,
				bearerToken: authentication === "bearer" ? credential : undefined,
				networkPolicy: {
					allowHttp: true,
					allowPrivateNetwork: true,
					allowedPorts: new Set([address.port]),
					timeoutMs: 2_000,
				},
				resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
			});
			closers.push(() => session.close());

			const tools = await session.listTools();
			expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "slow"]);
			if (authentication === "api_key") {
				const tenantId = newTenantId();
				const mcpServerId = newMcpServerId();
				const secretBox = new McpSecretBox(Buffer.alloc(32, 5));
				const revision = {
					tenantId,
					mcpServerId,
					revision: 1,
					transport: "streamable_http" as const,
					endpoint: `http://127.0.0.1:${address.port}/mcp`,
					authentication,
					createdAt: new Date(),
				};
				const control = new ControlService({
					catalog: { tools: [], models: [], knowledgeBases: [] },
					embedBaseUrl: "https://embed.test",
					mcpSecretBox: secretBox,
					repositories: {
						mcpServers: {
							get: async () => ({ status: "enabled", currentRevision: 1 }),
							getRevision: async () => revision,
							setLastTest: async () => true,
							listTools: async () => [],
							addRevision: async () => ({ ...revision, revision: 2 }),
						},
						mcpSecrets: { get: async () => secretBox.seal(tenantId, mcpServerId, credential) },
						audit: { insert: async () => {} },
					} as unknown as PublishingRepositories,
				});
				const tested = await control.testMcpServer({ tenantId, mcpServerId });
				expect(tested).toMatchObject({ ok: true, data: { ok: true, tools: expect.any(Array) } });
				expect(JSON.stringify(tested)).not.toContain(credential);
				const synced = await control.syncMcpTools({ tenantId, mcpServerId });
				expect(synced).toMatchObject({ ok: true, data: { revision: 2, added: ["echo", "slow"] } });
			}
			const result = await session.callTool("echo", { text: "hello" });
			expect(result.structuredContent).toEqual({ text: "hello" });
			const resource = await session.readResource!("test://logo");
			expect(resource.contents[0]).toMatchObject({ uri: "test://logo", mimeType: "image/png" });
			expect(resource.contents[0] && "blob" in resource.contents[0] && resource.contents[0].blob).toContain(
				"iVBORw0KGgo",
			);

			const controller = new AbortController();
			const pending = session.callTool("slow", {}, controller.signal);
			controller.abort();
			await expect(pending).rejects.toThrow();
			await session.close();
			expect(authenticatedRequests).toBeGreaterThanOrEqual(4);
		},
	);

	it("rejects redirects before any redirected target is contacted", async () => {
		let redirectedTargetHits = 0;
		const redirectedTarget = createServer((_request, response) => {
			redirectedTargetHits += 1;
			response.statusCode = 200;
			response.end("should not be reached");
		});
		redirectedTarget.listen(0, "127.0.0.1");
		await once(redirectedTarget, "listening");
		const targetAddress = redirectedTarget.address();
		if (targetAddress === null || typeof targetAddress === "string")
			throw new Error("test target has no TCP address");

		const redirector = createServer((_request, response) => {
			response.statusCode = 302;
			response.setHeader("location", `http://127.0.0.1:${targetAddress.port}/mcp`);
			response.end();
		});
		redirector.listen(0, "127.0.0.1");
		await once(redirector, "listening");
		const redirectAddress = redirector.address();
		if (redirectAddress === null || typeof redirectAddress === "string")
			throw new Error("test redirector has no TCP address");
		closers.push(async () => {
			redirector.closeAllConnections();
			redirectedTarget.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => redirector.close(() => resolve())),
				new Promise<void>((resolve) => redirectedTarget.close(() => resolve())),
			]);
		});

		await expect(
			connectSecureMcpClient({
				endpoint: `http://localhost:${redirectAddress.port}/mcp`,
				apiKey: "must-not-reach-redirect-target",
				networkPolicy: {
					allowHttp: true,
					allowPrivateNetwork: true,
					allowedPorts: new Set([redirectAddress.port]),
					timeoutMs: 2_000,
				},
				resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
			}),
		).rejects.toThrow();
		expect(redirectedTargetHits).toBe(0);
	});
});

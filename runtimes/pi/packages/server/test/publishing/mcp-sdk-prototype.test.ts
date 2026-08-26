import { once } from "node:events";
import { createServer } from "node:http";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { connectSecureMcpClient } from "../../src/publishing/mcp/secure-client.ts";

describe("official MCP SDK Streamable HTTP prototype", () => {
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((close) => close()));
	});

	it("initializes, discovers, calls, aborts, and closes a real server", async () => {
		const handler = createMcpHandler(
			() => {
				const server = new McpServer({ name: "debussy-test", version: "1.0.0" });
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
					{ description: "Wait forever", inputSchema: fromJsonSchema<Record<string, never>>({ type: "object" }) },
					async () => new Promise(() => undefined),
				);
				return server;
			},
			{ responseMode: "json", keepAliveMs: 0 },
		);
		const httpServer = createServer(async (request, response) => {
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
		const result = await session.callTool("echo", { text: "hello" });
		expect(result.structuredContent).toEqual({ text: "hello" });

		const controller = new AbortController();
		const pending = session.callTool("slow", {}, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
	});

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

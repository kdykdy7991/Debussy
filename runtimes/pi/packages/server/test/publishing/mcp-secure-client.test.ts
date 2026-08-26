import { describe, expect, it } from "vitest";
import {
	isPublicMcpAddress,
	McpNetworkPolicyError,
	resolveApprovedMcpAddresses,
	validateMcpEndpoint,
} from "../../src/publishing/mcp/secure-client.ts";

describe("MCP outbound network policy", () => {
	it("accepts HTTPS on an approved port", () => {
		expect(validateMcpEndpoint("https://mcp.example.com/rpc").toString()).toBe("https://mcp.example.com/rpc");
	});

	it.each([
		"http://mcp.example.com/rpc",
		"https://user:secret@mcp.example.com/rpc",
		"https://mcp.example.com:8443/rpc",
		"https://mcp.example.com/rpc#fragment",
	])("rejects an unsafe endpoint: %s", (endpoint) => {
		expect(() => validateMcpEndpoint(endpoint)).toThrow(McpNetworkPolicyError);
	});

	it("requires explicit development policy for HTTP and private ports", () => {
		const url = validateMcpEndpoint("http://localhost:4312/mcp", {
			allowHttp: true,
			allowedPorts: new Set([4312]),
		});
		expect(url.port).toBe("4312");
	});

	it.each([
		"0.0.0.0",
		"127.0.0.1",
		"10.1.2.3",
		"100.64.0.1",
		"169.254.169.254",
		"192.0.2.1",
		"224.0.0.1",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"fe80::1",
		"fc00::1",
	])("classifies non-public address %s", (address) => {
		expect(isPublicMcpAddress(address)).toBe(false);
	});

	it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("classifies public address %s", (address) => {
		expect(isPublicMcpAddress(address)).toBe(true);
	});

	it("rejects the entire hostname when any resolved address is private", async () => {
		const url = validateMcpEndpoint("https://mcp.example.com/rpc");
		await expect(
			resolveApprovedMcpAddresses(url, {}, async () => [
				{ address: "8.8.8.8", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			]),
		).rejects.toThrow("non-public address");
	});

	it("permits local addresses only behind the explicit development switch", async () => {
		const url = validateMcpEndpoint("http://localhost:4312/mcp", {
			allowHttp: true,
			allowedPorts: new Set([4312]),
		});
		await expect(
			resolveApprovedMcpAddresses(url, { allowPrivateNetwork: true }, async () => [
				{ address: "127.0.0.1", family: 4 },
			]),
		).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
	});
});

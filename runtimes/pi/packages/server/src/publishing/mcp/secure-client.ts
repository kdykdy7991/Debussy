import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import {
	type CallToolResult,
	Client,
	type FetchLike,
	StreamableHTTPClientTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import ipaddr from "ipaddr.js";
import { Agent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from "undici";

export const MCP_DEFAULT_TIMEOUT_MS = 15_000;
export const MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MCP_MAX_HEADER_BYTES = 16 * 1024;

export interface McpNetworkPolicy {
	/** Development-only escape hatch for local MCP servers. */
	readonly allowHttp?: boolean;
	/** Development-only escape hatch for loopback/private addresses. */
	readonly allowPrivateNetwork?: boolean;
	readonly allowedPorts?: ReadonlySet<number>;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
}

export interface McpResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export type McpAddressResolver = (hostname: string) => Promise<readonly McpResolvedAddress[]>;

export interface SecureMcpClientOptions {
	readonly endpoint: string;
	readonly bearerToken?: string;
	readonly networkPolicy?: McpNetworkPolicy;
	readonly signal?: AbortSignal;
	/** Test seam. Production callers use the system resolver. */
	readonly resolveAddresses?: McpAddressResolver;
}

export interface SecureMcpClientSession {
	readonly listTools: (signal?: AbortSignal) => Promise<readonly Tool[]>;
	readonly callTool: (
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal?: AbortSignal,
	) => Promise<CallToolResult>;
	readonly close: () => Promise<void>;
}

export class McpNetworkPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpNetworkPolicyError";
	}
}

function endpointPort(url: URL): number {
	if (url.port !== "") return Number(url.port);
	return url.protocol === "https:" ? 443 : 80;
}

function normalizedHostname(url: URL): string {
	return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

export function validateMcpEndpoint(endpoint: string, policy: McpNetworkPolicy = {}): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new McpNetworkPolicyError("MCP endpoint must be an absolute URL");
	}

	if (url.username !== "" || url.password !== "") {
		throw new McpNetworkPolicyError("MCP endpoint must not contain URL credentials");
	}
	if (url.hash !== "") throw new McpNetworkPolicyError("MCP endpoint must not contain a fragment");
	if (url.protocol !== "https:" && !(policy.allowHttp === true && url.protocol === "http:")) {
		throw new McpNetworkPolicyError("MCP endpoint must use HTTPS");
	}

	const port = endpointPort(url);
	const allowedPorts = policy.allowedPorts ?? new Set([443]);
	if (!allowedPorts.has(port)) {
		throw new McpNetworkPolicyError(`MCP endpoint port ${port} is not approved`);
	}
	return url;
}

export function isPublicMcpAddress(address: string): boolean {
	if (!ipaddr.isValid(address)) return false;
	const parsed = ipaddr.process(address);
	return parsed.range() === "unicast";
}

async function systemResolveAddresses(hostname: string): Promise<readonly McpResolvedAddress[]> {
	if (ipaddr.isValid(hostname)) {
		const parsed = ipaddr.process(hostname);
		return [{ address: parsed.toString(), family: parsed.kind() === "ipv4" ? 4 : 6 }];
	}
	const results = await dnsLookup(hostname, { all: true, verbatim: true });
	return results.map((result) => ({ address: result.address, family: result.family === 4 ? 4 : 6 }));
}

export async function resolveApprovedMcpAddresses(
	url: URL,
	policy: McpNetworkPolicy = {},
	resolveAddresses: McpAddressResolver = systemResolveAddresses,
): Promise<readonly McpResolvedAddress[]> {
	const hostname = normalizedHostname(url);
	const addresses = await resolveAddresses(hostname);
	if (addresses.length === 0) throw new McpNetworkPolicyError("MCP endpoint did not resolve to an address");
	for (const resolved of addresses) {
		if (!ipaddr.isValid(resolved.address)) {
			throw new McpNetworkPolicyError("MCP endpoint resolved to an invalid address");
		}
		if (policy.allowPrivateNetwork !== true && !isPublicMcpAddress(resolved.address)) {
			throw new McpNetworkPolicyError("MCP endpoint resolved to a non-public address");
		}
	}
	return addresses;
}

function pinnedLookup(expectedHostname: string, addresses: readonly McpResolvedAddress[]): LookupFunction {
	let nextAddress = 0;
	return (hostname: string, options: LookupOptions, callback): void => {
		if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
			callback(new McpNetworkPolicyError("MCP connection attempted an unapproved hostname"), "", 0);
			return;
		}
		const family = options.family === 4 || options.family === 6 ? options.family : undefined;
		const matching = family === undefined ? addresses : addresses.filter((address) => address.family === family);
		if (matching.length === 0) {
			callback(new McpNetworkPolicyError("MCP endpoint has no approved address for the requested family"), "", 0);
			return;
		}
		if (options.all === true) {
			const all: LookupAddress[] = matching.map((address) => ({ address: address.address, family: address.family }));
			callback(null, all);
			return;
		}
		const selected = matching[nextAddress % matching.length];
		nextAddress += 1;
		callback(null, selected.address, selected.family);
	};
}

function createSecureFetch(
	url: URL,
	addresses: readonly McpResolvedAddress[],
	policy: McpNetworkPolicy,
): {
	readonly fetch: FetchLike;
	readonly dispatcher: Agent;
} {
	const timeoutMs = policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
	const dispatcher = new Agent({
		connect: { lookup: pinnedLookup(normalizedHostname(url), addresses), timeout: timeoutMs },
		connections: 1,
		pipelining: 1,
		maxHeaderSize: MCP_MAX_HEADER_BYTES,
		maxResponseSize: policy.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
	});
	const secureFetch: FetchLike = async (input, init) => {
		const rawTarget = input instanceof Request ? input.url : input.toString();
		const target = new URL(rawTarget, url);
		if (target.origin !== url.origin) {
			throw new McpNetworkPolicyError("MCP request attempted an unapproved origin");
		}
		const fetchInit = { ...init, dispatcher, redirect: "error" } as unknown as UndiciRequestInit;
		const response = await undiciFetch(target, fetchInit);
		// The SDK uses the platform Fetch types while Undici ships structurally
		// equivalent Fetch objects with its own declarations.
		return response as unknown as Response;
	};
	return { fetch: secureFetch, dispatcher };
}

/**
 * Opens a bounded Streamable HTTP session using the official MCP client SDK.
 * DNS is resolved and policy-checked once, then the approved addresses are
 * pinned into Undici's connector for the life of the session.
 */
export async function connectSecureMcpClient(options: SecureMcpClientOptions): Promise<SecureMcpClientSession> {
	const policy = options.networkPolicy ?? {};
	const url = validateMcpEndpoint(options.endpoint, policy);
	const addresses = await resolveApprovedMcpAddresses(url, policy, options.resolveAddresses);
	const { fetch: secureFetch, dispatcher } = createSecureFetch(url, addresses, policy);
	const transport = new StreamableHTTPClientTransport(url, {
		fetch: secureFetch,
		authProvider:
			options.bearerToken === undefined
				? undefined
				: { token: async (): Promise<string> => options.bearerToken ?? "" },
		reconnectionOptions: {
			initialReconnectionDelay: 250,
			maxReconnectionDelay: 1_000,
			reconnectionDelayGrowFactor: 2,
			maxRetries: 0,
		},
		onInsufficientScope: "throw",
	});
	const client = new Client(
		{ name: "debussy-agent-runtime", version: "0.83.0" },
		{ enforceStrictCapabilities: true, defaultCacheTtlMs: 0, listMaxPages: 16 },
	);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		try {
			if (transport.sessionId !== undefined) await transport.terminateSession().catch(() => undefined);
		} finally {
			await client.close().catch(() => undefined);
			await dispatcher.close();
		}
	};
	try {
		await client.connect(transport, {
			signal: options.signal,
			timeout: policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
			maxTotalTimeout: policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
		});
	} catch (error) {
		await close();
		throw error;
	}
	return {
		listTools: async (signal) => {
			const result = await client.listTools(undefined, {
				cacheMode: "bypass",
				signal,
				timeout: policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
				maxTotalTimeout: policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
			});
			return result.tools;
		},
		callTool: (name, argumentsValue, signal) =>
			client.callTool(
				{ name, arguments: argumentsValue },
				{
					signal,
					timeout: policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
					maxTotalTimeout: policy.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
				},
			),
		close,
	};
}

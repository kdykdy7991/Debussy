import type { IncomingMessage, ServerResponse } from "node:http";
import { hostHeaderHostname, matchesPattern } from "../transports/websocket/listener.ts";

export interface HttpError {
	status: number;
	code: string;
	message: string;
}

export interface HttpAuthorizerOptions {
	/** Expected `Authorization: Bearer <token>`. When undefined, no Bearer check is applied. */
	webToken?: string;
	/** Exact or wildcard Origin allowlist, mirroring the WebSocket listener. */
	allowedOrigins?: readonly string[];
	/** Host header allowlist, mirroring the WebSocket listener. */
	allowedHosts?: readonly string[];
}

/** JSON error body shared by every browser-facing HTTP endpoint. */
export function errorBody(response: ServerResponse, error: HttpError): void {
	jsonBody(response, error.status, { error: { code: error.code, message: error.message } });
}

export function jsonBody(response: ServerResponse, status: number, body: unknown): void {
	const encoded = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(encoded),
	});
	response.end(encoded);
}

/** Host/Origin/Bearer checks plus CORS header handling shared by uploads and speech. */
export function createHttpAuthorizer(options: HttpAuthorizerOptions): {
	originAllowed: (origin: string | undefined) => boolean;
	setCorsHeaders: (response: ServerResponse, origin: string | undefined) => void;
	authorize: (request: IncomingMessage) => HttpError | undefined;
} {
	const allowedHosts = options.allowedHosts ?? ["127.0.0.1", "localhost", "::1"];
	const allowedOrigins = options.allowedOrigins;
	const webToken = options.webToken;

	const originAllowed = (origin: string | undefined): boolean => {
		if (allowedOrigins === undefined) return true;
		return origin !== undefined && allowedOrigins.some((allowed) => matchesPattern(origin, allowed));
	};

	const setCorsHeaders = (response: ServerResponse, origin: string | undefined): void => {
		if (origin !== undefined && originAllowed(origin)) {
			response.setHeader("Access-Control-Allow-Origin", origin);
		}
		response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
		response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	};

	const authorize = (request: IncomingMessage): HttpError | undefined => {
		const hostname = hostHeaderHostname(request.headers.host);
		if (hostname === undefined || !allowedHosts.some((allowed) => matchesPattern(hostname, allowed))) {
			return { status: 403, code: "forbidden", message: "Host is not allowed" };
		}
		if (!originAllowed(request.headers.origin)) {
			return { status: 403, code: "forbidden", message: "Origin is not allowed" };
		}
		if (webToken !== undefined) {
			const authorization = request.headers.authorization ?? "";
			const match = authorization.match(/^Bearer\s+(.+)$/);
			if (!match || match[1]!.trim() !== webToken) {
				return { status: 401, code: "unauthorized", message: "Missing or invalid bearer token" };
			}
		}
		return undefined;
	};

	return { originAllowed, setCorsHeaders, authorize };
}

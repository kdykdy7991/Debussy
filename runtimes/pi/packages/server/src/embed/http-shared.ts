/**
 * Embed data-plane 共享 HTTP 工具（spec 8.3 / 13.1）。
 *
 * 统一错误信封、CORS 头与 requestId 回显，供 Exchange / Conversations /
 * Uploads / Realtime 等浏览器端入口复用，避免每个端点各自复制一套。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { newRequestId } from "../publishing/domain/ids.ts";
import { jsonBody } from "../web/http-shared.ts";

/** 统一错误信封 `{ error: { code, message, requestId, retryable } }`（8.3）。 */
export function errorEnvelope(
	code: string,
	message: string,
	requestId: string,
	retryable: boolean,
): { error: { code: string; message: string; requestId: string; retryable: boolean } } {
	return { error: { code, message, requestId, retryable } };
}

/**
 * CORS 头：回显请求 Origin 并允许 embed 端点所需的头/方法。真正的安全边界
 * 是各端点在业务层按 App allowlist 校验 Origin（13.1），CORS 只决定浏览器
 * 是否暴露响应；被拒绝的 Origin 只会看到 403 空数据。
 */
export function setEmbedCorsHeaders(response: ServerResponse, origin: string | undefined): void {
	if (origin !== undefined) response.setHeader("Access-Control-Allow-Origin", origin);
	response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
	response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	response.setHeader("Access-Control-Max-Age", "600");
}

/** 响应 OPTIONS 预检（跨域 JSON POST 需要），204 不携带数据。 */
export function respondPreflight(response: ServerResponse, origin: string | undefined): void {
	setEmbedCorsHeaders(response, origin);
	response.writeHead(204);
	response.end();
}

/** 读取 `X-Request-Id`（存在且非空时回显），否则生成新 id。 */
export function readRequestId(request: IncomingMessage): string {
	const header = request.headers["x-request-id"];
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : newRequestId();
}

export type ReadJsonBodyResult =
	| { readonly kind: "ok"; readonly value: unknown }
	| { readonly kind: "too_large" }
	| { readonly kind: "invalid_json" };

/** 读取请求体并解析 JSON；超过 maxBytes 返回 too_large（映射 413）。 */
export function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<ReadJsonBodyResult> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		request.on("data", (chunk: Buffer) => {
			if (overflow) return; // 继续排空流，客户端才能收到响应
			size += chunk.length;
			if (size > maxBytes) {
				overflow = true;
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (overflow) {
				resolve({ kind: "too_large" });
				return;
			}
			const raw = Buffer.concat(chunks).toString("utf-8");
			if (raw.trim() === "") {
				resolve({ kind: "ok", value: undefined });
				return;
			}
			try {
				resolve({ kind: "ok", value: JSON.parse(raw) as unknown });
			} catch {
				resolve({ kind: "invalid_json" });
			}
		});
		request.on("error", reject);
	});
}

export { jsonBody };

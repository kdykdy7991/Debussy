/**
 * Embed Attachment HTTP API（spec 8.2 / 27.5，TASK-030）。
 *
 * - `POST   /api/embed/v1/conversations/:id/uploads`             上传附件（raw body）
 * - `DELETE /api/embed/v1/conversations/:id/uploads/:attachmentId`  删除本人附件（幂等）
 *
 * 认证先于一切（Bearer Access Token，统一 401）；scope 在 Service 内校验，
 * 越权 = 统一不可用（不做 ID 枚举）。请求头：`x-filename`（必填）、
 * `content-type`（声明类型，与文件头交叉校验）、`x-checksum-sha256`（可选，
 * 提供则校验）、`Idempotency-Key`（上传写操作，spec 8.3）。响应不回显
 * objectKey，对象存储路径对客户端透明。
 *
 * 未配置对象存储时（`service` 为空）上传端点显式 503 RUNTIME_UNAVAILABLE，
 * 不静默退化为磁盘存储（spec 24.1）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type ConversationId, fromPublicId, toPublicId } from "../../publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../publishing/repositories.ts";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../../types.ts";
import { errorEnvelope, jsonBody, readRequestId, respondPreflight, setEmbedCorsHeaders } from "../http-shared.ts";
import type { EmbedAuthContext, EmbedAuthenticator } from "../middleware/authenticate.ts";
import type { RateLimiter } from "../rate-limits/limiter.ts";
import { EMBED_MAX_FILE_BYTES } from "./scan.ts";
import type { AttachmentService } from "./service.ts";

export const EMBED_UPLOAD_MAX_FILENAME_CHARS = 255;
const EMBED_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

const UPLOAD_PATTERN = /^\/api\/embed\/v1\/conversations\/([^/]+)\/uploads$/;
const DELETE_PATTERN = /^\/api\/embed\/v1\/conversations\/([^/]+)\/uploads\/([^/]+)$/;

export interface AttachmentsHttpHandlerOptions {
	/** 未配置（对象存储缺失）时上传端点返回 503。 */
	readonly service: AttachmentService | undefined;
	readonly authenticator: EmbedAuthenticator | undefined;
	/** Idempotency-Key 记录（scope = token principal；同 create 模式）。 */
	readonly repositories: PublishingRepositories;
	readonly idempotencyTtlMs?: number;
	/** 单文件上限；默认 25 MiB（测试注入更小值）。 */
	readonly maxFileBytes?: number;
	readonly onError?: (error: unknown) => void;
	/** 分层限流（TASK-034）：upload POST 按 Principal 计数。 */
	readonly limiter?: RateLimiter;
}

/** 读取 raw body；超过 maxBytes 返回 too_large（继续排空流以收响应）。 */
function readRawBody(
	request: IncomingMessage,
	maxBytes: number,
): Promise<{ readonly kind: "ok"; readonly data: Buffer } | { readonly kind: "too_large" }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		request.on("data", (chunk: Buffer) => {
			if (overflow) return;
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
			resolve({ kind: "ok", data: Buffer.concat(chunks) });
		});
		request.on("error", reject);
	});
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const header = request.headers[name];
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function idempotencyKeyOf(request: IncomingMessage): string | undefined {
	return headerValue(request, "idempotency-key");
}

function isUploadPath(pathname: string): boolean {
	return UPLOAD_PATTERN.test(pathname) || DELETE_PATTERN.test(pathname);
}

export function createAttachmentsHttpHandler(options: AttachmentsHttpHandlerOptions): HttpRequestHandler {
	const service = options.service;
	const maxFileBytes = options.maxFileBytes ?? EMBED_MAX_FILE_BYTES;
	const idempotencyTtlMs = options.idempotencyTtlMs ?? EMBED_IDEMPOTENCY_TTL_MS;

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || !isUploadPath(pathname)) return false;
		if (request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		setEmbedCorsHeaders(response, request.headers.origin);
		const requestId = readRequestId(request);
		response.setHeader("X-Request-Id", requestId);

		try {
			if (service === undefined || options.authenticator === undefined) {
				jsonBody(
					response,
					503,
					errorEnvelope(
						"RUNTIME_UNAVAILABLE",
						"Attachment uploads are not enabled on this platform",
						requestId,
						true,
					),
				);
				return true;
			}
			const principal = await options.authenticator.authenticate(request);
			if (principal instanceof Error) {
				jsonBody(response, 401, errorEnvelope(principal.code, principal.message, requestId, principal.retryable));
				return true;
			}
			// TASK-034：上传维度限流（System/Tenant/App/Principal 最严格；会话量
			// 大时 conversation 层也适用）。超限 429，不读 body。
			const uploadMatch = pathname.match(UPLOAD_PATTERN);
			if (options.limiter !== undefined && uploadMatch !== null && request.method === "POST") {
				const allowed = await options.limiter.check({
					dimension: "uploads",
					scope: {
						tenantId: principal.tenantId,
						publishedAppId: principal.publishedAppId,
						principalId: principal.principalId,
						conversationId: fromPublicId("ConversationId", uploadMatch[1]!) ?? undefined,
					},
				});
				if (!allowed.allowed) {
					jsonBody(response, 429, errorEnvelope("RATE_LIMITED", "Rate limit exceeded", requestId, true));
					return true;
				}
			}
			if (uploadMatch !== null && request.method === "POST") {
				await uploadRoute({
					service,
					repositories: options.repositories,
					idempotencyTtlMs,
					maxFileBytes,
					request,
					response,
					requestId,
					principal,
					conversationIdRaw: uploadMatch[1]!,
				});
				return true;
			}
			const deleteMatch = pathname.match(DELETE_PATTERN);
			if (deleteMatch !== null && request.method === "DELETE") {
				await deleteRoute(service, response, requestId, principal, deleteMatch[1]!, deleteMatch[2]!);
				return true;
			}
			// TASK-031：读取同样全 scope 校验（完成条件：猜中 ID 也无法探测）。
			if (deleteMatch !== null && request.method === "GET") {
				await getRoute(service, response, requestId, principal, deleteMatch[1]!, deleteMatch[2]!);
				return true;
			}
			jsonBody(response, 404, errorEnvelope("NOT_FOUND", "Unknown uploads route", requestId, false));
			return true;
		} catch (error) {
			options.onError?.(error);
			if (!response.headersSent) {
				jsonBody(response, 500, errorEnvelope("INTERNAL", "Internal server error", requestId, true));
			}
			return true;
		}
	};
}

interface UploadRouteContext {
	readonly service: AttachmentService;
	readonly repositories: PublishingRepositories;
	readonly idempotencyTtlMs: number;
	readonly maxFileBytes: number;
	readonly request: IncomingMessage;
	readonly response: ServerResponse;
	readonly requestId: string;
	readonly principal: EmbedAuthContext;
	readonly conversationIdRaw: string;
}

async function uploadRoute(ctx: UploadRouteContext): Promise<void> {
	const { request, response, requestId } = ctx;
	const conversationId = fromPublicId("ConversationId", ctx.conversationIdRaw);
	if (conversationId === null) {
		// 无效 ID 与越权统一表现为不可用（不枚举）。
		jsonBody(response, 404, errorEnvelope("CONVERSATION_NOT_FOUND", "Conversation is unavailable", requestId, false));
		return;
	}
	const filename = headerValue(request, "x-filename");
	if (filename === undefined || filename === "" || filename.length > EMBED_UPLOAD_MAX_FILENAME_CHARS) {
		jsonBody(response, 400, errorEnvelope("INVALID_REQUEST", "x-filename header is required", requestId, false));
		return;
	}
	const contentType = headerValue(request, "content-type");
	const checksum = headerValue(request, "x-checksum-sha256");
	// content-length 先行拦截（body 超限 -> 413，不读流）。
	const declaredLength = request.headers["content-length"];
	if (declaredLength !== undefined) {
		const length = Number(declaredLength);
		if (Number.isFinite(length) && length > maxUploadBytes(ctx.maxFileBytes)) {
			jsonBody(response, 413, errorEnvelope("PAYLOAD_TOO_LARGE", "File exceeds the size limit", requestId, false));
			return;
		}
	}
	const body = await readRawBody(request, maxUploadBytes(ctx.maxFileBytes));
	if (body.kind === "too_large") {
		jsonBody(response, 413, errorEnvelope("PAYLOAD_TOO_LARGE", "File exceeds the size limit", requestId, false));
		return;
	}

	const key = idempotencyKeyOf(request);
	if (key === undefined) {
		const envelope = await buildUploadEnvelope(ctx, conversationId, filename, contentType, checksum, body.data);
		jsonBody(response, envelope.status, envelope.body);
		return;
	}
	const scope = { tenantId: ctx.principal.tenantId, principalId: ctx.principal.principalId };
	const requestHash = `embed.uploads.upload|${conversationId}|${body.data.length}`;
	const began = await ctx.repositories.idempotency.begin(
		scope,
		"embed.uploads.upload",
		key,
		requestHash,
		ctx.idempotencyTtlMs,
	);
	if (began.outcome === "replay") {
		jsonBody(response, began.record.responseStatus ?? 200, began.record.responseBody);
		return;
	}
	if (began.outcome === "conflict") {
		jsonBody(
			response,
			409,
			errorEnvelope("IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different request", requestId, false),
		);
		return;
	}
	if (began.outcome === "in_progress") {
		jsonBody(
			response,
			409,
			errorEnvelope(
				"IDEMPOTENCY_IN_PROGRESS",
				"A request with this idempotency key is already running",
				requestId,
				true,
			),
		);
		return;
	}
	const envelope = await buildUploadEnvelope(ctx, conversationId, filename, contentType, checksum, body.data);
	await ctx.repositories.idempotency.complete(scope, "embed.uploads.upload", key, envelope.status, envelope.body);
	jsonBody(response, envelope.status, envelope.body);
}

function maxUploadBytes(maxFileBytes: number): number {
	// 流读取上限 = 单文件上限（与 content-length 拦截一致）。
	return maxFileBytes;
}

async function buildUploadEnvelope(
	ctx: UploadRouteContext,
	conversationId: ConversationId,
	filename: string,
	contentType: string | undefined,
	checksum: string | undefined,
	data: Buffer,
): Promise<{ status: number; body: unknown }> {
	const result = await ctx.service.upload({
		principal: ctx.principal,
		conversationId,
		filename,
		declaredContentType: contentType,
		declaredChecksumSha256: checksum,
		data,
	});
	if (!result.ok) {
		return {
			status: result.error.httpStatus,
			body: errorEnvelope(result.error.code, result.error.message, ctx.requestId, result.error.retryable),
		};
	}
	return { status: 201, body: { data: result.data, requestId: ctx.requestId } };
}

async function deleteRoute(
	service: AttachmentService,
	response: ServerResponse,
	requestId: string,
	principal: EmbedAuthContext,
	conversationIdRaw: string,
	attachmentIdRaw: string,
): Promise<void> {
	const conversationId = fromPublicId("ConversationId", conversationIdRaw);
	const attachmentId = fromPublicId("AttachmentId", attachmentIdRaw);
	if (conversationId === null || attachmentId === null) {
		// 无效 ID 与越权统一表现为不可用（不枚举）。
		jsonBody(response, 200, { data: { attachmentId: attachmentIdRaw, deleted: false }, requestId });
		return;
	}
	const result = await service.delete(principal, conversationId, attachmentId);
	if (!result.ok) {
		jsonBody(
			response,
			result.error.httpStatus,
			errorEnvelope(result.error.code, result.error.message, requestId, result.error.retryable),
		);
		return;
	}
	jsonBody(response, 200, {
		data: { attachmentId: toPublicId("AttachmentId", attachmentId), deleted: result.data.deleted },
		requestId,
	});
}

/**
 * 读取附件内容（TASK-031）。全 scope 校验在 service 内完成：越权/不存在/
 * 非 ready -> 统一 404（CONVERSATION_NOT_FOUND），不泄露资源存在性。
 * 成功返回原始字节（content-type + filename 响应头），不回显 objectKey。
 */
async function getRoute(
	service: AttachmentService,
	response: ServerResponse,
	requestId: string,
	principal: EmbedAuthContext,
	conversationIdRaw: string,
	attachmentIdRaw: string,
): Promise<void> {
	const conversationId = fromPublicId("ConversationId", conversationIdRaw);
	const attachmentId = fromPublicId("AttachmentId", attachmentIdRaw);
	if (conversationId === null || attachmentId === null) {
		jsonBody(response, 404, errorEnvelope("CONVERSATION_NOT_FOUND", "Attachment is unavailable", requestId, false));
		return;
	}
	const result = await service.getContent(principal, conversationId, attachmentId);
	if (!result.ok) {
		jsonBody(
			response,
			result.error.httpStatus,
			errorEnvelope(result.error.code, result.error.message, requestId, result.error.retryable),
		);
		return;
	}
	response.setHeader("Content-Type", result.data.contentType);
	response.setHeader("Content-Length", String(result.data.data.length));
	response.setHeader("X-Request-Id", requestId);
	// 文件名只用于展示（Content-Disposition），不经文件名派生对象 Key。
	response.setHeader("Content-Disposition", `attachment; filename="${sanitizeHeaderFilename(result.data.filename)}"`);
	response.writeHead(200);
	response.end(result.data.data);
}

/** 文件名进响应头前的卫生处理（去控制字符/引号；不影响对象 Key）。 */
function sanitizeHeaderFilename(filename: string): string {
	return filename.replace(/[\u0000-\u001f"\\]/g, "_");
}

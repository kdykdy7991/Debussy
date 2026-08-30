import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@earendil-works/pi-protocol";
import busboy from "busboy";
import { PiServerError } from "../errors.ts";
import type { PrincipalId, TenantId } from "../publishing/domain/ids.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import { createDefaultUploadPipeline, processUploadFile } from "../uploads/pipeline.ts";
import type { AttachmentStore } from "../uploads/store.ts";
import { DEFAULT_UPLOAD_LIMITS, type UploadPipeline } from "../uploads/types.ts";
import { createHttpAuthorizer, errorBody, type HttpError, jsonBody } from "./http-shared.ts";

/** Base path for the HTTP upload API (same HTTP server as the WebSocket listener). */
export const UPLOADS_PATH = "/api/pi/v2/uploads";

export interface UploadHttpHandlerOptions {
	store: AttachmentStore;
	pipeline?: UploadPipeline;
	maxFileBytes?: number;
	maxFiles?: number;
	/** Expected `Authorization: Bearer <token>`. When undefined, no Bearer check is applied. */
	webToken?: string;
	/** Exact or wildcard Origin allowlist, mirroring the WebSocket listener. */
	allowedOrigins?: readonly string[];
	/** Host header allowlist, mirroring the WebSocket listener. */
	allowedHosts?: readonly string[];
	/**
	 * Ownership stamped onto every upload this handler creates and required on
	 * every read/attach/delete attempt. When omitted the handler is
	 * backwards-compatible but treats the upload as legacy and the cross-tenant
	 * attach hardening still applies (legacy records cannot pass ownership
	 * checks).
	 */
	readonly owner?: { readonly tenantId: TenantId; readonly principalId: PrincipalId };
	onError?: (error: unknown) => void;
}

function uploadIdFrom(pathname: string): string | undefined {
	if (!pathname.startsWith(`${UPLOADS_PATH}/`)) return undefined;
	const id = pathname.slice(UPLOADS_PATH.length + 1);
	if (!id || id.includes("/")) return undefined;
	return decodeURIComponent(id);
}

/** Multipart upload endpoint backed by the shared HTTP server. */
export function createUploadHttpHandler(options: UploadHttpHandlerOptions): HttpRequestHandler {
	const store = options.store;
	const pipeline = options.pipeline ?? createDefaultUploadPipeline();
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_UPLOAD_LIMITS.maxFileBytes;
	const maxFiles = options.maxFiles ?? DEFAULT_UPLOAD_LIMITS.maxFiles;
	const { originAllowed, setCorsHeaders, authorize } = createHttpAuthorizer({
		webToken: options.webToken,
		allowedOrigins: options.allowedOrigins,
		allowedHosts: options.allowedHosts,
	});

	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || !(pathname === UPLOADS_PATH || pathname.startsWith(`${UPLOADS_PATH}/`))) {
			return false;
		}
		const origin = request.headers.origin;
		setCorsHeaders(response, origin);
		// CORS preflight carries no Authorization header, so only Origin is checked.
		if (request.method === "OPTIONS") {
			if (!originAllowed(origin)) {
				errorBody(response, { status: 403, code: "forbidden", message: "Origin is not allowed" });
				return true;
			}
			response.writeHead(204);
			response.end();
			return true;
		}
		const authorization = authorize(request);
		if (authorization) {
			errorBody(response, authorization);
			return true;
		}
		if (request.method === "POST" && pathname === UPLOADS_PATH) {
			await handlePost(request, response);
			return true;
		}
		if (request.method === "GET") {
			const id = uploadIdFrom(pathname);
			if (id !== undefined) {
				await handleGet(id, response);
				return true;
			}
		}
		if (request.method === "DELETE") {
			const id = uploadIdFrom(pathname);
			if (id !== undefined) {
				await handleDelete(id, response);
				return true;
			}
		}
		errorBody(response, { status: 404, code: "not_found", message: "Not found" });
		return true;
	};

	async function handleGet(id: string, response: ServerResponse): Promise<void> {
		try {
			if (options.owner) store.assertOwnership(id, options.owner);
		} catch (error) {
			if (error instanceof PiServerError) {
				errorBody(response, { status: 404, code: "not_found", message: error.message });
				return;
			}
			throw error;
		}
		const record = store.get(id);
		if (!record) {
			errorBody(response, { status: 404, code: "not_found", message: "Unknown upload" });
			return;
		}
		jsonBody(response, 200, { attachment: record.attachment });
	}

	async function handleDelete(id: string, response: ServerResponse): Promise<void> {
		try {
			if (options.owner) store.assertOwnership(id, options.owner);
		} catch (error) {
			if (error instanceof PiServerError) {
				errorBody(response, { status: 404, code: "not_found", message: error.message });
				return;
			}
			throw error;
		}
		const record = store.get(id);
		if (!record) {
			errorBody(response, { status: 404, code: "not_found", message: "Unknown upload" });
			return;
		}
		if (record.attachment.sessionId !== undefined && record.attachment.status !== "removed") {
			errorBody(response, { status: 409, code: "conflict", message: "Upload is attached to a session" });
			return;
		}
		await store.remove(id);
		response.writeHead(204);
		response.end();
	}

	async function handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const tempRoot = await mkdtemp(join(tmpdir(), "pi-upload-"));
		const attachments: Attachment[] = [];
		const adopted: string[] = [];
		let requestError: HttpError | undefined;
		try {
			await new Promise<void>((resolve) => {
				const pending = new Set<Promise<void>>();
				const bb = busboy({
					headers: request.headers,
					limits: { files: maxFiles, fileSize: maxFileBytes + 1, parts: maxFiles + 16 },
				});
				bb.on("file", (_field, stream, info) => {
					const task = (async () => {
						const id = randomUUID();
						const tempPath = join(tempRoot, id);
						const hash = createHash("sha256");
						let size = 0;
						await new Promise<void>((resolveFile, rejectFile) => {
							const out = createWriteStream(tempPath);
							stream.on("data", (chunk: Buffer) => {
								size += chunk.length;
								hash.update(chunk);
							});
							stream.on("error", rejectFile);
							out.on("error", rejectFile);
							out.on("close", () => resolveFile());
							stream.pipe(out);
						});
						if (stream.truncated || size > maxFileBytes) {
							requestError ??= {
								status: 413,
								code: "payload_too_large",
								message: `File exceeds the ${maxFileBytes}-byte limit`,
							};
							return;
						}
						const attachment = await processUploadFile({
							pipeline,
							id,
							originalName: info.filename,
							mediaType: info.mimeType,
							size,
							sha256: hash.digest("hex"),
							tempPath,
							createdAt: Date.now(),
						});
						attachments.push(attachment);
						if (attachment.status === "ready") {
							// Owner stamp: when the handler is configured with an
							// owner (admin tenant + principal) the record carries
							// ownership metadata. Without it the upload is legacy
							// (e.g. test fixtures) and cannot be attached across
							// tenants by any caller.
							await store.adopt(attachment, tempPath, options.owner);
							adopted.push(id);
						}
					})().catch((error: unknown) => {
						requestError ??= {
							status: 400,
							code: "invalid_request",
							message: error instanceof Error ? error.message : String(error),
						};
					});
					pending.add(task);
					void task.finally(() => pending.delete(task));
				});
				bb.on("filesLimit", () => {
					requestError ??= {
						status: 413,
						code: "payload_too_large",
						message: `Too many files (limit ${maxFiles})`,
					};
				});
				bb.on("error", (error: unknown) => {
					requestError ??= {
						status: 400,
						code: "invalid_request",
						message: error instanceof Error ? error.message : "Malformed multipart request",
					};
				});
				bb.on("close", () => {
					void Promise.all(pending).then(() => resolve());
				});
				request.pipe(bb);
			});
			// Roll back any files adopted before a batch-level failure.
			if (requestError) {
				for (const id of adopted) await store.remove(id);
				errorBody(response, requestError);
				return;
			}
			if (attachments.length === 0) {
				errorBody(response, { status: 400, code: "invalid_request", message: "No files were uploaded" });
				return;
			}
			jsonBody(response, 201, { attachments });
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	}
}

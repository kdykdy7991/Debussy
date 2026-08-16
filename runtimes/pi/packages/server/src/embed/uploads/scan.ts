/**
 * Embed upload scanning (spec 13.3 / PD-08 / PD-09, TASK-030).
 *
 * Buffer-based validation: size bounds, filename hygiene, extension allowlist,
 * magic-byte MIME sniffing cross-checked against the declared content type and
 * the extension, and the client-declared SHA-256 checksum. Nothing here writes
 * to node disk — bytes go straight to the object store (spec 24.1: production
 * must not use node disk as the truth source).
 *
 * Rejection reasons are stable and are surfaced to clients via the uniform
 * `UPLOAD_REJECTED` (422) envelope without echoing file contents.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";

/** 单文件上限（spec PD-09 / RuntimeSpec maxFileBytes 25 MiB）。 */
export const EMBED_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const EMBED_MAX_FILENAME_CHARS = 255;
export const EMBED_SHA256_HEX_LENGTH = 64;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "tsv", "log"]);
const PDF_EXTENSIONS = new Set(["pdf"]);

const EXTENSION_MEDIA_TYPE: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	log: "text/plain",
};

export type UploadScanResult =
	| { readonly ok: true; readonly mediaType: string; readonly checksumSha256: string }
	| { readonly ok: false; readonly reason: string };

export interface UploadScanInput {
	readonly data: Buffer;
	readonly filename: string;
	/** 声明媒体类型；提供时与文件头交叉校验（伪造 MIME 拒绝）。 */
	readonly declaredContentType?: string;
	/** 客户端声明的 SHA-256（hex）；提供时校验。 */
	readonly declaredChecksumSha256?: string;
	/** Overrides the 25 MiB default (tests inject smaller limits). */
	readonly maxFileBytes?: number;
}

/**
 * Full scan: filename hygiene -> size bound -> declared checksum verification
 * -> extension/magic-byte/content-type consistency. Returns the authoritative
 * media type (derived from the sniffed bytes + extension).
 */
export function scanUpload(input: UploadScanInput): UploadScanResult {
	const maxFileBytes = input.maxFileBytes ?? EMBED_MAX_FILE_BYTES;
	if (!isSafeFilename(input.filename)) {
		return { ok: false, reason: "invalid_filename" };
	}
	if (input.data.length < 1 || input.data.length > maxFileBytes) {
		return { ok: false, reason: input.data.length > maxFileBytes ? "file_too_large" : "empty_file" };
	}
	const checksum = sha256Hex(input.data);
	if (input.declaredChecksumSha256 !== undefined && !isSha256Hex(input.declaredChecksumSha256)) {
		return { ok: false, reason: "invalid_checksum" };
	}
	if (input.declaredChecksumSha256 !== undefined && input.declaredChecksumSha256.toLowerCase() !== checksum) {
		return { ok: false, reason: "checksum_mismatch" };
	}

	const sniffed = sniffMediaType(input.data);
	if (sniffed === undefined) {
		return { ok: false, reason: "unrecognized_file_type" };
	}
	const extension = extensionOf(input.filename);
	const extensionCategory =
		extension === undefined
			? undefined
			: IMAGE_EXTENSIONS.has(extension)
				? "image"
				: TEXT_EXTENSIONS.has(extension)
					? "text"
					: PDF_EXTENSIONS.has(extension)
						? "pdf"
						: "other";
	if (extensionCategory !== undefined && extensionCategory !== "other" && extensionCategory !== categoryOf(sniffed)) {
		return { ok: false, reason: "mime_mismatch" };
	}
	// 伪造 MIME：声明类型与嗅探类型类别不一致即拒绝。
	if (input.declaredContentType !== undefined && categoryOf(input.declaredContentType) !== categoryOf(sniffed)) {
		return { ok: false, reason: "declared_type_mismatch" };
	}
	// 更具体的媒体类型优先（sniff 只认得 text/plain 时按扩展名细化）。
	const derived = extension === undefined ? undefined : EXTENSION_MEDIA_TYPE[extension];
	return { ok: true, mediaType: derived ?? sniffed, checksumSha256: checksum };
}

export function sha256Hex(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function isSha256Hex(value: string): boolean {
	return /^[0-9a-f]{64}$/i.test(value);
}

function isSafeFilename(filename: string): boolean {
	if (filename === "" || filename.length > EMBED_MAX_FILENAME_CHARS) return false;
	if (filename === "." || filename === "..") return false;
	if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
	// 控制字符不进入 objectKey 派生路径（objectKey 本身也不含文件名）。
	for (const char of filename) {
		if (char.charCodeAt(0) < 0x20) return false;
	}
	return true;
}

function extensionOf(name: string): string | undefined {
	const base = extname(name);
	if (!base) return undefined;
	return base.slice(1).toLowerCase();
}

function startsWith(buffer: Buffer, signature: number[]): boolean {
	if (buffer.length < signature.length) return false;
	for (let index = 0; index < signature.length; index++) {
		if (buffer[index] !== signature[index]) return false;
	}
	return true;
}

function asciiAt(buffer: Buffer, offset: number, expected: string): boolean {
	if (buffer.length < offset + expected.length) return false;
	for (let index = 0; index < expected.length; index++) {
		if (buffer[offset + index] !== expected.charCodeAt(index)) return false;
	}
	return true;
}

function isProbablyText(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 512));
	if (sample.length === 0) return true;
	for (const byte of sample) {
		if (byte === 0) return false;
		if (byte < 0x09) return false;
		if (byte > 0x0d && byte < 0x20) return false;
	}
	return true;
}

function sniffMediaType(buffer: Buffer): string | undefined {
	if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (asciiAt(buffer, 0, "RIFF") && asciiAt(buffer, 8, "WEBP")) return "image/webp";
	if (asciiAt(buffer, 0, "%PDF-")) return "application/pdf";
	if (isProbablyText(buffer)) return "text/plain";
	return undefined;
}

const TEXT_LIKE_APPLICATION = new Set([
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/x-toml",
]);

function categoryOf(mediaType: string): "image" | "text" | "pdf" | "other" {
	const base = mediaType.split(";")[0]!.trim().toLowerCase();
	if (base.startsWith("image/")) return "image";
	if (base.startsWith("text/")) return "text";
	if (base === "application/pdf") return "pdf";
	if (TEXT_LIKE_APPLICATION.has(base)) return "text";
	return "other";
}

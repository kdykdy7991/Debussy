import { extname } from "node:path";
import type { Attachment } from "@earendil-works/pi-protocol";
import type {
	IndexInput,
	IndexResult,
	ParsedAttachmentKind,
	ParseInput,
	ParseResult,
	ScanInput,
	ScanResult,
	UploadPipeline,
} from "./types.ts";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"json",
	"csv",
	"tsv",
	"log",
	"html",
	"htm",
	"xml",
	"yaml",
	"yml",
	"toml",
	"ini",
	"js",
	"ts",
	"tsx",
	"jsx",
	"py",
	"go",
	"rs",
	"c",
	"h",
	"cpp",
	"java",
	"rb",
	"php",
	"sh",
	"bash",
	"sql",
	"css",
	"scss",
	"svelte",
	"vue",
]);
const PDF_EXTENSIONS = new Set(["pdf"]);

const EXTENSION_MEDIA_TYPE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	csv: "text/csv",
	html: "text/html",
	htm: "text/html",
	xml: "text/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	log: "text/plain",
};

function extensionOf(name: string): string | undefined {
	const base = extname(name);
	if (!base) return undefined;
	return base.slice(1).toLowerCase();
}

function startsWith(buffer: Uint8Array, signature: number[]): boolean {
	if (buffer.length < signature.length) return false;
	for (let index = 0; index < signature.length; index++) {
		if (buffer[index] !== signature[index]) return false;
	}
	return true;
}

function asciiAt(buffer: Uint8Array, offset: number, expected: string): boolean {
	if (buffer.length < offset + expected.length) return false;
	for (let index = 0; index < expected.length; index++) {
		if (buffer[offset + index] !== expected.charCodeAt(index)) return false;
	}
	return true;
}

function isProbablyText(buffer: Uint8Array): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 512));
	if (sample.length === 0) return true;
	for (const byte of sample) {
		if (byte === 0) return false;
		if (byte < 0x09) return false;
		if (byte > 0x0d && byte < 0x20) return false;
	}
	return true;
}

function sniffMediaType(buffer: Uint8Array): string | undefined {
	if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (asciiAt(buffer, 0, "RIFF") && asciiAt(buffer, 8, "WEBP")) return "image/webp";
	if (asciiAt(buffer, 0, "%PDF-")) return "application/pdf";
	if (isProbablyText(buffer)) return "text/plain";
	return undefined;
}

function categoryOf(mediaType: string): "image" | "text" | "pdf" | "other" {
	if (mediaType.startsWith("image/")) return "image";
	if (mediaType.startsWith("text/")) return "text";
	if (mediaType === "application/pdf") return "pdf";
	return "other";
}

/**
 * Default pipeline: magic-byte MIME sniffing cross-checked against the file
 * extension, then a text/image/unsupported classification. The indexer is a
 * no-op for now — pages are only counted once a real parser exists.
 */
export function createDefaultUploadPipeline(): UploadPipeline {
	return {
		async scan(input: ScanInput): Promise<ScanResult> {
			const { open } = await import("node:fs/promises");
			const handle = await open(input.path, "r");
			try {
				const buffer = new Uint8Array(512);
				const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
				const head = buffer.subarray(0, bytesRead);
				const sniffed = sniffMediaType(head);
				const extension = extensionOf(input.originalName);
				const extensionCategory =
					extension === undefined
						? undefined
						: extension && IMAGE_EXTENSIONS.has(extension)
							? "image"
							: extension && TEXT_EXTENSIONS.has(extension)
								? "text"
								: extension && PDF_EXTENSIONS.has(extension)
									? "pdf"
									: "other";

				if (sniffed === undefined) {
					return {
						mediaType: input.declaredMediaType ?? "application/octet-stream",
						ok: false,
						reason: "unrecognized_file_type",
					};
				}

				const sniffedCategory = categoryOf(sniffed);
				if (
					extensionCategory !== undefined &&
					extensionCategory !== "other" &&
					extensionCategory !== sniffedCategory
				) {
					return { mediaType: sniffed, ok: false, reason: "mime_mismatch" };
				}

				// Prefer a more specific media type derived from the extension when the
				// sniff only knows "text/plain".
				const derived = extension ? EXTENSION_MEDIA_TYPE[extension] : undefined;
				return { mediaType: derived ?? sniffed, ok: true };
			} finally {
				await handle.close();
			}
		},
		async parse(input: ParseInput): Promise<ParseResult> {
			const category = categoryOf(input.mediaType);
			if (category === "text") return { kind: "text" };
			if (category === "image") return { kind: "image" };
			return {
				kind: "unsupported" satisfies ParsedAttachmentKind,
				error: { code: "unsupported_media_type", message: `Unsupported attachment type: ${input.mediaType}` },
			};
		},
		async index(_input: IndexInput): Promise<IndexResult> {
			return {};
		},
	};
}

/** Run scan → parse → index over a fully received file and produce the attachment record DTO. */
export async function processUploadFile(options: {
	pipeline: UploadPipeline;
	id: string;
	originalName: string;
	mediaType: string;
	size: number;
	sha256: string;
	tempPath: string;
	createdAt: number;
}): Promise<Attachment> {
	const { pipeline, id, originalName, mediaType, size, sha256, tempPath, createdAt } = options;
	const scan = await pipeline.scan({ path: tempPath, originalName, declaredMediaType: mediaType, size });
	if (!scan.ok) {
		return {
			id,
			name: originalName,
			mediaType: scan.mediaType,
			size,
			sha256,
			status: "failed",
			createdAt,
			error: { code: "invalid_file", message: `File rejected: ${scan.reason ?? "unrecognized file type"}` },
		};
	}
	const parsed = await pipeline.parse({ path: tempPath, mediaType: scan.mediaType, originalName });
	if (parsed.kind === "unsupported") {
		return {
			id,
			name: originalName,
			mediaType: scan.mediaType,
			size,
			sha256,
			status: "restricted",
			createdAt,
			error: parsed.error ?? { code: "unsupported_media_type", message: "Unsupported attachment type" },
		};
	}
	const indexed = await pipeline.index({ path: tempPath, mediaType: scan.mediaType, originalName });
	return {
		id,
		name: originalName,
		mediaType: scan.mediaType,
		size,
		sha256,
		status: "ready",
		createdAt,
		pageCount: indexed.pageCount,
	};
}

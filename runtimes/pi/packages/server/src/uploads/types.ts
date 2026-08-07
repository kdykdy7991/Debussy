import type { Attachment } from "@earendil-works/pi-protocol";

/** Version of the on-disk attachment record. Bump and migrate on incompatible changes. */
export const ATTACHMENT_RECORD_VERSION = 1 as const;

/** A persisted attachment record: the wire DTO plus server-internal storage fields. */
export interface StoredAttachment {
	schemaVersion: typeof ATTACHMENT_RECORD_VERSION;
	attachment: Attachment;
	/** Random server-chosen file name under `<root>/<id>/`; never exposed to clients. */
	storageName: string;
	/** Cleanup deadline for unbound or removed attachments; undefined while bound to a session. */
	expiresAt?: number;
}

export interface ScanInput {
	path: string;
	originalName: string;
	declaredMediaType?: string;
	size: number;
}

export interface ScanResult {
	/** Detected media type; the authoritative type stored on the attachment. */
	mediaType: string;
	ok: boolean;
	reason?: string;
}

export type ParsedAttachmentKind = "text" | "image" | "unsupported";

export interface ParseInput {
	path: string;
	mediaType: string;
	originalName: string;
}

export interface ParseResult {
	kind: ParsedAttachmentKind;
	error?: { code: string; message: string };
}

export interface IndexInput {
	path: string;
	mediaType: string;
	originalName: string;
}

export interface IndexResult {
	pageCount?: number;
}

/** Extracts the attachment content kind and final processing status. */
export interface UploadPipeline {
	scan(input: ScanInput): Promise<ScanResult>;
	parse(input: ParseInput): Promise<ParseResult>;
	index(input: IndexInput): Promise<IndexResult>;
}

export const DEFAULT_UPLOAD_LIMITS = {
	/** Per-file payload limit. */
	maxFileBytes: 25 * 1024 * 1024,
	/** Max files accepted in a single multipart request. */
	maxFiles: 10,
	/** Retention for unbound or removed attachments before cleanup. */
	maxAgeMs: 24 * 60 * 60 * 1000,
} as const;

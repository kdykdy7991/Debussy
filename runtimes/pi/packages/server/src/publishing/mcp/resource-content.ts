import type { TextContent } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-protocol";
import { readTextBuffer } from "../../citations/chunker.ts";

export const MCP_IMAGE_MAX_BYTES = 1024 * 1024;
export const MCP_IMAGE_MAX_COUNT = 4;

export interface McpResourceReference {
	readonly uri: string;
	readonly description?: string;
	readonly document_id?: string;
	readonly document_title?: string;
	readonly asset_id?: string;
}

export interface McpDocumentReference {
	readonly document_id: string;
	readonly title?: string;
}

export function mcpResourceToolName(serverId: string): string {
	return `mcp_read_resource_${serverId.replace(/^mcp_/, "").replaceAll("-", "")}`;
}

/** Per-runtime, per-server discovery. Never fetch a model-supplied HTTP URL. */
export class McpResourceReferences {
	private readonly uris = new Map<string, McpResourceReference>();
	private readonly docs = new Map<string, McpDocumentReference>();

	discover(value: unknown, depth = 0, documentId?: string, documentTitle?: string): void {
		if (depth > 12 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) this.discover(item, depth + 1, documentId, documentTitle);
			return;
		}
		const row = value as Record<string, unknown>;
		const owner = typeof row.document_id === "string" ? row.document_id : documentId;
		const title = [
			row.source_name,
			row.document_title,
			row.file_name,
			row.filename,
			row.source,
			row.title,
			documentTitle,
		]
			.find((value): value is string => typeof value === "string" && value.trim().length > 0)
			?.trim()
			.slice(0, 240);
		const description = (
			typeof row.caption === "string"
				? row.caption
				: typeof row.description === "string"
					? row.description
					: undefined
		)?.slice(0, 240);
		if (owner !== undefined) this.rememberDocument({ document_id: owner, ...(title ? { title } : {}) });
		if (typeof row.uri === "string")
			this.remember({
				uri: row.uri,
				...(description ? { description } : {}),
				...(owner ? { document_id: owner } : {}),
				...(title ? { document_title: title } : {}),
			});
		// Existing RAG evidence exposes asset IDs rather than resource_link blocks.
		if (owner !== undefined) {
			const assets = row.asset_ids ?? row.related_assets;
			if (Array.isArray(assets)) {
				for (const asset of assets.slice(0, 256) as unknown[]) {
					const id =
						typeof asset === "string"
							? asset
							: asset !== null && typeof asset === "object"
								? (asset as Record<string, unknown>).asset_id
								: undefined;
					if (typeof id === "string") {
						const caption =
							asset !== null && typeof asset === "object"
								? (asset as Record<string, unknown>).caption
								: undefined;
						this.remember({
							uri: `rag://documents/${encodeURIComponent(owner)}/assets/${encodeURIComponent(id)}`,
							document_id: owner,
							asset_id: id,
							...(title ? { document_title: title } : {}),
							...(typeof caption === "string" && caption
								? { description: caption.slice(0, 240) }
								: description
									? { description }
									: {}),
						});
					}
				}
			}
		}
		for (const child of Object.values(row)) this.discover(child, depth + 1, owner, title);
	}

	merge(other: McpResourceReferences): void {
		for (const document of other.docs.values()) this.rememberDocument(document);
		for (const resource of other.uris.values()) this.remember(resource);
	}

	private rememberDocument(document: McpDocumentReference): void {
		if (document.document_id.length > 2048) return;
		const previous = this.docs.get(document.document_id);
		this.docs.delete(document.document_id);
		this.docs.set(document.document_id, { ...previous, ...document });
		if (this.docs.size > 256) this.docs.delete(this.docs.keys().next().value!);
	}

	private remember(resource: McpResourceReference): void {
		if (resource.uri.length > 2048) return;
		const previous = this.uris.get(resource.uri);
		this.uris.delete(resource.uri);
		this.uris.set(resource.uri, { ...previous, ...resource });
		if (this.uris.size > 256) this.uris.delete(this.uris.keys().next().value!);
	}

	has(uri: string): boolean {
		return this.uris.has(uri);
	}

	list(): readonly string[] {
		return [...this.uris.keys()];
	}

	items(): readonly McpResourceReference[] {
		return [...this.uris.values()];
	}

	documents(): readonly McpDocumentReference[] {
		return [...this.docs.values()];
	}

	get(uri: string): McpResourceReference | undefined {
		const resource = this.uris.get(uri);
		if (!resource) return undefined;
		const title = resource.document_id ? this.docs.get(resource.document_id)?.title : undefined;
		return { ...resource, ...(title ? { document_title: title } : {}) };
	}
}

function imageBlock(data: unknown, mimeType: unknown): ImageContent {
	if (typeof data !== "string" || typeof mimeType !== "string") throw new Error("Invalid MCP image");
	if (data.length > Math.ceil(MCP_IMAGE_MAX_BYTES / 3) * 4) throw new Error("MCP image exceeds 1 MiB");
	if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		throw new Error("Invalid MCP image base64");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new Error("Invalid MCP image base64");
	const valid =
		(mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
		(mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
		(mimeType === "image/gif" && /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) ||
		(mimeType === "image/webp" &&
			bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
			bytes.subarray(8, 12).toString("ascii") === "WEBP");
	if (!valid || bytes.length > MCP_IMAGE_MAX_BYTES) throw new Error("Invalid or unsupported MCP image");
	return { type: "image", data, mimeType };
}

/** Image bytes have a separate budget: never truncate base64 as text. */
export function mcpResultContent(
	result: { content?: unknown; contents?: unknown; structuredContent?: unknown },
	maxTextBytes: number,
	guidance?: Readonly<Record<string, unknown>>,
	references?: McpResourceReferences,
): {
	content: (TextContent | ImageContent)[];
	truncated: boolean;
} {
	const images: ImageContent[] = [];
	let imageBytes = 0;
	const mapBlock = (value: unknown): unknown => {
		if (value === null || typeof value !== "object") return value;
		const block = value as Record<string, unknown>;
		if (block.type === "resource") return { ...block, resource: mapBlock(block.resource) };
		if (
			block.type === "image" ||
			(typeof block.blob === "string" && typeof block.mimeType === "string" && block.mimeType.startsWith("image/"))
		) {
			let image = imageBlock(block.data ?? block.blob, block.mimeType);
			const reference = typeof block.uri === "string" ? references?.get(block.uri) : undefined;
			if (reference?.document_title || reference?.description) {
				image = {
					...image,
					provenance: {
						...(reference.document_title ? { documentTitle: reference.document_title } : {}),
						...(reference.description ? { title: reference.description } : {}),
					},
				};
			}
			imageBytes += Buffer.byteLength(image.data, "base64");
			if (images.length >= MCP_IMAGE_MAX_COUNT || imageBytes > MCP_IMAGE_MAX_BYTES)
				throw new Error("MCP image result exceeds image budget");
			images.push(image);
			return {
				type: "image",
				mimeType: image.mimeType,
				imageIndex: images.length - 1,
				...(typeof block.uri === "string" ? { uri: block.uri } : {}),
			};
		}
		return block;
	};
	const blocks = result.content ?? result.contents;
	const mapped = Array.isArray(blocks) ? blocks.map(mapBlock) : [];
	const bounded = readTextBuffer(
		Buffer.from(
			JSON.stringify({ ...guidance, content: mapped, structuredContent: result.structuredContent }),
			"utf8",
		),
		maxTextBytes,
	);
	return { content: [{ type: "text", text: bounded.text }, ...images], truncated: bounded.truncated };
}

import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

interface ContentNode {
	readonly type: string;
	readonly value?: unknown;
	readonly url?: unknown;
	readonly children?: readonly ContentNode[];
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/**
 * Project visible Markdown onto human-readable prose for speech synthesis.
 *
 * This is deliberately an AST allowlist. Natural-language containers recurse;
 * machine-oriented nodes (code, tables, math, HTML, media, definitions, and
 * other unknown rich content) never reach the TTS sentence buffer.
 */
export function filterSpeechContent(markdown: string): string {
	const root = markdownParser.parse(markdown) as ContentNode;
	return speakBlock(root)
		.split("\n")
		.map((line) =>
			line
				.replace(/[ \t]+/g, " ")
				.replace(/\s+([，。！？；：,.!?;:])/g, "$1")
				.trim(),
		)
		.filter((line) => line !== "")
		.join("\n");
}

function speakBlock(node: ContentNode): string {
	switch (node.type) {
		case "root":
		case "blockquote":
		case "list":
		case "listItem":
			return joinChildren(node, "\n");
		case "paragraph":
		case "heading":
			return joinChildren(node, "");
		default:
			return "";
	}
}

function speakInline(node: ContentNode): string {
	switch (node.type) {
		case "text":
			return typeof node.value === "string" ? node.value : "";
		case "break":
			return "\n";
		case "emphasis":
		case "strong":
		case "delete":
			return joinInlineChildren(node);
		case "link": {
			const label = joinInlineChildren(node).trim();
			const url = typeof node.url === "string" ? node.url : "";
			return label !== "" && label !== url ? label : "";
		}
		default:
			return "";
	}
}

function joinChildren(node: ContentNode, separator: string): string {
	return (node.children ?? [])
		.map((child) =>
			child.type === "paragraph" ||
			child.type === "heading" ||
			child.type === "blockquote" ||
			child.type === "list" ||
			child.type === "listItem"
				? speakBlock(child)
				: speakInline(child),
		)
		.filter((value) => value !== "")
		.join(separator);
}

function joinInlineChildren(node: ContentNode): string {
	return (node.children ?? []).map(speakInline).join("");
}

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent/skills";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import type { SkillDiagnosticRecord } from "../repositories.ts";

export const SKILL_IMPORT_LIMITS = {
	maxArtifactBytes: 5 * 1024 * 1024,
	maxFileBytes: 1024 * 1024,
	maxSkillMarkdownBytes: 256 * 1024,
	maxExpandedBytes: 5 * 1024 * 1024,
	maxFiles: 64,
	maxCompressionRatio: 100,
} as const;

const ALLOWED_EXTENSIONS = new Set([
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".webp",
	".pdf",
]);

export class SkillImportRejected extends Error {
	readonly code: "SKILL_IMPORT_REJECTED" | "SKILL_INVALID";

	constructor(code: "SKILL_IMPORT_REJECTED" | "SKILL_INVALID", message: string) {
		super(message);
		this.code = code;
	}
}

export interface ParsedSkillArtifact {
	readonly filename: string;
	readonly mediaType: "text/markdown" | "application/zip";
	readonly bytes: Uint8Array;
	readonly sourceHash: string;
	readonly name: string;
	readonly description: string;
	readonly instructionText: string;
	readonly disableModelInvocation: boolean;
	readonly diagnostics: readonly SkillDiagnosticRecord[];
}

interface ImportedSkillDiagnostic {
	readonly type: string;
	readonly path?: string;
	readonly message: string;
}

function safeArchivePath(raw: string): string {
	if (raw.includes("\0")) throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "archive path contains NUL");
	const normalized = raw.replace(/\\/g, "/");
	if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
		throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "archive contains an absolute path");
	}
	const parts = normalized.split("/").filter((part) => part !== "");
	if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
		throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "archive contains an unsafe path");
	}
	return parts.join("/");
}

function extension(path: string): string {
	const name = basename(path).toLowerCase();
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot);
}

function validateUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new SkillImportRejected("SKILL_INVALID", `${label} must be valid UTF-8`);
	}
}

function expandArtifact(filename: string, bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
	if (bytes.byteLength === 0 || bytes.byteLength > SKILL_IMPORT_LIMITS.maxArtifactBytes) {
		throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "Skill artifact size is outside the allowed range");
	}
	if (filename.toLowerCase().endsWith(".md")) {
		if (basename(filename).toLowerCase() !== "skill.md") {
			throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "single-file imports must be named SKILL.md");
		}
		if (bytes.byteLength > SKILL_IMPORT_LIMITS.maxSkillMarkdownBytes) {
			throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "SKILL.md exceeds the size limit");
		}
		validateUtf8(bytes, "SKILL.md");
		return new Map([["SKILL.md", bytes]]);
	}
	if (!filename.toLowerCase().endsWith(".zip")) {
		throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "artifact must be SKILL.md or a ZIP archive");
	}

	let fileCount = 0;
	let expandedBytes = 0;
	const files = new Map<string, Uint8Array>();
	let failure: unknown;
	try {
		const unzip = new Unzip((file) => {
			try {
				if (file.name.endsWith("/")) return;
				const path = safeArchivePath(file.name);
				fileCount += 1;
				if (fileCount > SKILL_IMPORT_LIMITS.maxFiles) {
					throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "archive contains too many files");
				}
				if (files.has(path)) {
					throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "archive contains duplicate paths");
				}
				if (!ALLOWED_EXTENSIONS.has(extension(path))) {
					throw new SkillImportRejected("SKILL_IMPORT_REJECTED", `file type is not allowed: ${path}`);
				}
				const maxBytes =
					basename(path).toLowerCase() === "skill.md"
						? SKILL_IMPORT_LIMITS.maxSkillMarkdownBytes
						: SKILL_IMPORT_LIMITS.maxFileBytes;
				if (file.originalSize !== undefined && file.originalSize > maxBytes) {
					throw new SkillImportRejected("SKILL_IMPORT_REJECTED", `file exceeds the size limit: ${path}`);
				}
				if (
					file.originalSize !== undefined &&
					file.originalSize > 0 &&
					(file.size === 0 ||
						(file.size !== undefined && file.originalSize / file.size > SKILL_IMPORT_LIMITS.maxCompressionRatio))
				) {
					throw new SkillImportRejected("SKILL_IMPORT_REJECTED", `compression ratio is too high: ${path}`);
				}
				const chunks: Uint8Array[] = [];
				let fileBytes = 0;
				file.ondata = (error, chunk, final) => {
					if (failure !== undefined) return;
					try {
						if (error !== null) throw error;
						fileBytes += chunk.byteLength;
						expandedBytes += chunk.byteLength;
						if (fileBytes > maxBytes)
							throw new SkillImportRejected("SKILL_IMPORT_REJECTED", `file exceeds the size limit: ${path}`);
						if (expandedBytes > SKILL_IMPORT_LIMITS.maxExpandedBytes)
							throw new SkillImportRejected(
								"SKILL_IMPORT_REJECTED",
								"archive expands beyond the total size limit",
							);
						chunks.push(chunk);
						if (final) {
							const content = new Uint8Array(fileBytes);
							let offset = 0;
							for (const part of chunks) {
								content.set(part, offset);
								offset += part.byteLength;
							}
							files.set(path, content);
						}
					} catch (error) {
						failure = error;
						file.terminate();
					}
				};
				file.start();
			} catch (error) {
				failure = error;
				file.terminate();
			}
		});
		unzip.register(UnzipPassThrough);
		unzip.register(UnzipInflate);
		unzip.push(bytes, true);
		if (failure !== undefined) throw failure;
	} catch (error) {
		if (error instanceof SkillImportRejected) throw error;
		throw new SkillImportRejected("SKILL_IMPORT_REJECTED", "ZIP artifact is invalid or unsupported");
	}
	return files;
}

export async function parseSkillArtifact(filename: string, bytes: Uint8Array): Promise<ParsedSkillArtifact> {
	const files = expandArtifact(filename, bytes);
	const skillFiles = [...files.entries()].filter(([path]) => basename(path).toLowerCase() === "skill.md");
	if (skillFiles.length !== 1) {
		throw new SkillImportRejected("SKILL_INVALID", "artifact must contain exactly one SKILL.md");
	}
	validateUtf8(skillFiles[0]![1], "SKILL.md");
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-skill-import-"));
	try {
		for (const [path, content] of files) {
			const target = join(tempRoot, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, { flag: "wx", mode: 0o600 });
		}
		const loaded = loadSkillsFromDir({ dir: tempRoot, source: "platform-import" });
		const diagnostics: SkillDiagnosticRecord[] = (loaded.diagnostics as readonly ImportedSkillDiagnostic[]).map(
			(diagnostic) => ({
				code: diagnostic.type === "collision" ? "SKILL_NAME_COLLISION" : "SKILL_PARSE_WARNING",
				path: diagnostic.path === undefined ? "SKILL.md" : basename(diagnostic.path),
				message: diagnostic.message,
				severity: diagnostic.type === "collision" ? "error" : "warning",
			}),
		);
		if (loaded.skills.length !== 1 || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
			throw new SkillImportRejected(
				"SKILL_INVALID",
				diagnostics[0]?.message ?? "SKILL.md did not produce exactly one valid Skill",
			);
		}
		const skill = loaded.skills[0]!;
		const instructionText = await readFile(skill.filePath, "utf8");
		return {
			filename,
			mediaType: filename.toLowerCase().endsWith(".zip") ? "application/zip" : "text/markdown",
			bytes,
			sourceHash: createHash("sha256").update(bytes).digest("hex"),
			name: skill.name,
			description: skill.description,
			instructionText,
			disableModelInvocation: skill.disableModelInvocation,
			diagnostics,
		};
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

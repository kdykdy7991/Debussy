import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { MaterializedSkill } from "../../types.ts";
import { expandSkillArtifact } from "../control/skill-import.ts";
import { fromPublicId } from "../domain/ids.ts";
import type { SkillRepository, TenantScope } from "../repositories.ts";
import type { RuntimeSpec } from "../runtime-spec/schema.ts";

const HASH_MARKER = ".dsh-skill-sourcehash";
const READ_ONLY_FILE_MODE = 0o400;

export function isInside(target: string, root: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	if (normalizedTarget === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return normalizedTarget.startsWith(prefix);
}

export interface SkillMaterializerOptions {
	readonly root: string;
	/** Reads original immutable artifacts so ZIP resources survive materialization. */
	readonly skills?: Pick<SkillRepository, "getArtifact" | "getRevision">;
}

export interface SkillMaterializer {
	materialize(spec: RuntimeSpec, scope?: TenantScope): Promise<readonly MaterializedSkill[]>;
	materializeSkills(
		runtimeId: string,
		skills: RuntimeSpec["capabilities"]["skills"],
		scope?: TenantScope,
	): Promise<readonly MaterializedSkill[]>;
}

export function createSkillMaterializer(options: SkillMaterializerOptions): SkillMaterializer {
	const root = resolve(options.root);
	return {
		async materialize(spec, scope) {
			return materializeSkills(spec.publishedAppVersionId, spec.capabilities.skills, scope);
		},
		async materializeSkills(runtimeId, skills, scope) {
			return materializeSkills(runtimeId, skills, scope);
		},
	};

	async function materializeSkills(
		runtimeId: string,
		skills: RuntimeSpec["capabilities"]["skills"],
		scope: TenantScope | undefined,
	): Promise<readonly MaterializedSkill[]> {
		if (skills.length === 0) return [];
		const versionRoot = join(root, runtimeId);
		const materialized: MaterializedSkill[] = [];
		for (const skill of skills) {
			assertSafeName(skill.name);
			const packageRoot = join(versionRoot, skill.name);
			const files = await artifactFiles(skill, options.skills, scope);
			const skillPath = [...files.keys()].find((path) => basename(path).toLowerCase() === "skill.md");
			if (skillPath === undefined) throw new Error(`Skill ${skill.name} artifact has no SKILL.md`);
			await materializeFiles(packageRoot, skill.sourceHash, files);
			const filePath = join(packageRoot, skillPath);
			materialized.push({
				name: skill.name,
				description: skill.description,
				filePath,
				baseDir: dirname(filePath),
				disableModelInvocation: skill.disableModelInvocation,
			});
		}
		return materialized;
	}
}

async function artifactFiles(
	skill: RuntimeSpec["capabilities"]["skills"][number],
	repository: SkillMaterializerOptions["skills"],
	scope: TenantScope | undefined,
): Promise<ReadonlyMap<string, Uint8Array>> {
	if (repository === undefined || scope === undefined) {
		return new Map([["SKILL.md", new TextEncoder().encode(skill.instructionText)]]);
	}
	const skillId = fromPublicId("SkillId", skill.skillId);
	if (skillId === null) throw new Error(`invalid frozen Skill id: ${skill.skillId}`);
	const revision = await repository.getRevision(scope, skillId, skill.revision);
	if (revision === undefined || revision.sourceHash !== skill.sourceHash) {
		throw new Error(`frozen Skill revision is unavailable: ${skill.skillId}@${skill.revision}`);
	}
	const artifact = await repository.getArtifact(scope, revision.artifactId);
	if (artifact === undefined || artifact.sourceHash !== skill.sourceHash) {
		throw new Error(`frozen Skill artifact is unavailable: ${skill.skillId}@${skill.revision}`);
	}
	return expandSkillArtifact(artifact.filename, artifact.content);
}

async function materializeFiles(
	packageRoot: string,
	sourceHash: string,
	files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
	const markerPath = join(packageRoot, HASH_MARKER);
	if ((await hasMarker(markerPath, sourceHash)) && (await stat(markerPath).catch(() => undefined)) !== undefined)
		return;
	await rm(packageRoot, { recursive: true, force: true });
	for (const [path, content] of files) {
		const target = join(packageRoot, path);
		if (!isInside(target, packageRoot)) throw new Error(`unsafe materialized Skill path: ${path}`);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, { flag: "wx", mode: READ_ONLY_FILE_MODE });
	}
	await writeFile(markerPath, sourceHash, { flag: "wx", mode: READ_ONLY_FILE_MODE });
}

async function hasMarker(markerPath: string, sourceHash: string): Promise<boolean> {
	try {
		return (await readFile(markerPath, "utf8")).trim() === sourceHash;
	} catch {
		return false;
	}
}

function assertSafeName(name: string): void {
	if (!/^[a-z0-9-]+$/.test(name) || name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
		throw new Error(`refusing to materialise skill with unsafe name: ${name}`);
	}
}

/**
 * Skill materializer (review doc §4.3).
 *
 * Frozen revisions land in a read-only, server-controlled layout
 * `<root>/<publishedAppVersionId>/<name>/SKILL.md`, keyed/hash-cached per
 * revision so repeated opens skip rewrites. filePath/baseDir stay inside the
 * package dir, which is the boundary the read guard relies on.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillArtifactRecord, SkillRevisionRecord } from "../../src/publishing/repositories.ts";
import { createSkillMaterializer, isInside } from "../../src/publishing/runtime/skill-materializer.ts";
import { type CompilerInput, compileRuntimeSpec } from "../../src/publishing/runtime-spec/compiler.ts";

const catalog = {
	tools: [],
	models: [{ provider: "skdy", modelId: "pi-chat" }],
	knowledgeBases: [],
};

function specWithSkills(skills: CompilerInput["skills"]): ReturnType<typeof compileRuntimeSpec> {
	return compileRuntimeSpec({
		agent: { prompt: "You are a helpful assistant.", model: { provider: "skdy", modelId: "pi-chat" } },
		publishedAppVersionId: "pav_00000000-0000-7000-8000-000000000001",
		catalog,
		skills,
	});
}

const temponaryRoot: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-skill-mat-"));
	temponaryRoot.push(root);
	return root;
}

afterEach(async () => {
	while (temponaryRoot.length > 0) {
		await rm(temponaryRoot.pop()!, { recursive: true, force: true });
	}
});

async function readSkillFile(filePath: string): Promise<string> {
	return readFile(filePath, "utf8");
}

describe("skill materializer", () => {
	it("materialises every bound skill under the version dir", async () => {
		const root = await makeRoot();
		const compiled = specWithSkills([
			{
				skillId: "skl_00000000-0000-7000-8000-000000000001",
				revision: 1,
				sourceHash: "a".repeat(64),
				name: "analyze",
				description: "Answer data questions.",
				instructionText: "# Analyze\nUse the skill body.",
				disableModelInvocation: false,
			},
		]);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;

		const materialized = await createSkillMaterializer({ root }).materialize(compiled.spec);
		expect(materialized).toHaveLength(1);
		const skill = materialized[0]!;
		expect(skill.name).toBe("analyze");
		expect(skill.filePath).toContain(join(root, "pav_00000000-0000-7000-8000-000000000001", "analyze", "SKILL.md"));
		expect(await readSkillFile(skill.filePath)).toBe("# Analyze\nUse the skill body.");
		// Both filePath and baseDir are contained by the package dir boundary.
		expect(isInside(skill.filePath, skill.baseDir)).toBe(true);
		expect(isInside(skill.baseDir, skill.baseDir)).toBe(true);
	});

	it("is idempotent and hash-cached (no rewrite on repeat)", async () => {
		const root = await makeRoot();
		const compiled = specWithSkills([
			{
				skillId: "skl_00000000-0000-7000-8000-000000000001",
				revision: 1,
				sourceHash: "b".repeat(64),
				name: "doc",
				description: "Docs.",
				instructionText: "# Doc\nBody.",
				disableModelInvocation: true,
			},
		]);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		const materializer = createSkillMaterializer({ root });

		const first = await materializer.materialize(compiled.spec);
		const before = await stat(first[0]!.filePath).then((s) => s.mtimeMs);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await materializer.materialize(compiled.spec);

		expect(second).toHaveLength(1);
		expect(second[0]!.filePath).toBe(first[0]!.filePath);
		expect(first[0]!.disableModelInvocation).toBe(true);
		const after = await stat(second[0]!.filePath).then((s) => s.mtimeMs);
		// Cache hit leaves the frozen file untouched.
		expect(after).toBe(before);
	});

	it("invalidates the cache when the SKILL.md body changes", async () => {
		const root = await makeRoot();
		const makeSpec = (body: string) =>
			specWithSkills([
				{
					skillId: "skl_00000000-0000-7000-8000-000000000001",
					revision: 2,
					sourceHash: body === "# V1" ? "c".repeat(64) : "d".repeat(64),
					name: "analyze",
					description: "Answer data questions.",
					instructionText: body,
					disableModelInvocation: false,
				},
			]);
		const materializer = createSkillMaterializer({ root });

		const v1 = makeSpec("# V1");
		expect(v1.ok).toBe(true);
		if (!v1.ok) return;
		const first = await materializer.materialize(v1.spec);
		expect(await readSkillFile(first[0]!.filePath)).toBe("# V1");

		const v2 = makeSpec("# V2");
		expect(v2.ok).toBe(true);
		if (!v2.ok) return;
		await materializer.materialize(v2.spec);
		const secondPath = first[0]!.filePath;
		expect(await readSkillFile(secondPath)).toBe("# V2");
	});

	it("returns an empty list when the spec binds no skills", async () => {
		const root = await makeRoot();
		const compiled = specWithSkills(undefined);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(await createSkillMaterializer({ root }).materialize(compiled.spec)).toEqual([]);
	});

	it("materialises every file from the frozen ZIP artifact", async () => {
		const root = await makeRoot();
		const sourceHash = "f".repeat(64);
		const archive = zipSync({
			"bundle/SKILL.md": strToU8("# Analyze\nSee references/guide.md."),
			"bundle/references/guide.md": strToU8("Reference content."),
			"bundle/assets/template.json": strToU8('{"kind":"template"}'),
		});
		const compiled = specWithSkills([
			{
				skillId: "skill_00000000-0000-7000-8000-000000000001",
				revision: 1,
				sourceHash,
				name: "analyze",
				description: "Answer data questions.",
				instructionText: "# Analyze\nSee references/guide.md.",
				disableModelInvocation: false,
			},
		]);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		const revision = {
			artifactId: "00000000-0000-7000-8000-000000000002",
			sourceHash,
		} as SkillRevisionRecord;
		const artifact = {
			filename: "analyze.zip",
			sourceHash,
			content: archive,
		} as SkillArtifactRecord;
		const materializer = createSkillMaterializer({
			root,
			skills: {
				getRevision: async () => revision,
				getArtifact: async () => artifact,
			},
		});

		const [skill] = await materializer.materialize(compiled.spec, {
			tenantId: "00000000-0000-7000-8000-000000000003",
		} as never);
		expect(await readSkillFile(skill!.filePath)).toContain("references/guide.md");
		expect(await readFile(join(skill!.baseDir, "references", "guide.md"), "utf8")).toBe("Reference content.");
		expect(await readFile(join(skill!.baseDir, "assets", "template.json"), "utf8")).toContain("template");
	});

	it("refuses to materialise an unsafe skill name", async () => {
		const root = await makeRoot();
		const compiled = specWithSkills([
			{
				skillId: "skl_00000000-0000-7000-8000-000000000001",
				revision: 1,
				sourceHash: "e".repeat(64),
				name: "../escape",
				description: "Skip.",
				instructionText: "# Escape",
				disableModelInvocation: false,
			},
		]);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		await expect(createSkillMaterializer({ root }).materialize(compiled.spec)).rejects.toThrow(/unsafe name/);
	});
});

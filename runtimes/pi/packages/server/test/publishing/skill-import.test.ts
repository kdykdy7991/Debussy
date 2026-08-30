import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { parseSkillArtifact, SkillImportRejected } from "../../src/publishing/control/skill-import.ts";

const VALID_SKILL = `---
name: contract-review
description: Review contracts for material risks.
---

# Contract review

Read the contract and report material risks.
`;

describe("Skill artifact import", () => {
	test("parses a single UTF-8 SKILL.md with a stable source hash", async () => {
		const parsed = await parseSkillArtifact("SKILL.md", strToU8(VALID_SKILL));
		expect(parsed.name).toBe("contract-review");
		expect(parsed.description).toBe("Review contracts for material risks.");
		expect(parsed.instructionText).toContain("# Contract review");
		expect(parsed.sourceHash).toMatch(/^[0-9a-f]{64}$/);
		expect(parsed.mediaType).toBe("text/markdown");
	});

	test("parses one Skill and allowed resources from a ZIP without extracting links", async () => {
		const archive = zipSync({
			"contract-review/SKILL.md": strToU8(VALID_SKILL),
			"contract-review/references/checklist.txt": strToU8("Check governing law."),
		});
		const parsed = await parseSkillArtifact("contract-review.zip", archive);
		expect(parsed.name).toBe("contract-review");
		expect(parsed.mediaType).toBe("application/zip");
	});

	test.each([
		["absolute path", { "/tmp/SKILL.md": strToU8(VALID_SKILL) }],
		["parent traversal", { "../SKILL.md": strToU8(VALID_SKILL) }],
		["disallowed executable", { "skill/SKILL.md": strToU8(VALID_SKILL), "skill/run.sh": strToU8("exit 0") }],
	])("rejects %s entries", async (_label, entries) => {
		const archive = zipSync(entries);
		await expect(parseSkillArtifact("unsafe.zip", archive)).rejects.toBeInstanceOf(SkillImportRejected);
	});

	test("tolerates macOS archive metadata alongside the Skill", async () => {
		const archive = zipSync({
			"contract-review/SKILL.md": strToU8(VALID_SKILL),
			"__MACOSX/._SKILL.md": strToU8("AppleDouble"),
			"__MACOSX/contract-review/._SKILL.md": strToU8("AppleDouble"),
			".DS_Store": strToU8("x"),
		});
		const parsed = await parseSkillArtifact("mac.zip", archive);
		expect(parsed.name).toBe("contract-review");
	});

	test("rejects ZIP compression bombs before expanding them", async () => {
		const archive = zipSync({
			"skill/SKILL.md": strToU8(VALID_SKILL),
			"skill/references/huge.txt": strToU8("x".repeat(512 * 1024)),
		});
		await expect(parseSkillArtifact("bomb.zip", archive)).rejects.toMatchObject({
			code: "SKILL_IMPORT_REJECTED",
		});
	});

	test("preserves non-blocking parser diagnostics as warnings", async () => {
		const parsed = await parseSkillArtifact(
			"SKILL.md",
			strToU8("---\nname: Bad Name\ndescription: Still importable.\n---\n\nInstructions."),
		);
		expect(parsed.name).toBe("Bad Name");
		expect(parsed.diagnostics).toEqual([
			expect.objectContaining({ code: "SKILL_PARSE_WARNING", severity: "warning" }),
		]);
	});

	test("rejects a Skill that the shared parser cannot load", async () => {
		const invalid = strToU8("---\nname: valid-name\n---\n\nMissing description.");
		await expect(parseSkillArtifact("SKILL.md", invalid)).rejects.toMatchObject({ code: "SKILL_INVALID" });
	});
});

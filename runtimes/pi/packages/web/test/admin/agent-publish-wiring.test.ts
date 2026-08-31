import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("redesigned Agent publish wiring", () => {
	const pageSource = readFileSync(resolve(__dirname, "../../src/admin/pages/agents-page.tsx"), "utf8");
	const detailSource = readFileSync(resolve(__dirname, "../../src/ui-preview/agent-redesign.tsx"), "utf8");

	it("opens the existing PublishDrawer from the Agent detail publish action", () => {
		expect(pageSource).toContain('onPublish={() => setPublishDrawerMode("open")}');
		expect(pageSource).toContain("<PublishDrawer");
		expect(pageSource).toContain("hasDraft={hasUnsavedChanges}");
	});

	it("reports local form changes so an unsaved draft cannot be published", () => {
		expect(detailSource).toContain("readonly onDirtyChange?: (dirty: boolean) => void;");
		expect(detailSource).toContain("onDirtyChange?.(dirty)");
	});

	it("refreshes Agent publication data after creating a version", () => {
		expect(pageSource).toMatch(
			/onPublished=\{\(\) => \{[\s\S]*?load\(\);[\s\S]*?loadRevisions\(\);[\s\S]*?loadApps\(\);/,
		);
	});

	it("does not label direct toolIds as all available tools", () => {
		expect(pageSource).not.toContain("toolsCount={state.detail.toolIds.length}");
		expect(detailSource).not.toContain("<dt>可用工具</dt>");
	});
});

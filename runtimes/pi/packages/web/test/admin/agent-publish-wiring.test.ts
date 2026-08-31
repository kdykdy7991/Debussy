import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("redesigned Agent publish wiring", () => {
	const pageSource = readFileSync(resolve(__dirname, "../../src/admin/pages/agents-page.tsx"), "utf8");
	const detailSource = readFileSync(resolve(__dirname, "../../src/ui-preview/agent-redesign.tsx"), "utf8");
	const legacyDesignSource = readFileSync(resolve(__dirname, "../../src/admin/agents/agent-design-tab.tsx"), "utf8");
	const revisionSource = readFileSync(resolve(__dirname, "../../src/admin/agents/revision-list.tsx"), "utf8");
	const publishDrawerSource = readFileSync(resolve(__dirname, "../../src/admin/apps/publish-drawer.tsx"), "utf8");

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

	it("creates and immediately activates the published app version", () => {
		expect(publishDrawerSource).toContain("const created = await appApi.createVersion");
		expect(publishDrawerSource).toContain("await appApi.activateVersion({ appId: selectedApp, versionId })");
		expect(publishDrawerSource).toContain("创建并上线");
		expect(publishDrawerSource).toContain("应用已上线");
		expect(publishDrawerSource).not.toContain("应用版本已创建，尚未激活");
	});

	it("shows associated app details without a duplicate create action", () => {
		expect(detailSource).not.toContain("新建发布");
		expect(detailSource).toContain('role="dialog" aria-label={`${selected.name} 应用详情`}');
		expect(detailSource).toContain("Public App ID");
		expect(detailSource).toContain("当前版本 ID");
		expect(pageSource).toContain("onOpenPublishedApp={(appId) => navigate(`/apps/${appId}`)}");
	});

	it("does not label direct toolIds as all available tools", () => {
		expect(pageSource).not.toContain("toolsCount={state.detail.toolIds.length}");
		expect(detailSource).not.toContain("<dt>可用工具</dt>");
		expect(legacyDesignSource).not.toContain("draft.toolIds.length");
		expect(revisionSource).not.toContain("snapshot.toolIds.join");
		expect(publishDrawerSource).not.toContain("snapshot.toolIds.length");
	});

	it("resolves MCP binding names and connection state from the loaded catalog", () => {
		expect(pageSource).toContain(
			'detail.lastTest === null ? "untested" : detail.lastTest.ok ? "connected" : "failed"',
		);
		expect(pageSource).toContain("connectionStatus: catalog?.connectionStatus");
		expect(detailSource).toContain("mergeResourceMetadata(current, mcpServers)");
		expect(detailSource).toContain('{ label: "已连接", on: true }');
		expect(detailSource).not.toContain('item.enabled ? "已连接" : "未连接"');
	});
});

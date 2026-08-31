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

	it("refreshes Agent publication data after publishing", () => {
		expect(pageSource).toMatch(
			/onPublished=\{\(\) => \{[\s\S]*?load\(\);[\s\S]*?loadRevisions\(\);[\s\S]*?loadApps\(\);/,
		);
	});

	it("publishes with a single-one-click publishAgent call (no app/revision selection, no manual create-version/activate UI)", () => {
		expect(publishDrawerSource).toContain("const result = await agentApi.publishAgent(agentId)");
		expect(publishDrawerSource).not.toContain("select-app");
		expect(publishDrawerSource).not.toContain("select-revision");
		expect(publishDrawerSource).not.toContain("appApi.createVersion");
		expect(publishDrawerSource).not.toContain("activateVersion");
		expect(publishDrawerSource).not.toContain("createVersion");
		expect(publishDrawerSource).not.toContain("选择目标应用");
		expect(publishDrawerSource).not.toContain("选择 Agent Revision");
		expect(publishDrawerSource).toContain("发布");
		expect(publishDrawerSource).toContain("已发布");
	});

	it("Agent page shows the designed revision comparison, published summary, and external access", () => {
		expect(detailSource).toContain("未发布");
		expect(detailSource).toContain("当前（草稿）");
		expect(detailSource).toContain("线上（已发布）");
		expect(detailSource).toContain("线上版本信息");
		expect(detailSource).toContain("对外访问");
		expect(detailSource).toContain("打开 Public Chat");
		expect(pageSource).toContain("sourceAgentRevision");
		expect(pageSource).toContain("embedUrl");
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

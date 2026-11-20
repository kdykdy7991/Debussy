import { expect, test } from "vitest";
import {
	addBatchBindings,
	associatedKeys,
	mergeMappingRules,
	removeMappingRule,
	replaceMappingRules,
	toolDifference,
} from "../../src/admin/pages/aaas-current-configuration-page.tsx";

test("批量映射仅添加未登记的选中工具，并保留已有映射", () => {
	const current = [{ mcpServerId: "server", toolName: "first", parameter: "authToken", credentialId: "existing" }];
	const result = addBatchBindings(current, "server", "authToken", ["first", "second"]);
	expect(result).toEqual([...current, { mcpServerId: "server", toolName: "second", parameter: "authToken", credentialId: "tool_credential" }]);
});

test("工具目录按名称识别同数量替换", () => {
	expect(toolDifference(["old", "shared"], ["new", "shared"])).toEqual({ added: ["new"], removed: ["old"] });
});

test("相同来源与目标参数的映射合并为一条规则，并按工具数展示", () => {
	const bindings = ["first", "second", "third"].map((toolName) => ({
		mcpServerId: "server",
		toolName,
		parameter: "authToken",
		credentialId: "tool_credential",
	}));
	expect(mergeMappingRules(bindings)).toEqual([
		{ mcpServerId: "server", credentialId: "tool_credential", parameter: "authToken", toolNames: ["first", "second", "third"] },
	]);
});

test("普通业务参数不会凭空出现在合并后的映射规则中", () => {
	const bindings = [{ mcpServerId: "server", toolName: "first", parameter: "authToken", credentialId: "tool_credential" }];
	expect(mergeMappingRules(bindings).map((rule) => rule.parameter)).toEqual(["authToken"]);
});

test("编辑映射只替换目标规则，保留其他 Server 的映射", () => {
	const bindings = [
		{ mcpServerId: "a", toolName: "one", parameter: "authToken", credentialId: "tool_credential" },
		{ mcpServerId: "b", toolName: "two", parameter: "authToken", credentialId: "tool_credential" },
	];
	const next = replaceMappingRules(
		bindings,
		{ mcpServerId: "a", credentialId: "tool_credential", parameter: "newToken" },
		["one", "three"],
		{ credentialId: "tool_credential", parameter: "authToken" },
	);
	expect(next).toEqual([
		bindings[1],
		{ mcpServerId: "a", toolName: "one", credentialId: "tool_credential", parameter: "newToken" },
		{ mcpServerId: "a", toolName: "three", credentialId: "tool_credential", parameter: "newToken" },
	]);
});

test("移除映射只删除选中的来源与参数组合", () => {
	const bindings = [
		{ mcpServerId: "a", toolName: "one", parameter: "authToken", credentialId: "tool_credential" },
		{ mcpServerId: "a", toolName: "one", parameter: "metricId", credentialId: "tool_credential" },
	];
	expect(
		removeMappingRule(bindings, { mcpServerId: "a", credentialId: "tool_credential", parameter: "authToken" }),
	).toEqual([bindings[1]]);
});

test("关联统计排除固定历史版本和其他配置", () => {
	const base = { status: "enabled" as const, createdAt: "", updatedAt: "" };
	const keys = [
		{ ...base, keyId: "p", name: "p", configurationMode: "platform" as const },
		{
			...base,
			keyId: "c",
			name: "c",
			configurationMode: "configuration" as const,
			orchestrationConfigurationId: "one",
		},
		{
			...base,
			keyId: "x",
			name: "x",
			configurationMode: "configuration" as const,
			orchestrationConfigurationId: "other",
		},
		{ ...base, keyId: "v", name: "v", configurationMode: "version" as const, effectiveConfigurationId: "one" },
	];
	expect(associatedKeys(keys, "one").map((key) => key.keyId)).toEqual(["p", "c"]);
});

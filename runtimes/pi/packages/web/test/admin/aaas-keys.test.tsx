import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { AaasKeysApi, createAaasKey, type RouterCapabilities } from "../../src/admin/api/aaas-keys-api.ts";
import { OrchestrationApi } from "../../src/admin/api/orchestration-api.ts";
import { AdminAppShell } from "../../src/admin/app-shell.tsx";
import { AdminAuthProvider } from "../../src/admin/auth/admin-auth-context.tsx";
import { AaasConfigEditor } from "../../src/admin/pages/aaas-configuration-editor.tsx";
import {
	AdminAaasConfigurationsPage,
	mappingServers,
	validateMappingRows,
	SwitchDefaultModal,
} from "../../src/admin/pages/aaas-configurations-page.tsx";
import {
	AdminAaasKeysPage,
	ConfigurationVersionSelect,
	filterAaasKeys,
} from "../../src/admin/pages/aaas-keys-page.tsx";
import { parseRoute } from "../../src/admin/router.ts";
import { usageLabel } from "../../src/admin/pages/router-execution-detail.tsx";
import { RouterCapabilitiesDrawer } from "../../src/admin/pages/router-key-drawers.tsx";
import { readModelParameters, sameKeyConfiguration, updateMcpToolAllowlist } from "../../src/admin/pages/router-key-form.ts";
import { buildRouterTrajectory, RouterOperationTrajectory, type RouterTrajectoryCall } from "../../src/admin/pages/router-operation-trajectory.tsx";
import { RouterTaskHistory } from "../../src/admin/pages/router-task-history.tsx";
import { AdminUserConversationsPage } from "../../src/admin/pages/user-conversations-page.tsx";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

afterEach(() => vi.unstubAllGlobals());

test("Router detail route renders its own page in place of the execution list", () => {
	const html = renderToStaticMarkup(
		<AdminAuthProvider>
			<AdminUserConversationsPage route={{
				id: "router-executions",
				path: "/conversations/router/key/task/operation",
				params: { keyId: "key", taskId: "task", operationId: "operation" },
			}} />
		</AdminAuthProvider>,
	);
	expect(html).toContain("<h1>Router 执行详情</h1>");
	expect(html).toContain("返回执行记录");
	expect(html).not.toContain("<dialog");
	expect(html).not.toContain("执行来源");
});

test("Router trajectory interleaves exact recorded calls between User input and the final result", () => {
	const start = "2026-11-19T00:00:00.000Z";
	const done = "2026-11-19T00:00:05.000Z";
	const model: RouterTrajectoryCall = {
		id: "model:test", kind: "model", name: "fixture/model", call_index: 1,
		started_at: "2026-11-19T00:00:01.000Z", ended_at: done, duration_ms: 4000,
		outcome: "response_recorded", error_code: null, mcp_server_id: null, mcp_revision: null,
	};
	const tool: RouterTrajectoryCall = {
		...model, id: "mcp:test", kind: "mcp", name: "lookup", call_index: null,
		started_at: "2026-11-19T00:00:04.000Z", duration_ms: 1000,
		outcome: "error", error_code: "MCP_CALL_FAILED", mcp_server_id: "mcp_fixture", mcp_revision: 3,
	};
	const bash: RouterTrajectoryCall = {
		...model, id: "bash:test", kind: "bash", name: "bash", call_index: null,
		started_at: "2026-11-19T00:00:02.000Z", duration_ms: null,
		outcome: "success", bash: { command: "cat result.txt", output: "77" },
	};
	const records = buildRouterTrajectory(
		{ sequence: 1, input: "用户任务", queued_at: start, result: "确认结果", ended_at: done },
		[tool, model, bash],
		[{ sequence: "2", operation_id: "operation", type: "assistant.message", context_committed: true, summary: "确认结果", created_at: done }],
	);
	expect(records.map(({ key, role, abnormal }) => [key, role, abnormal])).toEqual([
		["input", "用户", false], ["model:test", "助手", false], ["bash:test", "工具", false],
		["mcp:test", "工具", true], ["result", "助手", false],
	]);
	expect(records.find(({ key }) => key === "bash:test")).toMatchObject({ preview: "cat result.txt", status: "成功", call: bash });
});

test("Router trajectory offers input and result shortcuts, including empty completed results", () => {
	const api = new AaasKeysApi(new AdminAuthController());
	const time = "2026-11-19T00:00:00.000Z";
	const render = (result: string | null) => renderToStaticMarkup(
		<RouterOperationTrajectory
			api={api}
			path="/router/operations/example/trajectory"
			operationId="example"
			operation={{ sequence: 1, input: "查询知识库", result, queued_at: time, ended_at: result === null ? null : time }}
			events={[]}
			historyError=""
			loadingHistory={false}
		/>,
	);
	expect(render(null)).toContain("查看输入");
	expect(render(null)).toContain("尚无结果");
	expect(render("")).toContain("查看结果");
	expect(render("")).not.toContain("尚无结果");
});

test("Router task history renders task and operation events in the shared trajectory ledger", () => {
	const time = "2026-11-19T00:00:00.000Z";
	const html = renderToStaticMarkup(
		<RouterTaskHistory
			events={[
				{ sequence: "1", operation_id: null, type: "task.created", summary: null, context_committed: null, created_at: time },
				{ sequence: "2", operation_id: "first", type: "user.message", summary: "查询知识库", context_committed: null, created_at: time },
				{ sequence: "3", operation_id: "second", type: "operation.failed", summary: "EXECUTION_FAILED", context_committed: null, created_at: time },
			]}
			operations={[{ id: "first", sequence: 1 }, { id: "second", sequence: 2 }]}
			loading={false}
			error=""
			onRetry={() => {}}
			onLoadMore={() => {}}
		/>,
	);
	const ledger = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
	expect(ledger).toContain("按事件序号排列");
	expect(html).toContain("Task 时间线");
	expect(ledger).not.toContain("第 1 轮");
	expect(html).not.toContain("仅当前轮次");
	expect(ledger.indexOf("创建任务")).toBeLessThan(ledger.indexOf("查询知识库"));
	expect(ledger.indexOf("查询知识库")).toBeLessThan(ledger.indexOf("EXECUTION_FAILED"));
	expect(ledger).toContain('data-error="true"');
	expect(html).toContain("加载更多事件");
});

test("bulk tool selection preserves choices outside the active search and stores exact names without duplicates", () => {
	const existing = ["keep", "ticketTool1"];
	const matches = Array.from({ length: 32 }, (_, index) => `ticketTool${index + 1}`);
	expect(updateMcpToolAllowlist(existing, matches, true)).toEqual(["keep", ...matches]);
	expect(updateMcpToolAllowlist(["keep", ...matches], matches.slice(0, 30), false)).toEqual([
		"keep",
		"ticketTool31",
		"ticketTool32",
	]);
});

test("the configuration drawer keeps save and loading feedback together", () => {
	const html = renderToStaticMarkup(
		<AdminAuthProvider>
			<RouterCapabilitiesDrawer
				keyRecord={{ keyId: "fixture", name: "测试 Key", status: "enabled", createdAt: "", updatedAt: "" }}
				api={new AaasKeysApi(new AdminAuthController())}
				onSaved={() => {}}
				onClose={() => {}}
			/>
		</AdminAuthProvider>,
	);
	expect(html).toContain("配置 API Key · 测试 Key");
	const footer = html.slice(html.indexOf("<footer"));
	expect(footer).toContain("正在加载配置…");
	expect(footer).toContain("保存配置");
	expect(footer).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*form="[^"]+")(?=[^>]*aria-describedby="[^"]+")(?=[^>]*disabled)[^>]*>保存配置<\/button>/);
});

test("structured parameter edits preserve previously saved aliases and untouched values", () => {
	const saved = { max_tokens: 1000, top_p: 0.9, temperature: null, frequencyPenalty: "0.3" };
	expect(readModelParameters(saved, { maxTokens: "1200", presencePenalty: "-0.25" }, null)).toEqual({
		parameters: { ...saved, max_tokens: 1200, presencePenalty: -0.25 },
	});
	expect(readModelParameters(saved, { topP: "" }, null)).toEqual({
		parameters: { max_tokens: 1000, temperature: null, frequencyPenalty: "0.3" },
	});
	expect(readModelParameters(saved, { maxTokens: "1.2" }, null).error).toContain("正整数");
	expect(readModelParameters(saved, { temperature: "1e999" }, null).error).toContain("有效数字");
});

test("advanced JSON validates the API shape and key ordering does not mark a draft dirty", () => {
	const saved: RouterCapabilities = {
		model: { provider: "p", model_id: "m", parameters: { maxTokens: 300, topP: 1 } },
		mcp_servers: [],
		skills: [],
		execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
	};
	const edited = readModelParameters(saved.model.parameters, {}, '{"topP":1,"maxTokens":300}');
	expect(sameKeyConfiguration(saved, { ...saved, model: { ...saved.model, parameters: edited.parameters ?? {} } })).toBe(true);
	expect(sameKeyConfiguration(saved, { ...saved, execution_policy: { ...saved.execution_policy, max_pending_operations: 3 } })).toBe(false);
	expect(sameKeyConfiguration(saved, { ...saved, local_tools: [] })).toBe(true);
	expect(sameKeyConfiguration(saved, { ...saved, local_tools: ["bash"] })).toBe(false);
	expect(readModelParameters({}, {}, "[]").error).toContain("JSON 对象");
	expect(readModelParameters({}, {}, '{"topP":{"nested":1}}').error).toContain("布尔值");
	expect(readModelParameters({}, {}, '{"unknown":1}').error).toContain("不支持");
});

test("mapping options use the frozen MCP revision and reject duplicate or invalid mappings", () => {
	const snapshot = { systemPrompt: "", modelId: "model", parameters: {}, skills: [], mcpServers: [{ mcpServerId: "mcp_1", revision: 1, toolNames: ["lookup"] }] };
	const details = [{ id: "mcp_1", name: "工单", revisions: [{ revision: 1, tools: [{ name: "lookup", inputSchema: { properties: { authToken: { type: "string" }, count: { type: "number" } } } }] }, { revision: 2, tools: [{ name: "lookup", inputSchema: { properties: { newer: { type: "string" } } } }] }] }] as unknown as Parameters<typeof mappingServers>[1];
	const options = mappingServers(snapshot, details);
	expect(options[0]?.tools[0]?.parameters).toEqual(["authToken"]);
	const row = { mcpServerId: "mcp_1", toolName: "lookup", parameter: "authToken", credentialId: "account_token" };
	expect(validateMappingRows([row], options)).toBeNull();
	expect(validateMappingRows([row, row], options)).toContain("重复");
	expect(validateMappingRows([{ ...row, parameter: "newer" }], options)).toContain("请选择");
	expect(validateMappingRows([{ ...row, credentialId: "1invalid" }], options)).toContain("凭据标识");
	expect(() => mappingServers(snapshot, [])).toThrow("修订不可用");
});

test("standalone editor publishes directly without a separate draft step", () => {
	const auth = new AdminAuthController();
	const html = renderToStaticMarkup(
		<AaasConfigEditor
			api={new OrchestrationApi(auth)}
			catalog={{
				models: [
					{
						id: "model-a",
						name: "Model A",
						provider: "p",
						parameterCapabilities: {
							reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"] },
						},
					},
				],
				applications: [],
			}}
			configId={null}
			defaultVersionId={null}
			onBack={() => {}}
			onPublished={() => {}}
			onOpenVersions={() => {}}
		/>,
	);
	expect(html).toContain("发布版本");
	expect(html).not.toContain("保存草稿");
	expect(html).toContain("未发布");
	expect(html).toContain("模型与推理");
	expect(html).toContain("MCP Server");
	expect(html).toContain("运行策略");
	expect(html).not.toContain("Temperature");
	expect(html).not.toContain("执行超时");
	expect(html).not.toContain("新建接入");
});

test("configuration selector shows actual published version metadata", () => {
	const html = renderToStaticMarkup(
		<ConfigurationVersionSelect
			versions={[
				{
					configuration_id: "config-id",
					orchestration_version_id: "version-id",
					name: "Operations",
					revision: 3,
					model_id: "model-a",
					created_at: "2026-11-17T00:00:00Z",
				},
			]}
			value="version-id"
			onSelect={() => {}}
		/>,
	);
	expect(html).toContain("Operations · v3 · model-a");
	expect(html).toContain('value="version-id"');
	expect(html).not.toContain("<input");
});

test("search and status filter use real Key data", () => {
	const keys = [
		{ keyId: "id-1", name: "First", status: "enabled" as const, createdAt: "", updatedAt: "" },
		{ keyId: "id-2", name: "Second", status: "disabled" as const, createdAt: "", updatedAt: "" },
	];
	expect(filterAaasKeys(keys, " first ", "enabled")).toEqual([keys[0]]);
	expect(filterAaasKeys(keys, "ID-2", "all")).toEqual([keys[1]]);
	expect(filterAaasKeys(keys, "first", "disabled")).toEqual([]);
});

test("create publishes the one-time Key with only name and optional version", async () => {
	const auth = new AdminAuthController();
	auth.connect("admin-token");
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ data: { keyId: "key-id", token: "one-time-secret" } }), { status: 201 }),
		);
	vi.stubGlobal("fetch", fetchMock);
	const issued = vi.fn();
	await expect(createAaasKey(new AaasKeysApi(auth), "client", issued, "ver-1")).resolves.toBeUndefined();
	expect(issued).toHaveBeenCalledWith("one-time-secret");
	const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toBe("/api/admin/v1/aaas/keys");
	expect(init.method).toBe("POST");
	expect(init.body).toBe(JSON.stringify({ name: "client", orchestration_version_id: "ver-1" }));
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("unknown configuration is not presented as an empty configuration", () => {
	const html = renderToStaticMarkup(
		<AdminAuthProvider>
			<AdminAaasKeysPage />
		</AdminAuthProvider>,
	);
	expect(html).toContain("搜索名称、Key ID");
	expect(html).toContain("创建 API Key");
	expect(html).toContain("全部状态");
	expect(html).not.toContain("<select");
	expect(html).not.toContain("总 Key 数");
	expect(html).not.toContain("尚未绑定默认执行配置");
	expect(html).not.toContain("暂无 API Key");
});

test("independent navigation and Key admin API use the existing admin authentication", async () => {
	expect(parseRoute("/aaas-keys").id).toBe("aaas-keys");
	expect(parseRoute("/aaas-configurations").id).toBe("aaas-configurations");
	const shell = renderToStaticMarkup(<AdminAppShell />);
	expect(shell).toContain("接入管理");
	expect(shell).not.toContain("AaaS 执行配置");
	const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
	auth.connect("admin-test-token");
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify({ data: { configured: true } }), { status: 200 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	const api = new AaasKeysApi(auth);
	expect(await api.request("/platform-configuration")).toEqual({ configured: true });
	const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toBe("http://localhost/api/admin/v1/aaas/keys/platform-configuration");
	expect(url).not.toContain("admin-test-token");
});

test("unauthorized responses invalidate the admin session", async () => {
	const auth = new AdminAuthController();
	auth.connect("admin-token");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ error: { message: "未授权" } }), { status: 401 })),
	);
	await expect(new AaasKeysApi(auth).request()).rejects.toThrow("未授权");
	expect(auth.getToken()).toBeNull();
});

test("recoverable Key is fetched only on an explicit admin request", async () => {
	const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
	auth.connect("admin-token");
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify({ data: { token: "ak_test.secret" } }), { status: 200 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	const api = new AaasKeysApi(auth);
	expect(await api.request("/key-id/secret", "POST", {})).toEqual({ token: "ak_test.secret" });
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toBe("http://localhost/api/admin/v1/aaas/keys/key-id/secret");
	expect(init.method).toBe("POST");
	expect(init.body).toBe("{}");
});

test("configuration page shows an explicit unbound empty state and no Key metrics", () => {
	const html = renderToStaticMarkup(
		<AdminAuthProvider>
			<AdminAaasConfigurationsPage />
		</AdminAuthProvider>,
	);
	expect(html).toContain("AaaS 执行配置");
	expect(html).toContain("新建配置");
	expect(html).toContain("尚未配置平台执行环境");
	expect(html).toContain("配置列表");
	expect(html).not.toContain("总 Key 数");
	expect(html).not.toContain("已禁用");
	expect(html).not.toContain("平台执行配置</button>");
});

test("switch-default confirmation states target, current default and frozen Run semantics", () => {
	const html = renderToStaticMarkup(
		<SwitchDefaultModal
			versions={[
				{
					configuration_id: "cfg-1",
					orchestration_version_id: "orv_ver-1",
					name: "Operations",
					revision: 3,
					model_id: "model-a",
					created_at: "2026-11-17T00:00:00Z",
				},
			]}
			defaultInfo={{
				configId: "cfg-0",
				versionId: "ver-0",
				name: "Previous",
				revision: 1,
				modelName: "Model A",
				mcpCount: 1,
				skillCount: 1,
				bindings: 0,
			}}
			initialVersionId="ver-1"
			catalog={{ models: [], applications: [] }}
			onCancel={() => {}}
			onConfirm={() => {}}
			busy={false}
		/>,
	);
	expect(html).toContain("切换默认版本");
	expect(html).toContain("Operations · v3");
	expect(html).toContain("Previous · v1");
	expect(html).toContain("新受理的 Run 将使用此版本");
	expect(html).toContain("已受理的 Run 保留其冻结的配置快照");
	expect(html).toContain("确认切换");
});

test("API Key page no longer hosts the execution configuration tab", () => {
	const html = renderToStaticMarkup(
		<AdminAuthProvider>
			<AdminAaasKeysPage />
		</AdminAuthProvider>,
	);
	expect(html).toContain("筛选 Key 状态");
	expect(html).not.toContain("旧配置与历史");
	expect(html).not.toContain("旧配置关联");
	expect(html).not.toContain("平台执行配置</button>");
	expect(html).not.toContain("管理默认执行配置");
});

test("Router provisioning selects direct capability scope and preserves unknown Usage", async () => {
	const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
	auth.connect("admin-test-token");
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { token: "fixture-token" } }), { status: 201 }));
	vi.stubGlobal("fetch", fetchMock);
	const issued = vi.fn();
	await createAaasKey(new AaasKeysApi(auth), "Router", issued, null, null, true);
	expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/admin/v1/aaas/keys", expect.objectContaining({ body: JSON.stringify({ name: "Router", router_only: true }) }));
	expect(issued).toHaveBeenCalledWith("fixture-token");
	expect(usageLabel(null, false)).toBe("未知");
	expect(usageLabel(0, true)).toBe("0 tokens");
	expect(usageLabel(17, false)).toBe("17 tokens（已确认部分）");
});

import type { AdminSandboxEnvironment, AdminSandboxStatistics } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SandboxEnvironmentView, SandboxStatisticsView } from "../../src/admin/pages/sandbox-page.tsx";
import { parseRoute } from "../../src/admin/router.ts";

const environment = {
	provider: "Bubblewrap",
	available: true,
	os: "fixture Linux",
	bwrapVersion: "9.8.7",
	runtimeDir: "/srv/sandbox/runtime",
	workspaceDir: "/srv/sandbox/workspaces",
	runtimeReadOnly: true,
	workspaceMount: "/workspace",
	workspaceScope: "task",
	network: "isolated",
	executionPolicy: "per_bash_call",
	dependencyMode: "offline_preinstalled",
	runtimes: [{ name: "Python", version: "3.9.8", path: "/usr/bin/python3" }],
	pythonPackages: [
		{ name: "FixtureImage", version: "1.2.3", location: "/usr/lib/image" },
		{ name: "FixtureCSV", version: "4.5.6", location: "/usr/lib/csv" },
	],
} satisfies AdminSandboxEnvironment;

test("the Sandbox page is routable and filters live inventory by name, version or path", () => {
	expect(parseRoute("/sandbox").id).toBe("sandbox");
	for (const search of ["  FIXTUREIMAGE ", "1.2.3", "/usr/lib/image"]) {
		const html = renderToStaticMarkup(
			<SandboxEnvironmentView data={environment} search={search} onSearch={() => {}} />,
		);
		expect(html).toContain("FixtureImage");
		expect(html).not.toContain("FixtureCSV");
		expect(html).toContain(environment.runtimes[0].version);
		expect(html).toContain(`title="${environment.workspaceDir}"`);
		expect(html).toContain("<details ");
		expect(html).toContain("共 2 个包");
		expect(html).toContain("复制 Python 路径");
	}
	const empty = renderToStaticMarkup(
		<SandboxEnvironmentView data={environment} search="missing" onSearch={() => {}} />,
	);
	expect(empty).toContain("没有匹配的 Python 依赖");
});

test("an unavailable environment shows an error without inventory", () => {
	const data = {
		provider: "Bubblewrap",
		bwrapVersion: "9.8.7",
		os: "fixture Linux",
		available: false,
		error: "SANDBOX_PROBE_FAILED",
	} satisfies AdminSandboxEnvironment;
	const html = renderToStaticMarkup(<SandboxEnvironmentView data={data} search="" onSearch={() => {}} />);
	expect(html).toContain('role="alert"');
	expect(html).toContain("Sandbox 环境探测失败");
	expect(html).not.toContain("Python 第三方依赖");
	expect(html).not.toContain("共享运行根");
});

test("execution records link to the Router Operation and display structured outcomes", () => {
	const data: AdminSandboxStatistics = {
		total: 5,
		counts: { success: 2, command_failed: 1, start_failed: 0, timeout: 1, canceled: 1 },
		successRate: 0.4,
		averageMs: 80,
		p95Ms: 314,
		trend: [
			{ startAt: "2026-11-19T00:00:00Z", count: 3 },
			{ startAt: "2026-11-19T01:00:00Z", count: 0 },
			{ startAt: "2026-11-19T02:00:00Z", count: 2 },
		],
		recent: [
			{
				id: "event-id",
				keyId: "11111111-1111-1111-1111-111111111111",
				taskId: "22222222-2222-2222-2222-222222222222",
				operationId: "33333333-3333-3333-3333-333333333333",
				tool: "bash",
				startedAt: "2026-11-19T01:02:03.000Z",
				endedAt: "2026-11-19T01:02:03.314Z",
				status: "command_failed",
				durationMs: 314,
				reason: "EXIT_7",
			},
		],
	};
	const html = renderToStaticMarkup(<SandboxStatisticsView data={data} />);
	const { keyId, taskId, operationId } = data.recent[0];
	const detail = `/conversations/router/${keyId}/${taskId}/${operationId}`;
	expect(html).toContain(`href="#${detail}"`);
	expect(parseRoute(detail)).toMatchObject({ id: "router-executions", params: { keyId, taskId, operationId } });
	expect(html).toContain("40%");
	expect(html).toContain("40.0%");
	expect(html).toContain("超时 / 取消");
	expect(html).toContain("北京时间每小时执行次数");
	expect(html).toContain("08:00 · 3 次");
	expect(html).toContain("314 ms");
	expect(html).toContain("命令执行失败");
	expect(html).toContain("EXIT_7");
	expect(html).toContain("退出码 7");
	expect(html).toContain("查看详情");
});

test("statistics expose the empty state and allow an older server without trend data", () => {
	const empty: AdminSandboxStatistics = {
		total: 0,
		counts: { success: 0, command_failed: 0, start_failed: 0, timeout: 0, canceled: 0 },
		successRate: null,
		averageMs: null,
		p95Ms: null,
		recent: [],
	};
	const markup = renderToStaticMarkup(<SandboxStatisticsView data={empty} />);
	expect(markup).toContain("该时间范围内暂无执行。");
	expect(markup).toContain("该时间范围内暂无执行记录。");
	expect(markup).not.toContain("<polyline");
	const older = { ...empty, total: 1, counts: { ...empty.counts, success: 1 }, successRate: 1 };
	expect(renderToStaticMarkup(<SandboxStatisticsView data={older} />)).toContain("暂无趋势数据。");
});

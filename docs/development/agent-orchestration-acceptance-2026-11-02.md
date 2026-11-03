# Agent 编排首期专项验收记录

日期：2026-11-02（北京时间）。分支：`feat/agent-orchestration`。基线：`1423827`；本轮改动未提交、未部署。

## 规格与实现对应

| 契约 | 实现位置（相对 runtimes/pi） | 验证 |
| --- | --- | --- |
| 业务 DTO、配置与报告协议 | packages/protocol/src/orchestration.ts；server/src/orchestration/contracts.ts | Schema 与 API 测试 |
| 事件原子接收、去重、订阅、派工 | server/src/orchestration/store.ts；迁移 0022 | 隔离 Postgres 并发与回滚测试 |
| Router 与 Worker 适配 | server/src/orchestration/service.ts、compose.ts、dispatcher.ts | 真实 ConversationService + Fake TurnExecutor |
| Tool 密钥隔离 | credentials.ts、protected-tool.ts；MCP Factory 可选适配钩子 | 并发 key、错误/结果脱敏、真实 Factory 桥接测试 |
| 接入及管理员接口 | server/src/orchestration/http.ts | 本地 HTTP 测试，系统认证与权限拒绝 |
| 配置版本生效 | service.ts，复用控制面保存与精确版本编译 | 并发 CAS、失败保留旧指针、旧工作快照 |
| 控制台 | web/src/admin/pages/orchestration-page.tsx | Web 类型检查、API 测试、Chromium 交互 |

## 自动化结果

服务端从 `runtimes/pi/packages/server` 执行：

```bash
PI_ORCHESTRATION_TEST_DATABASE_URL='<隔离测试数据库连接>' \
node ../../node_modules/vitest/dist/cli.js --run \
  test/orchestration/contracts.test.ts \
  test/orchestration/conversation-executor.test.ts \
  test/orchestration/integration.test.ts \
  test/orchestration/mcp-bridge.test.ts \
  test/publishing/mcp-runtime-tools.test.ts
```

结果：5 个文件、39 个测试通过（控制台改进后重跑）。数据库测试创建独立随机 schema，执行包含 0022 的完整迁移，结束后删除该 schema；没有操作现有业务 schema。只使用固定测试 key、Fake 模型及 Fake MCP，无真实 Provider 费用。新增目录测试覆盖管理员鉴权与仅返回选项名称，不泄露工具 Schema、端点或默认值。

覆盖：重复并发事件唯一接收、冲突重放、跨接入拒绝、工作项独立身份与上下文、凭据加密与 Turn 绑定、事务回滚、取消/迟到结果竞争、凭据轮换及停用、暂停应用拒绝、执行期间新输入保留、配置 CAS/版本冻结/失败回滚、显式重试与过期拒绝、启动恢复与单调度器独占、后台报告与同上下文补充、非法报告拒绝。

Web 从 `runtimes/pi/packages/web` 执行：

```bash
node ../../node_modules/vitest/dist/cli.js --run test/admin/orchestration-api.test.ts
```

结果：3 个测试通过；验证配置更新 expectedRevision、凭据不进 URL、管理员认证失效清空 Token，以及版本冲突状态码与 AbortSignal 的保留。

`npm run typecheck --workspace=@earendil-works/pi-web` 通过。对本次新增/修改的 TypeScript 文件执行 Biome 检查通过。

## 浏览器专项

使用临时 Vite 端口 5188、Chromium 无头浏览器，接口全部显式拦截为模拟响应。控制台改进后验证：工作项筛选与无匹配状态、结构化报告详情、取消确认及状态更新、过期授权禁用重试、有效授权重试确认与提交、服务不可用时保留旧列表、未保存草稿保护、409 冲突保留草稿及重新加载、CAS 保存新版本、模型能力对应思考选项、三步新建并正确提交两条工具凭据映射、一次性凭据关闭、轮换取消不发送请求，以及 1440 / 1024 桌面布局。无浏览器运行时错误。

本机复现脚本：`/tmp/verify-agent-orchestration-ui.mjs`；截图：`/tmp/agent-orchestration-console.png`、`/tmp/agent-orchestration-report.png`、`/tmp/agent-orchestration-create.png`、`/tmp/agent-orchestration-1024.png`。该脚本依赖本机测试浏览器与临时 Playwright，未添加项目依赖。浏览器专项不构成真实接口或真实 MCP 联调证据。

## 全仓门禁与剩余工作

- 已运行 `npm run check`，失败于基线已有的 16 个 lint error、16 个 warning、4 个 info；后续链式检查未执行，不能声称完整门禁通过。
- 单独运行全仓 `tsgo --noEmit`：仍有基线 9 处类型诊断，涉及 ConversationRuntime 的 citation_snapshot 事件联合类型、Debug 测试只读状态/异步工厂和旧 Runtime 测试缺少 realtimeVoice。当前输出未出现本轮新增模块的类型诊断。
- 全仓自动格式化涉及的一处无关测试排版已撤回；不在本功能中批量修改既有 UI/语音/Debug 问题。
- 未运行 build、全量 E2E、真实模型和真实对方 MCP；没有发布或推送。用户报告新建接入显示“接口不存在”后，已重启本工作区 5176/8768 开发服务，保留原环境配置；未重启其他业务服务。
- 一次接入配置只绑定一个已发布应用；控制台与 API 均支持多条凭据映射。模型思考选项来自模型目录，最终由服务端模型能力校验。
- 首期仅简单顶层字符串密钥参数、单活动调度进程、2 个并发工作项；未知中断需显式重试，不保证外部副作用恰好一次。
- Tool key 在工作范围中保存到有效期以便重试，过期后台清除密文；不同用户的历史访问权限由工单后端控制，平台不从 key 推断用户身份。

结论：首期代码与专项验证已落地；全仓门禁及真实部署联调未完成，不能作为发布放行证据。

## 开发环境接口恢复

2026-11-02，用户报告新建接入选项返回 404。核对发现后端从 16:14 启动后未重载，未包含随后新增的 catalog 路由。使用原环境重启本工作区开发服务后，直接请求 8768 后端及通过 5176 前端代理请求 `/api/admin/v1/orchestration/catalog` 均返回 200，包含 2 个发布 Agent 和 1 个模型。此项是实际开发环境只读接口验证，不代表已完成真实模型/MCP 的分析联调。

## 工具凭据批量配置

2026-11-02，按用户反馈，在新建接入的工具授权步骤新增批量配置：按 MCP 服务、参数名选择工具并共用凭据名称，默认选中支持该参数的工具；支持全选/取消全选及单独取消。不支持参数的工具不可选。应用后更新相同服务、工具、参数的映射，保留其他映射；仍使用现有逐工具 DTO，最多 128 条。生成的映射默认折叠，可展开逐条调整或单独添加；更换 Agent 清空映射。

Chromium 使用开发前端 5176、全部接口模拟，验证 32 个工具全选、参数不支持工具禁选、非法凭据名称阻止应用、部分选择、重复应用去重、更换共用凭据名、跨 MCP 同名工具隔离、单条例外覆盖，最终提交 33 条唯一映射，以及 1024 宽度下无页面横向溢出。脚本 `/tmp/verify-orchestration-bulk-bindings.mjs`，截图 `/tmp/orchestration-bulk-bindings.png`；未创建真实接入。已重跑原有控制台浏览器专项、3 项 API 测试，Web 类型检查与本次 TS 局部 Biome 均通过。全仓 `npm run check` 仍因原有 16 error、16 warning、4 info 停止，未新增本次文件诊断；自动格式化的一处无关测试已撤回。本次不涉及后端路由、迁移或 Worker 变更，无需重启后端。

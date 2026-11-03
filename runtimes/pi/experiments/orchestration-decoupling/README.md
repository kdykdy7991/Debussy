# 编排配置解耦：最小可行性实验

这是一次**隔离原型验证**，不是正式实现或上线迁移。对应[实施设计](../../../../docs/development/orchestration-config-decoupling-design-2026-11-03.md)。

现已迁入正式源码和测试。本目录保留原型阶段的方法与结果；原型源码改写锚点针对迁入前代码，**不再适用于当前源码/迁移集合**。当前请在 `packages/server` 设置测试数据库变量后运行 `node ../../node_modules/vitest/dist/cli.js --run test/orchestration/independent-configuration.test.ts test/orchestration/configuration-migration.test.ts`。

执行结果（2026-11-03）：**8 项通过**。真实 Postgres、现有纯编译器、现有 Runtime Adapter/Manager/Skill materializer；Session 为假模型，MCP transport factory 为桩，不连接真实模型或 MCP，不读取现有接入 Token。

## 原型阶段的复现方式（归档）

从 `runtimes/pi` 运行，数据库连接由环境变量提供：

```bash
PI_ORCHESTRATION_TEST_DATABASE_URL='<测试 Postgres URL>' \
  node experiments/orchestration-decoupling/run.mjs
```

连接用户须有创建/删除 schema 权限。实验只操作随机 `decoupling_proof_<pid>_<timestamp>` schema，先运行真实迁移，再应用 `storage.sql`；结束时删除该 schema。源码副本和 Skill 目录在临时目录创建并清理。不更改 public schema、迁移目录或运行中的服务。

## 实际验证范围

1. 原 schema 不允许无 Chat 的 Conversation，实测返回 `23502`。试验 DDL 增加独立配置/版本，并在现有 Integration、Principal、Conversation、Event、Summary、WorkItem 上添加独立归属后，三张 Chat 定义/发布表均为零行也能写入、读取执行上下文。
2. 查询和事件追加按 tenant + Integration + principal 隔离；跨三种归属读取为空、追加失败，直接跨域事件/Conversation 写入被复合 FK 拒绝。原平台 service 唯一性与无 App 的 external_user 限制仍有效。
3. 显式编排配置可编译为包含模型、Prompt、Context、MCP 工具快照和 Skill 快照的完整 RuntimeSpec；不调用 Chat 发布服务。编译可重现，未批准模型被拒绝。
4. 同一 `executeTurn()` 源码实验副本在归属校验之后、历史恢复之前调用 resolver。Chat 和任务 resolver 均进入相同公共执行段。任务执行期间读取 Chat 版本/App/reasoning 会立即抛错，实测没有发生。
5. Integration 已切换 B，任务仍读冻结 A；校验实际 Runtime 的 spec、Session 系统提示词/任务消息、Skill 路径、事件 hash 和 context snapshot。上下文快照与执行器实际收到的历史、System Prompt 和预算一致。Chat App 停用后任务仍能执行。
6. 错误归属不进入 resolver；错误 Turn 不获得版本；hash 损坏不恢复历史或启动 Runtime。
7. 真实 Runtime manager 同上下文/版本 A 复用，切换 B 释放 A 并重建；两个版本 Skill 路径及内容独立，同版本再次物化不改文件；版本标识自身参与 spec hash。

## 如何试验解析入口

`run.mjs` 将当前服务和三个仓库源码复制到 `/tmp`，仅在副本中修改解析边界、任务 scope/审计/reasoning，以及仓库归属列。其余公共执行流程继续使用当前源码。补丁锚点不再唯一时，实验拒绝运行，要求重新核对入口。

副本使用显式 `integrationId`，没有将 Integration 强制断言为 PublishedAppId，也没有创建隐藏 Chat 发布记录。RuntimeSpec 与 Runtime scope 的旧 `publishedAppVersionId` 技术键暂存真实 `orv_...` 标识，未生成对应 PublishedAppVersion 行。

这是 transpile-only 可行性原型，**未证明正式类型与全仓调用点已经迁移**。源文件从未增加 resolver 端口，生产组合从未切换；实验复制的仓库仅用于被测的归属读取、事件追加和摘要路径，其管理员查询等方法不构成正式可用仓库。

## 尚未完成的正式工作

- 带来源判别的正式 scope/record 类型和仓库实现、全量调用点覆盖；不能把源码字符串改写器用于生产。
- 配置草稿 CAS、不可变版本发布、Integration 原子切换，以及 WorkItem/Assignment 完整事务链。
- 摘要链、rollover、取消、恢复、审计/统计和管理员日志等所有路径的来源隔离；本实验没有证明这些路径全部支持无 Chat。
- `input_v1 / legacy_prompt` 持久化、有效 override hash、历史幂等和迁移。实验任务记录只固定 `input_v1`，正式 API 尚不接受新 input 契约。
- 真实模型、真实 MCP、任务凭据注入的解耦后端到端联调。本实验只证明冻结 MCP 配置能经过 Runtime Adapter，未执行 MCP 工具。

仓库 `npm run check` 已执行，仍在既有 Biome 基线失败：16 errors、16 warnings、4 infos；后续类型等阶段未运行。该检查不覆盖这里的实验模板，模板由独立 Vitest 实际运行。

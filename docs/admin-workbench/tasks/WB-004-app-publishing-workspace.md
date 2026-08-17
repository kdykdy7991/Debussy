# WB-004：应用与发布工作区

状态：Blocked by WB-002/WB-003

## 目标

将既有发布控制台能力迁入管理员工作台，提供应用仪表盘、详情和当前 Agent 的快捷发布抽屉。

## 修改范围

- `runtimes/pi/packages/web/src/admin/apps/`
- 既有 `web/src/publishing/` 的迁移或删除替代
- Publishing Control API/controller 专项测试

## 交付

1. 应用指标、待处理事项和应用列表。
2. 应用详情八个页签的首期内容。
3. 发布抽屉强制选择目标 PublishedApp。
4. 选择已保存 AgentRevision并展示线上 Diff。
5. 创建不可变 PublishedAppVersion，但不自动激活。
6. 应用配置修改进入待发布状态。

## 禁止

- 不记忆默认发布应用。
- 不把“发布”和“上线”合并。
- 不让应用配置绕过版本立即生效。
- 不回归幂等键“主动再次点击生成新 Key”的语义。

## 验收

- 一个 Agent 的多个应用必须逐次选择。
- 创建版本不会改变 `currentVersionId`。
- loading/empty/error/retry/cursor 分页完整。
- 旧 `/publishing` 深链接正确进入新工作区。
- Publishing 专项测试和 `npm run check` 通过。

## 交接

记录旧组件迁移表、未迁移原因、发布状态机和应用配置版本化字段。


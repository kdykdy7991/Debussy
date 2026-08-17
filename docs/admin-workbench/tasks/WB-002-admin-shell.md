# WB-002：管理员 App Shell

状态：Complete（handoff 见 `handoffs/WB-002-admin-shell.md`）

## 目标

建立对话优先的管理员框架、四个核心模块导航、模块侧栏、右侧抽屉和统一解锁态。

## 修改范围

- `runtimes/pi/packages/web/src/admin/`
- 既有内部 `app.tsx` 的最小接入点
- `runtimes/pi/packages/web/src/publishing/auth-controller.ts`
- Admin Shell 专项测试和样式

## 交付

1. 一级标签：对话、Agent、应用、用户会话、设置。
2. `/` 默认进入对话。
3. 路由刷新恢复当前模块和公开实体 ID。
4. 右侧抽屉容器和响应式布局。
5. Admin Token 统一解锁/锁定体验。
6. `/publishing/*` 兼容重定向。

## 禁止

- 不把旧 `PublishingApp` 整体嵌入 Shell。
- Token 不进 Storage、URL、console 或异常。
- 不在本任务实现 Agent 表单或发布业务。

## 验收

- 五个标签键盘可达并有当前态。
- 401 清空全部管理数据并回到锁定态。
- 桌面、窄屏无横向溢出。
- 路由刷新和浏览器前进/后退正确。
- Admin Shell 组件测试、Web typecheck、`npm run check` 通过。

## 交接

记录 Shell 状态所有权、路由恢复方式、抽屉 API 和后续模块插槽。


# WB-005：独立预览与上线闭环

状态：Blocked by WB-001/WB-004

## 目标

允许管理员用正式 Embed 构建物预览未上线版本，并完成上线、回滚和停用的安全闭环。

## 修改范围

- Preview Ticket protocol/server
- `runtimes/pi/packages/web/src/embed/preview-app.tsx`
- Admin 版本操作 UI
- Preview/activate/rollback/suspend 专项测试

## 交付

1. 短期一次性 Preview Ticket。
2. `/preview/:publicAppId` 预览页面。
3. 固定加载指定 PublishedAppVersion。
4. 上线、回滚、停用自定义确认框。
5. 完整管理审计。

## 禁止

- versionId 或 Ticket 不放 URL query。
- Preview 不改变 currentVersion。
- 不使用浏览器原生 `confirm()`。
- Preview 身份不能降级为普通 anonymous 绕过。

## 验收

- Ticket 过期、重放、错 App、错 Origin 均拒绝。
- Preview 对话固定待上线版本。
- 上线后只有新 Conversation 使用新版本。
- 回滚和停用行为符合现有数据面契约。
- 真实 Chromium 证据单独记录；缺失时不得标记 E2E 完成。

## 交接

记录 Ticket claims、TTL、消费点、预览身份和真实浏览器结果。


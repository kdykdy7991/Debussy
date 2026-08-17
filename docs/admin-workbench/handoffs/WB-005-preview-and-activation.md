# WB-005 交接：独立预览与上线闭环

状态：Complete

## 完成范围

- 新增短期、一次性 Preview Ticket，绑定 tenant、应用、版本、publicAppId 与 Embed Origin。
- 管理端创建 Ticket 后打开无 ticket 的 `/preview/:publicAppId`；Ticket 仅在内存中通过 opener/preview 的 `postMessage` 握手传递，不进入 URL、Storage 或审计 metadata。
- Preview exchange 产生 `platform_admin_preview` Principal，并固定 Ticket 指定的 `PublishedAppVersion`；预览可用于尚未激活的 ready 版本，且不会改写 `currentVersionId`。
- 版本页补充预览、上线、回滚的自定义确认框；停用应用也使用自定义确认框。确认框展示应用、publicAppId、当前/目标版本、Origin 与影响说明。
- 修复 WebSocket ticket 的固定版本类型，保证 Preview 会话的 Realtime 路径不会丢失版本 pin。

## 关键文件

- `runtimes/pi/packages/server/src/publishing/preview-ticket.ts`
- `runtimes/pi/packages/server/src/embed/auth/principal.ts`
- `runtimes/pi/packages/server/src/embed/auth/ws-ticket.ts`
- `runtimes/pi/packages/protocol/src/admin-workbench-apps.ts`
- `runtimes/pi/packages/web/src/embed/main.tsx`
- `runtimes/pi/packages/web/src/embed/embed-app.tsx`
- `runtimes/pi/packages/web/src/admin/apps/app-detail.tsx`
- `runtimes/pi/packages/server/test/publishing/preview-ticket.test.ts`

## 验证结果

```text
packages/server: preview-ticket.test.ts     3/3 passed
packages/web:    embed-logic.test.ts        10/10 passed
packages/protocol tsgo                      passed
packages/web tsgo                           passed
```

`npm run check` 已运行；Biome、依赖固定、相对 import、shrinkwrap 与 install lock 均通过。后续顶层 typecheck 被既有 AI model catalog 类型错误、`@earendil-works/pi-coding-agent` 缺失和 smoke script 的既有模块缺失阻断。Server 单包 typecheck 同样只剩该缺失依赖相关错误；WB-005 引入的 `ws-ticket.ts` 类型错误已修复。

## 未关闭项

- 未进行真实 Chromium / 真实企业宿主验证，因此不能宣称端到端验收完成。
- Preview Ticket 的已消费集合目前为进程内有界 Map；多实例部署应在后续基础设施任务中迁移到 Redis 的原子消费存储，避免跨实例重放。

## 对下一任务的约束

- WB-007/008 的事件与会话模型必须保留 `publishedAppVersionId`，不能让 preview conversation 回退到 App 当前版本。
- WB-010 SDK 不得复用 Preview Ticket 流程；Preview 仅面向管理员 opener，企业宿主继续使用 Launch Token。

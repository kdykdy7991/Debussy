# WB-010 交接： 企业 Embed SDK

状态：Complete

## 完成范围

在 iframe 安全隔离前提下提供宿主侧企业 Embed SDK：`create(...)` 挂载 iframe，
匿名 / signed-user 初始化，open/close/destroy 生命周期与尺寸同步，面向宿主的
`ready` / `error` / `conversation-created` / `resize` 事件，以及
`event.source` / `event.origin` / 协议版本三重校验。协议层补充
`conversation-created` 消息与宿主侧 decode。

## 交付项对照与禁止项

1. `create({ appId, container, launchToken })` — `packages/web/src/embed/sdk/
   skdy-embed.ts`（含 inline/floating 两种挂载；无 `container` 时挂浮动 body）。
2. open / close / destroy + 尺寸同步 — `resize` 事件抵达后同步 `iframe.style.height`；
   `requestResize()` 可主动请求 iframe 重报高度。
3. anonymous / signed-user 初始化 — 匿名发纯 `init`；signed_user 发
   `init + launchToken`，**Exchange 后立即释放内存**（`pendingLaunchToken` 置
   undefined），Token 绝不影响 URL/Storage。
4. ready / error / conversation-created / logout 事件 — SDK 提供
   `on("ready"|"error"|"conversation-created"|"resize", handler)`；`logout()`
   向 iframe 投递退出、清理凭据。
5. `event.source` / `event.origin` / 协议版本校验 — 来源必须等于所建 iframe 的
   contentWindow；origin 必须在 `{baseOrigin} ∪ extraOrigins` allowlist；信封
   protocol/version/payload 经 `decodeEmbedIframeMessage` 校验。错 source /
   错 origin / 错版本一律忽略，绝不派发宿主处理器。
6. iframe 与 SDK 接入示例 — `docs/admin-workbench/examples/embed-sdk-example.html`
   （inline + floating，含完整事件订阅；宿主需自行 bundle SDK 模块并注入
   host 后端签发的 Launch Token）。

禁止项：SDK 不触宿主私钥；Launch Token 不落 URL/Storage；不 host 侧运行
Agent Runtime；拒绝未签名 externalUserId 建立身份（signed_user 身份只来自
Launch Token）。

## 修改文件

### 协议层（`@earendil-works/pi-protocol`）

- `packages/protocol/src/embed/post-message.ts` —
  - `EmbedIframePostMessage` 增 `conversation-created`（含 `publicAppId`、
    `conversationId`）
  - `encodeEmbedIframeMessage` 覆盖新类型
  - 新增宿主侧校验 `decodeEmbedIframeMessage(raw)` →
    `EmbedPayloadDecodeResult`（协议/版本/类型/payload 逐项校验，含 resize 高度
    clamp、conversation-created 字段非空），与既有 `PostMessageRejectReason` 复用

### Web（`@earendil-works/pi-web`）

- `packages/web/src/embed/sdk/skdy-embed.ts`（新增）— 宿主侧 SDK：
  - `create(options)`：校验 appId / https baseUrl；`on`（类型化事件）、
    `open`/`close`、`requestResize`、`logout`、`destroy`（移除 listener +
    iframe，无残留）
  - 环境依赖注入（`env.window` / `createInternal`）让 SDK 可在 Node 直接测试
  - 消息门禁：source + origin allowlist + `decodeEmbedIframeMessage`
  - Launch Token 单次投递即释放
- `packages/web/src/embed/chat-controller.ts` — 新增可选用项
  `onConversationCreated`，新建会话成功后回调
- `packages/web/src/embed/embed-app.tsx` — 非 preview 模式下会话新建后经 channel
  回发 `conversation-created`
-（顺手修复）`packages/web/test/embed/chat-controller.test.ts` 两个陈旧用例：
  mock 的 `POST /conversations` 仍返回裸会话对象，但 WB-008 起端点返回
  `{ conversation, rollover }`，导致 `created.conversation.id` 抛错 → 修正 mock
  返回形状后 17/17 通过（此次属修复陈旧测试，非账本无关改动）

### 测试

- `packages/web/test/embed/sdk.test.ts`（新增，7 测试）— 用假 window/iframe 验证：
  - create 校验、signed_user init 携带 Launch Token 且匿名重连不再带 Token
  - 错 origin / 错 source / 错协议 / 错版本 / 未知类型 / 非法 payload
    全部忽略，正确消息才派发
  - error / conversation-created 事件派发、resize 高度 sync 到 iframe style
  - destroy 移除 listener 与 iframe，之后 stale 消息不再派发

## 关键接口与数据结构

```ts
const embed = create({
  appId: "pub_<uuid>",
  container?: HTMLElement,   // 缺省 = floating（挂 body）
  baseUrl: "https://agent.example.com",
  launchToken?: string,      // signed_user；匿名省略
  initWidth?, initHeight?, extraOrigins?,
});
embed.on("ready", () => {});
embed.on("conversation-created", ({ conversationId }) => {});
embed.on("error", ({ code, message }) => {});
embed.on("resize", ({ height }) => {});
embed.open(); embed.requestResize(); embed.logout(); embed.close(); embed.destroy();
```

iframe URL：`${baseUrl}/embed/${appId}`。宿主→iframe 消息
`init`/`logout`/`focus`/`resize-request`；iframe→宿主
`ready`/`error`/`resize`/`conversation-created`。信封恒定
`{ protocol:"skdy-embed", version:1, type, payload }`，发送一律限定
targetOrigin（禁 `postMessage("*")`）。

## 执行过的命令及结果

```text
(cd packages/protocol && npx tsgo -p tsconfig.build.json)                → OK
npx tsgo --noEmit -p packages/web/tsconfig.json                          → OK
node ../node_modules/vitest/dist/cli.js --run test/embed/                → 53/53
packages/protocol/test/embed/post-message.test.ts                        → 12/12
npx biome check .（整仓）                                                → no errors
```

## 未关闭项

- 真实宿主 Chromium E2E 单独记录（spec 验收项要求）。SDK 逻辑已由 Node 假
  window/iframe 覆盖；跨域 iframe + 真实 postMessage 需真实浏览器矩阵验证。
- SDK 作为独立可分发 bundle：当前以源码模块形式提供，宿主由其构建工具打包。
  若需 `dist/skdy-embed.js`（IIFE/UMD）对外发布，需加一个独立的产物导出入口 +
  CI 打包（可作为独立跟进）。
- floating 模式默认样式（launcher/角标）留给宿主排版；SDK 只负责挂载/销毁。

## 对后续任务 / 维护的约束

1. 协议新增 iframe→host 消息时，`EmbedIframePostMessage` + `encodeEmbedIframeMessage`
   + `decodeEmbedIframeMessage` 三处需同步扩展，否则宿主侧 decode 会以
   `UNKNOWN_TYPE` 拒绝新消息。
2. SDK 的 `create()` 幂等/重复调用语义：在同一元素重复 create 允许重建（每次
   新建独立 iframe）；`destroy()` 后不可再 `open()`（已置 disposed）。
3. `decodeEmbedIframeMessage` 为纯函数、已随 `@earendil-works/pi-protocol`
   出口，宿主侧错误仅属已知类型时才向业务方派发。
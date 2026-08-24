# M0 Embed SDK 行为原型报告

状态：M0 原型（不视为生产实现）；总架构师第一轮反馈已合并

负责人：前端工程师

创建日期：2026-08-24

本原型用隔离测试固化 [skdy-embed.ts](../../../runtimes/pi/packages/web/src/embed/sdk/skdy-embed.ts) 的关键不变量与缺口，目的：

1. 验收既有 SDK 在 mount/destroy、多实例（共享宿主 window）、source/origin/version、resize 与 launchToken 持久化五类行为上的实际表现；
2. 给后端 / 总架构师提供"SDK 改造前必须拍板的契约点"清单；
3. 作为后续把 SDK 拆为正式 `@earendil-works/pi-embed-sdk`（M1 / M2 边界外）的回归基线。

不在本原型范围：创建 `packages/embed-sdk`、冻结 SDK 包名/导出名（仅记录、不落地）、修改 `package-lock`、修改正式业务 DTO、占位业务字段、Skill / MCP / 指标正式页面、reasoning 会话持久化路径。

## 1. 交付物

| 交付物 | 路径 |
|---|---|
| 测试文件 | [packages/web/test/embed/sdk-m0-prototype.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk-m0-prototype.test.ts) |
| 配套调研与契约问题 | [m0-survey.md](./m0-survey.md) / [contract-questions.md](./contract-questions.md) |
| 本报告 | 本文件 |

测试基础设施沿用既有 [packages/web/test/embed/sdk.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk.test.ts)：注入 fake `window` / `iframe`，vitest node 环境，**未引入新依赖，未修改 `package-lock`**。新文件 `makeSharedEnv(iframeCount)` 辅助构造"同一宿主 window + 多 iframe"的多实例测试场景。

## 2. 总架构师第一轮反馈（已合并）

### 2.1 已批准的方向（影响本原型）

- **Embed 高度必须是 1～最大值，0 无效**：本原型已据此跳过 `height == 0` 测试（见 §3 缺口行与 §4.1）。
- **SDK 包名冻结为 `@earendil-works/pi-embed-sdk`**：作为 M1 SDK 改造的命名基准，原型不实现 package 拆分，仅在 §4.2 与 §5 记录。
- **公开 API 使用 `createEmbed` 与 `EmbedInstance`**：与现有 `create` 函数语义对齐（仅重命名），§5 记录。
- **postMessage 保持 v1，扩展必须向后兼容**：本原型沿用 v1 协议，事件名 `ready` / `error` / `conversation-created` / `resize` 保持稳定，§5 记录。
- **fixture 只通过单一 typed adapter 进入测试/开发环境**：本原型未引入 fixture，但 §6 下一步明确"SDK 改造完成后再用同一 adapter 引入 Skill/MCP/指标 fixture"。
- **发布范围仅限内部网络**：[docs/product/DECISIONS.md](../../product/DECISIONS.md) D-010 已记录；本原型无外部依赖，行为不受影响。

### 2.2 本原型必须落实的 4 项修正（已全部完成）

| # | 问题 | 修正 |
|---|---|---|
| 1 | 多实例测试没有真正共享同一个 window | `makeSharedEnv` 工具 + 三个测试改为同一 window、不同 iframe |
| 2 | 原型提交包含普通失败测试，导致红灯 | `height == 0` 改为 `it.skip`，缺口转交 §4.1 与 M1 SDK 改造 |
| 3 | 报告链接和范围描述需修订 | §2.1 / §3 / §4 / §5 全面重写，明确已批准方向与缺口归属 |
| 4 | Biome 报"缺文件末尾换行" | `biome check --write` 已自动补换行 |

## 3. 测试命令与结果

```bash
cd runtimes/pi/packages/web
node ../../node_modules/vitest/dist/cli.js --run test/embed/sdk.test.ts test/embed/sdk-m0-prototype.test.ts
```

结果（修订后）：

```text
Test Files  2 passed (2)
Tests       31 passed | 1 skipped (32)
```

`height == 0` 缺口用例以 `it.skip` 标记，详见 §4.1。

## 4. 行为矩阵

| 类别 | 用例 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| **mount / destroy 幂等** | destroy() 重复调用不抛 | 第二次为 no-op | 通过 | ✓ |
| | open() 重复调用只挂一个 iframe | posted 计数不变 | 通过 | ✓ |
| | destroy() 后 open() 不重建 | posted / removed 不变 | 通过 | ✓ |
| | destroy() 未 open() 时监听器干净 | win.handlers 为 0 | 通过 | ✓ |
| | destroy() 后 requestResize / logout / on() 静默 | posted 不增长 | 通过 | ✓ |
| **多实例隔离（共享 window）** | 两个实例共享同一 window 时互不串扰 | 仅目标实例收到 resize | 通过 | ✓ |
| | A.destroy() 之后只剩 B 的监听器 | handlers.length === 1；B 仍能收到事件 | 通过 | ✓ |
| | resize 事件从 B 触发时 A 不响应 | source 绑定到具体 iframe | 通过 | ✓ |
| | 每个实例独立维护 posted / removed | A.destroy 不影响 B 的 posted | 通过 | ✓ |
| **source / origin / version / envelope** | event.source !== iframe.contentWindow | 拒绝 | 通过 | ✓ |
| | event.data 非对象 / null / 数组 | 拒绝 | 通过 | ✓ |
| | protocol / version / type 任意错误 | 拒绝 | 通过 | ✓ |
| | origin 不在白名单 / 空串 | 拒绝 | 通过 | ✓ |
| | extraOrigins 列入白名单 | 允许 | 通过 | ✓ |
| **resize 非法值与上限** | height > 100000 / 1e9 / Infinity | 拒绝 | 通过 | ✓ |
| | height == 100000（上限） | 接受 | 通过 | ✓ |
| | height == NaN | 拒绝 | 通过（protocol `Number.isInteger` 拦截） | ✓ |
| | height == -1 | 拒绝 | 通过（protocol `height < 0` 拦截） | ✓ |
| | height == 0 | 拒绝 | **跳过**（缺口；M1 SDK 改造时启用） | §4.1 |
| | height 是字符串 / null | 拒绝 | 通过（protocol `typeof !== "number"` 拦截） | ✓ |
| | 合法值同步到 iframe 样式 | style.height = "456px" | 通过 | ✓ |
| **launchToken 不落盘** | localStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | sessionStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | document.cookie 写入未触发 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | destroy() 后 reopen 不再携带 token | payload === undefined | 通过 | ✓ |

## 5. 当前实现缺口

### 5.1 resize == 0 被透传（已批准方向）

协议层 `decodeEmbedIframeMessage` 已校验：

- `typeof height !== "number"`：拒绝字符串、null、undefined
- `!Number.isInteger(height)`：拒绝 NaN、小数、Infinity
- `height < 0`：拒绝负数
- `height > POST_MESSAGE_RESIZE_MAX_HEIGHT`：拒绝超过 100000

但 `height == 0` 全部通过：0 是合法整数、非负、未超上限。**总架构师已拍板**："Embed 高度必须是 1～最大值，0 无效"。当前 SDK 仍会写入 `iframe.style.height = "0px"`，产出不可见 iframe。M1 SDK 改造时在 `messageHandler` 的 resize 分支补 `decoded.message.height <= 0` 拒绝；或在协议层把 `height <= 0` 一并拒绝（推荐后者，与现有校验同源）。本原型暂不动 SDK 源码，对应用例以 `it.skip` 标记。

### 5.2 SDK 与协议层高度上限重叠

SDK 内部 `EMBED_HEIGHT_MAX = 100000` 与协议 `POST_MESSAGE_RESIZE_MAX_HEIGHT = 100000` 同值双持。两者职责重叠，将来若协议放宽上限（例如响应式分屏），SDK 这层会变成第二道墙、不会自动跟随。M1 SDK 改造时收敛到协议层，SDK 只做消息分发。

### 5.3 Launch Token 在内存中"释放"是约定性

`destroy()` 把 `pendingLaunchToken = undefined`，但 JavaScript 字符串不可变，"释放"只是断开引用、不会清零底层 buffer。当前实现已满足 [frontend.md §3](../../development/agent-platform-v2/frontend.md) "Secret 不进入 DOM、URL、localStorage / sessionStorage、前端日志或错误上报" 的硬性要求。若总架构师要求更严格（如不再 retry exchange 后清零 buffer），需要明确清理时机与对调试的影响。**当前无证据表明需要更严格清理**，暂记为观察项。

### 5.4 多实例共享宿主 window 的 host 约束

`makeSharedEnv(iframeCount)` 工具验证：两个 SDK 共享同一 `window` 时，监听器与事件流按 iframe 来源精确路由。本原型已通过"两实例同 window、四断言"覆盖（§4 多实例隔离块）。host 集成时需保证：

- 不重写 `window.addEventListener("message", ...)`；
- 不在 SDK 之外再添加与 SDK 兼容协议的 message 监听器（否则同一事件会被消费两次）；
- 不主动卸载被 SDK 挂载的 iframe DOM 节点（必须走 `inst.destroy()`）。

## 6. SDK 改造路径（M1 输入）

总架构师已批准的方向：

| 维度 | 现状 | M1 改造 |
|---|---|---|
| 包名 | 仍是 `embed/sdk/skdy-embed.ts`（web 包内部模块） | 独立 `packages/embed-sdk`，包名 `@earendil-works/pi-embed-sdk` |
| 公开 API | `create(options) → EmbedInstance` | 改名为 `createEmbed(options) → EmbedInstance`；保留所有事件名与签名 |
| postMessage 协议 | v1，单实例验证 | 保持 v1；扩展必须向后兼容；事件名 `ready` / `error` / `conversation-created` / `resize` 稳定 |
| resize 高度 | SDK 与协议各持一份上限 | 收敛到协议 `POST_MESSAGE_RESIZE_MAX_HEIGHT`；SDK 移除 `EMBED_HEIGHT_MAX` |
| resize == 0 | 透传 | SDK 或协议任一层加 `height <= 0` 拒绝；本原型 §5.1 缺口用例转绿 |
| fixture 接入 | 仅 `sdk.test.ts` 已存在 | M1 起所有测试 / 开发用 fixture 走单一 typed adapter（与 Metrics/Context/Skill/MCP 共享同一目录） |
| 发布范围 | 内部网络 | 无 SDK 代码变更；文档沿用 [D-010](../../product/DECISIONS.md) |

## 7. 仍需后端 / 总架构师确认的契约点

本节只列与本原型直接相关的项；完整列表见 [contract-questions.md](./contract-questions.md)。

1. **resize == 0 修复位置**（已批准"0 无效"）：SDK `messageHandler` 加 `height <= 0` 拒绝，还是协议层一并拒绝？后者与现有校验同源，推荐后者。**待定**。
2. **resize 上限归属**：协议层单一来源。**待落地**到协议 PR。
3. **postMessage 协议是否需要 v2**：当前 v1 + 兼容扩展已批准；如未来需不兼容升级，协议包负责同步升级 SDK / iframe 两侧。
4. **多实例 host 约束是否进入 SDK 文档**：建议把 §5.4 三条 host 约束写入 `@earendil-works/pi-embed-sdk` README。**待定**。
5. **Launch Token 内存清理**：当前"断开引用"已满足硬性要求；如需更严格策略（GC buffer 清零）需总架构师拍板时机与对调试的影响。

## 8. 风险与下一步

- **CI 集成**：当前 `sdk-m0-prototype.test.ts` 全绿（31 通过 + 1 skip）。`skip` 是 M1 SDK 改造的待办，不阻塞 M0 提交。
- **§5.1 修复路径**：M1 SDK 改造时在协议 `decodeEmbedIframeMessage` 的 resize 分支加 `height <= 0` 拒绝，移除本原型对应 `it.skip` 的 skip 标记。
- **暂不动 `skdy-embed.ts` 业务实现**：本原型只追加测试与修报告，不改 SDK 源码；M1 SDK 改造时再一次性整理（独立提交）。
- **页面骨架、状态壳、fixture 适配层仍暂停**：等待后端修订 Metrics/Context 第一批候选、总架构师执行第二轮审查、首批 DTO 冻结。
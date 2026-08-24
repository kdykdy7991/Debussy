# M0 Embed SDK 行为原型报告

状态：M0 原型（不视为生产实现）

负责人：前端工程师

创建日期：2026-08-24

在 DTO 冻结前，本原型用隔离测试固化 [skdy-embed.ts](../../../runtimes/pi/packages/web/src/embed/sdk/skdy-embed.ts) 的关键不变量与缺口。结果用于：

1. 验收既有 SDK 在 mount/destroy、多实例、source/origin/version、resize 与 launchToken 持久化五类行为上的实际表现；
2. 给后端 / 总架构师提供"SDK 改造前必须拍板的契约点"清单；
3. 作为后续把 SDK 拆为正式 `packages/embed-sdk`（M1 / M2 边界外）的回归基线。

不在本原型范围：创建 `packages/embed-sdk`、冻结包名/导出名、修改 `package-lock`、修改正式业务 DTO、占位业务字段、Skill / MCP / 指标正式页面、reasoning 会话持久化路径。

## 1. 交付物

| 交付物 | 路径 |
|---|---|
| 测试文件 | [packages/web/test/embed/sdk-m0-prototype.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk-m0-prototype.test.ts) |
| 本报告 | 本文件 |

测试基础设施沿用既有 `sdk.test.ts`：注入 fake `window` / `iframe`，vitest node 环境，**未引入新依赖，未修改 `package-lock`**。

## 2. 测试命令与结果

```bash
cd runtimes/pi/packages/web
node ../../node_modules/vitest/dist/cli.js --run test/embed/sdk-m0-prototype.test.ts
```

结果：

```text
Test Files  1 failed (1)
Tests  1 failed | 23 passed (24)
```

连同既有 `sdk.test.ts` 一起跑：

```bash
node ../../node_modules/vitest/dist/cli.js --run test/embed/sdk.test.ts test/embed/sdk-m0-prototype.test.ts
```

结果：

```text
Test Files  1 failed | 1 passed (2)
Tests  1 failed | 30 passed (31)
```

## 3. 行为矩阵

| 类别 | 用例 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| **mount / destroy 幂等** | destroy() 重复调用不抛 | 第二次为 no-op | 通过 | ✓ |
| | open() 重复调用只挂一个 iframe | posted 计数不变 | 通过 | ✓ |
| | destroy() 后 open() 不重建 | posted / removed 不变 | 通过 | ✓ |
| | destroy() 未 open() 时监听器干净 | win.handlers 为 0 | 通过 | ✓ |
| | destroy() 后 requestResize / logout / on() 静默 | posted 不增长 | 通过 | ✓ |
| **多实例隔离** | 两个实例共享同一 host window 时互不串扰 | 仅目标实例收到 resize | 通过 | ✓ |
| | A.destroy() 不影响 B | B 仍能收到事件 | 通过 | ✓ |
| | 每个实例的 win.handlers == 1，destroy 只清自己的 | 1 / 0 / 1 | 通过 | ✓ |
| **source / origin / version / envelope** | event.source !== iframe.contentWindow | 拒绝 | 通过 | ✓ |
| | event.data 非对象 / null / 数组 | 拒绝 | 通过 | ✓ |
| | protocol / version / type 任意错误 | 拒绝 | 通过 | ✓ |
| | origin 不在白名单 / 空串 | 拒绝 | 通过 | ✓ |
| | extraOrigins 列入白名单 | 允许 | 通过 | ✓ |
| **resize 非法值与上限** | height > 100000 / 1e9 / Infinity | 拒绝 | 通过 | ✓ |
| | height == 100000（上限） | 接受 | 通过 | ✓ |
| | height == NaN | 拒绝 | 通过（protocol `Number.isInteger` 拦截） | ✓ |
| | height == -1 | 拒绝 | 通过（protocol `height < 0` 拦截） | ✓ |
| | height == 0 | 拒绝 | **失败**：当前透传，emit height=0 | **缺口** |
| | height 是字符串 / null | 拒绝 | 通过（protocol `typeof !== "number"` 拦截） | ✓ |
| | 合法值同步到 iframe 样式 | style.height = "456px" | 通过 | ✓ |
| **launchToken 不落盘** | localStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | sessionStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | document.cookie 写入未触发 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | destroy() 后 reopen 不再携带 token | payload === undefined | 通过 | ✓ |

## 4. 当前实现缺口

### 4.1 resize == 0 被透传

协议层 `decodeEmbedIframeMessage` 已经校验：

- `typeof height !== "number"`：拒绝字符串、null、undefined
- `!Number.isInteger(height)`：拒绝 NaN、小数、Infinity
- `height < 0`：拒绝负数
- `height > POST_MESSAGE_RESIZE_MAX_HEIGHT`：拒绝超过 100000

但 `height == 0` 全部通过：0 是合法整数、非负、未超上限。当前 SDK 会把 0 写入 `iframe.style.height`，产出 0px iframe（视觉上看不见）。建议在 SDK `messageHandler` 的 resize 分支额外加 `decoded.message.height <= 0` 的拒绝，或在协议层把 `height <= 0` 一并拒绝。

### 4.2 仅在 SDK 实例层面加了高度上限拦截

协议层已经做了完整校验，SDK 又叠加 `> EMBED_HEIGHT_MAX` 拦截。两者职责重叠，将来若协议放宽上限（例如响应式分屏），SDK 这层会变成第二道墙，不会自动跟随。建议把 SDK 的 `EMBED_HEIGHT_MAX = 100000` 与协议 `POST_MESSAGE_RESIZE_MAX_HEIGHT` 合并到单一来源（`@earendil-works/pi-protocol`），SDK 只做消息分发。

### 4.3 Launch Token 在内存中"释放"是约定性

`destroy()` 把 `pendingLaunchToken = undefined`，但 JavaScript 字符串不可变，"释放"只是断开引用，不会清零底层 buffer。当前实现对 [frontend.md §3](../../development/agent-platform-v2/frontend.md) "Secret 不进入 DOM、URL、localStorage / sessionStorage、前端日志或错误上报" 的硬性要求已通过；如未来要避免 GC 拷贝，可在 destroy 后 `pendingLaunchToken = "\0".repeat(N)` 之类，但需权衡对调试的影响。

### 4.4 多实例共享宿主页需要 host 配合

测试用两个独立的 fake window 模拟隔离；真实场景里若 host 误把多个 SDK 挂到同一个 `window`，它们会**共享同一个 `message` 监听器池**，但 SDK 实例自身仅消费目标 iframe 的 `event.source`，所以事件仍然只发到目标实例。本原型已通过双实例断言覆盖，但 host 必须确保：

- 不重写 `window.addEventListener("message", ...)`；
- 不在 SDK 之外再添加与 SDK 兼容协议的 message 监听器（否则同一事件会被消费两次）；
- 不主动卸载被 SDK 挂载的 iframe DOM 节点（需要走 `inst.destroy()`）。

## 5. 仍需后端 / 总架构师确认的契约点

以下条目与 §3 行为矩阵并列，决定 SDK 改造时是否一并修改。完整列表见 [contract-questions.md](./contract-questions.md)，本节只列出与本原型直接相关的项。

1. **resize 0 的语义**：是否允许 iframe 上报 0 高度（用于折叠收起）？若是，SDK 必须区分"折叠"与"未挂载"，并在 UI 层给出可见占位；若否，本原型提出的 `height <= 0` 拒绝即可。[contract-questions §5.1–§5.2](../development/agent-platform-v2/contract-questions.md)
2. **resize 上限的归属**：是 SDK 还是协议持有？当前两处都有且值一致。M1 重构成正式 SDK 时建议收敛到协议层（§4.2）。
3. **postMessage 协议版本**：当前为 v1，DTO 冻结后是否升 v2？v2 若是向后不兼容，需同步在 SDK 与 iframe 侧升级；若是兼容扩展，本原型的事件名 `ready` / `error` / `conversation-created` / `resize` 可保持稳定。
4. **Launch Token 内存清理策略**：当前 "释放引用" 已满足 [frontend.md §3](../../development/agent-platform-v2/frontend.md) 的硬性要求。若总架构师要求更严格（如不再 retry exchange 后清零 buffer），需要明确清理时机与对调试的影响。
5. **多实例共享宿主页的契约**：是否在 SDK 文档中显式说明 host 必须用 `inst.destroy()` 卸载、不要直接 DOM 操作？是否需要 SDK 提供 `inst.isMounted()` 与 `inst.iframe` 只读访问？

## 6. 风险与下一步

- **CI 集成**：当前 `sdk-m0-prototype.test.ts` 包含一个硬失败（height == 0）。这是 M0 原型的预期产物，不是 bug。提交时建议在 PR 描述里注明：本测试为 M0 原型缺口报告，§4.1 修复后才会转绿。
- **§4.1 修复路径**：可在 SDK `messageHandler` 的 resize 分支加 `decoded.message.height <= 0` 拒绝，配套更新本测试的"当前实现缺口"段；这是 M1 SDK 改造的第一个候选补丁。
- **暂不动 `skdy-embed.ts` 业务实现**：本原型只追加测试，不改 SDK 源码；M1 SDK 改造时再一次性整理（独立提交）。
# M0 Embed SDK 行为原型报告（修订二）

状态：M0 原型；M0 门禁尚未通过，本原型不视为生产实现；总架构师第一/二轮反馈已合并

负责人：前端工程师

创建日期：2026-08-24（修订二：2026-08-24）

> **修订二要点**
> - 修订一保留了"高度 == 0 转交 M1 SDK 改造"的策略，被第二轮回退。第二轮反馈明确要求"前端必须真正修复 height == 0"；本文件改为记录"已落地"。
> - 多实例测试改用 `makeSharedEnv(iframeCount)`，共享同一宿主 window；详见 §3 行为矩阵。
> - 修订二不再使用 "已冻结/可开发" 等通过性语言；任何通过性措辞只在 M0 门禁通过后才可写入。

本原型仅覆盖 Embed SDK 五类行为：

1. mount/destroy 幂等
2. 多实例（共享宿主 window）监听器隔离与清理
3. source / origin / version / 协议信封校验
4. resize 非法值与上下限（含修订二新增的 `<= 0` 拒绝）
5. launchToken 不落盘

不在本原型范围：Embedding 页面壳、Admin / Skill / MCP / 指标正式页面、reasoning 会话持久化路径、Provider 集成与会话级 `sessionEffort` 覆盖。这些项目见 [m0-survey.md](./m0-survey.md) §2 与 [contract-questions.md](./contract-questions.md) §1.3 / §1.4。

## 1. 交付物

| 交付物 | 路径 |
|---|---|
| 测试文件 | [packages/web/test/embed/sdk-m0-prototype.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk-m0-prototype.test.ts) |
| SDK 实现（含修订二） | [packages/web/src/embed/sdk/skdy-embed.ts](../../../runtimes/pi/packages/web/src/embed/sdk/skdy-embed.ts) |
| 协议实现（含修订二） | [packages/protocol/src/embed/post-message.ts](../../../runtimes/pi/packages/protocol/src/embed/post-message.ts) |
| 配套调研与契约候选 | [m0-survey.md](./m0-survey.md) / [contract-questions.md](./contract-questions.md) |
| 本报告 | 本文件 |

测试基础设施沿用既有 [packages/web/test/embed/sdk.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk.test.ts)：注入 fake `window` / `iframe`，vitest node 环境，**未引入新依赖，未修改 `package-lock`**。新增 `makeSharedEnv(iframeCount)` 辅助构造"同一宿主 window + 多 iframe"的多实例测试场景。

## 2. 第二轮回退 6 项与处理状态

### 2.1 已关闭项

- 结果状态、单调时钟、payload 兼容、空态语义、多实例测试、格式问题（修订一已落地，第二轮无新反馈）。

### 2.2 仍需处理的 6 项 + 本原型处理结果

| # | 阻断项 | 本原型处理 |
|---|---|---|
| 1 | 后端分页契约不完整，且错误地按当前页计算全会话统计 | 不属本原型范围；在 [contract-questions.md §2.1](./contract-questions.md) 跟踪为"后端独立负责" |
| 2 | `turn/failed` 实际被写入，但不在权威事件枚举中 | 不属本原型范围；在 [contract-questions.md §2.2](./contract-questions.md) 跟踪 |
| 3 | 文档仍提前标记"已冻结/可开发"，并保留已否决的 reasoning 预留开关 | 修订二：[m0-survey.md](./m0-survey.md) / [contract-questions.md](./contract-questions.md) / 本文件已删除"已冻结/可开发"通过性措辞；`setThinking` / `thinkingLevel` 不再作为 V2 reasoning 通道 |
| 4 | `sessionEffort`、`usage` 类型被弱化；单调时间顺序也缺少校验 | `sessionEffort` / `usage` 候选契约已写入 [contract-questions.md §1.1/§1.3](./contract-questions.md)；单调时间顺序作为前端契约（仅渲染顺序，不重算）写入 [§1.1](./contract-questions.md) 与本文件 §3 |
| 5 | Skill、MCP、reasoning 持久化等完整 M0 契约尚未提交 | 候选契约已写入 [contract-questions.md §1.3/§1.4](./contract-questions.md)；待后端 + 总架构师批准 |
| 6 | 前端把 height == 0 的必测边界改成了 skip，并没有真正修复 | **本文件 §3 + §4：已在协议 (`< 0` → `<= 0`) 与 SDK (`<= 0` 双重) 落地；用例由 `it.skip` 改回 `it()`** |

## 3. 测试命令与结果

```bash
cd runtimes/pi/packages/web
node ../../node_modules/vitest/dist/cli.js --run test/embed/sdk.test.ts test/embed/sdk-m0-prototype.test.ts
```

结果（修订二）：

```text
Test Files  2 passed (2)
Tests       32 passed (32)
```

修订二去掉了 `it.skip`，全部用例均为通过。

协议包回归（验证 `<= 0` 改动未破坏协议侧）：

```bash
cd runtimes/pi/packages/protocol
node ../node_modules/vitest/dist/cli.js --run
```

结果：

```text
Test Files  9 passed (9)
Tests       321 passed (321)
```

## 4. 行为矩阵（修订二）

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
| | height == -1 | 拒绝 | 通过（protocol `height <= 0` 拦截） | ✓ |
| | **height == 0（修订二）** | 拒绝 | **通过（协议 `<= 0` + SDK `<= 0` 双重拒绝）** | ✓ |
| | height 是字符串 / null | 拒绝 | 通过（protocol `typeof !== "number"` 拦截） | ✓ |
| | 合法值同步到 iframe 样式 | style.height = "456px" | 通过 | ✓ |
| **launchToken 不落盘** | localStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | sessionStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | document.cookie 写入未触发 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | destroy() 后 reopen 不再携带 token | payload === undefined | 通过 | ✓ |

## 5. 修订二修复的 SDK 与协议变更

### 5.1 协议层（canonical）

[packages/protocol/src/embed/post-message.ts:175](../../../runtimes/pi/packages/protocol/src/embed/post-message.ts#L175) `resize` 校验从 `height < 0` 改为 `height <= 0`。该值作为后续 SDK 唯一来源。

```diff
- height < 0 ||
+ height <= 0 ||
```

### 5.2 SDK 层（defense in depth）

[packages/web/src/embed/sdk/skdy-embed.ts:152](../../../runtimes/pi/packages/web/src/embed/sdk/skdy-embed.ts#L152) `messageHandler.resize` 分支增加 `<= 0` 拒绝，纵深防御。

```diff
- if (decoded.message.height > EMBED_HEIGHT_MAX) return;
+ if (
+   decoded.message.height <= 0 ||
+   decoded.message.height > EMBED_HEIGHT_MAX
+ ) {
+   return;
+ }
```

`EMBED_HEIGHT_MAX = 100000` 与协议 `POST_MESSAGE_RESIZE_MAX_HEIGHT` 同值双持的预留在 M1 SDK 改造（独立提交）时收敛到协议层；本原型只补 `<= 0`，不动此收敛。

## 6. 仍待决项（前端 SDK 视角）

1. **resize 上限归属**：协议层单一来源（M1 SDK 改造时移除 SDK 端 `EMBED_HEIGHT_MAX`）。
2. **postMessage 协议是否需要 v2**：当前 v1 + 兼容扩展已批准；如未来需不兼容升级，协议包负责同步升级 SDK / iframe 两侧。
3. **多实例 host 约束**：建议把 [§7.3](#73-多实例共享宿主-window-的-host-约束) 三条 host 约束写入 `@earendil-works/pi-embed-sdk` README。**待定**。
4. **Launch Token 内存清理**：当前"断开引用"已满足硬性要求；如需更严格策略（GC buffer 清零）需总架构师拍板时机与对调试的影响。

## 7. 其它观察项

### 7.1 SDK 与协议层高度上限重叠

SDK 内部 `EMBED_HEIGHT_MAX = 100000` 与协议 `POST_MESSAGE_RESIZE_MAX_HEIGHT = 100000` 同值双持。两者职责重叠，将来若协议放宽上限（例如响应式分屏），SDK 这层会变成第二道墙、不会自动跟随。M1 SDK 改造时收敛到协议层，SDK 只做消息分发。

### 7.2 Launch Token 在内存中"释放"是约定性

`destroy()` 把 `pendingLaunchToken = undefined`，但 JavaScript 字符串不可变，"释放"只是断开引用、不会清零底层 buffer。当前实现已满足 [frontend.md §3](../../development/agent-platform-v2/frontend.md) "Secret 不进入 DOM、URL、localStorage / sessionStorage、前端日志或错误上报" 的硬性要求。若总架构师要求更严格（如不再 retry exchange 后清零 buffer），需要明确清理时机与对调试的影响。**当前无证据表明需要更严格清理**，暂记为观察项。

### 7.3 多实例共享宿主 window 的 host 约束

`makeSharedEnv(iframeCount)` 工具验证：两个 SDK 共享同一 `window` 时，监听器与事件流按 iframe 来源精确路由。本原型已通过"两实例同 window、四断言"覆盖（§4 多实例隔离块）。host 集成时需保证：

- 不重写 `window.addEventListener("message", ...)`；
- 不在 SDK 之外再添加与 SDK 兼容协议的 message 监听器（否则同一事件会被消费两次）；
- 不主动卸载被 SDK 挂载的 iframe DOM 节点（必须走 `inst.destroy()`）。

## 8. 单调时间顺序校验（前端契约）

修订二新增：

- 前端在会话"性能"区按 `requestStartedAt ≤ providerStartedAt ≤ firstOutputAt ≤ completedAt` 升序渲染；后端若返回乱序，前端**不重新计算**，只按时间戳顺序展示。
- 单测要求：人为倒置两个 `TurnMetrics` 的 `firstOutputAt` 与 `completedAt`，UI 必须按 `completedAt` 升序展示。
- 本前端原型不实现该 UI（属 FE-1 范围），仅记录契约到 [contract-questions.md §1.1](./contract-questions.md)。

## 9. 风险与下一步

- **CI 集成**：当前 `sdk-m0-prototype.test.ts` 全绿（32 通过、0 skip）；协议包 321 通过、0 失败。
- **§6 仍待决项**：M1 SDK 改造时一并落地（独立提交）。
- **暂不动 `skdy-embed.ts` 业务实现**：除修订二的 `<= 0` 双重拒绝外，不再扩大改动。
- **页面骨架、状态壳、fixture 适配层仍暂停**：等待后端修订 Metrics/Context 第一批候选（含 §2.2 第 1/2/3 项）+ 总架构师执行第二轮审查 + 首批 DTO 冻结。
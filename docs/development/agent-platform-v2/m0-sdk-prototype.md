# M0 Embed SDK 行为原型报告（第三轮）

状态：M0 原型；M0 门禁尚未通过，本原型不视为生产实现

负责人：前端工程师

创建日期：2026-08-24（第三轮：2026-08-24）

> **第三轮范围说明（第二轮回退修订）**
> - SDK 不再保留 `EMBED_HEIGHT_MAX` magic number 与 `<= 0` 第二份判断；高度 `1..POST_MESSAGE_RESIZE_MAX_HEIGHT` 由 protocol decoder 单一来源校验（详见 §5）。
> - 移除"单调事件顺序"SDK 描述块——其与后端单调时钟语义无关，SDK 不应承担该项契约的可证责任。
> - 文档不再出现前端对后端契约的"定义"；仅描述 SDK 行为与协议层校验。

本原型仅覆盖 Embed SDK 五类行为：

1. mount/destroy 幂等
2. 多实例（共享宿主 window）监听器隔离与清理
3. source / origin / version / 协议信封校验
4. resize 非法值与上下限（边界由 protocol decoder 单一来源决定）
6. launchToken 不落盘

不在本原型范围：Embedding 页面壳、Admin / Skill / MCP / 指标正式页面、reasoning 会话持久化路径、Provider 集成、会话级 reasoningEffort 覆盖。这些项目见 [m0-survey.md](./m0-survey.md) §2 与 [contract-questions.md](./contract-questions.md)。

## 1. 交付物

| 交付物 | 路径 |
|---|---|
| SDK 测试 | [packages/web/test/embed/sdk-m0-prototype.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk-m0-prototype.test.ts) |
| Protocol 测试（含 resize 边界） | [packages/protocol/test/embed/post-message.test.ts](../../../runtimes/pi/packages/protocol/test/embed/post-message.test.ts) |
| SDK 实现（第三轮：单一来源） | [packages/web/src/embed/sdk/skdy-embed.ts](../../../runtimes/pi/packages/web/src/embed/sdk/skdy-embed.ts) |
| Protocol 实现 | [packages/protocol/src/embed/post-message.ts](../../../runtimes/pi/packages/protocol/src/embed/post-message.ts) |
| 配套调研与契约问题 | [m0-survey.md](./m0-survey.md) / [contract-questions.md](./contract-questions.md) |
| 本报告 | 本文件 |

测试基础设施沿用既有 [packages/web/test/embed/sdk.test.ts](../../../runtimes/pi/packages/web/test/embed/sdk.test.ts)：注入 fake `window` / `iframe`，vitest node 环境，**未引入新依赖，未修改 `package-lock`**。新增 `makeSharedEnv(iframeCount)` 辅助构造"同一宿主 window + 多 iframe"的多实例测试场景。

## 2. 三轮迭代要点

| 轮次 | 主要变更 | 验收 |
|---|---|---|
| 第一轮 | 提出原型；多实例测试未真正共享 window；高度 == 0 用例使用普通 `it()`，导致红灯 | 退回修复 |
| 第二轮 | `makeSharedEnv` + 三个多实例用例共用同一 window；`height == 0` 由 `it()` 改为 `it.skip` | 退回：缺口未真正修复 |
| 第三轮 | 协议 `height < 0` → `height <= 0`；SDK 移除 `<= 0` 第二份判断与 `EMBED_HEIGHT_MAX` 常量；协议新增 `decodeEmbedIframeMessage resize boundary (A6)` 7 个用例覆盖 `<=0` / `1` / max / `max+1` / 小数 / `NaN` / `Infinity` / 字符串 / `null` / 缺失；SDK 测试 `it.skip` 改回 `it()` | 见 §3 / §4 |

## 3. 测试命令与结果

```bash
cd runtimes/pi/packages/web
node ../../node_modules/vitest/dist/cli.js --run test/embed/sdk.test.ts test/embed/sdk-m0-prototype.test.ts
```

结果（第三轮）：

```text
Test Files  2 passed (2)
Tests       32 passed (32)
```

协议包回归（验证 `<= 0` 与新增 resize 边界用例）：

```bash
cd /home/hello/workspace/skdy-agent-frontend
node runtimes/pi/node_modules/vitest/dist/cli.js --run --root runtimes/pi/packages/protocol
```

结果：

```text
Test Files  9 passed (9)
Tests       328 passed (328)
```

注：protocol 没有 `typecheck` script，类型检查须按 [contract-questions.md §5.5 Q23](./contract-questions.md) 用两个 tsconfig（`tsconfig.build.json` / `tsconfig.test.json`）的 `tsgo --noEmit` 完成。

## 4. 行为矩阵（第三轮）

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
| **resize 非法值与上限（protocol decoder 单一来源）** | height > 100000 | 拒绝 | 通过（protocol decoder 拦截） | ✓ |
| | height == 100000（上限） | 接受 | 通过 | ✓ |
| | height == 1（下界） | 接受 | 通过（protocol 单测） | ✓ |
| | height == 0（第三轮） | 拒绝 | 通过（protocol decoder `height <= 0` 拦截） | ✓ |
| | height == -1 | 拒绝 | 通过（protocol decoder `height <= 0` 拦截） | ✓ |
| | height == NaN / 1.5 / Infinity | 拒绝 | 通过（protocol decoder `Number.isInteger` 拦截） | ✓ |
| | height 是字符串 / null / 缺失 | 拒绝 | 通过（protocol decoder `typeof !== "number"` 拦截） | ✓ |
| | 合法值同步到 iframe 样式 | style.height = "456px" | 通过 | ✓ |
| **launchToken 不落盘** | localStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | sessionStorage.setItem 未被调用 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | document.cookie 写入未触发 | 调用次数 = 0，参数不含 sentinel | 通过 | ✓ |
| | destroy() 后 reopen 不再携带 token | payload === undefined | 通过 | ✓ |

## 5. SDK 与协议层职责切分（第三轮）

| 维度 | SDK 职责 | 协议职责 |
|---|---|---|
| 高度 `1..POST_MESSAGE_RESIZE_MAX_HEIGHT` 校验 | 不复制 magic number；信任 `decodeEmbedIframeMessage` 返回值；`if (!decoded.ok) return` 即拒绝 | `decodeEmbedIframeMessage` 单一来源；常量 `POST_MESSAGE_RESIZE_MAX_HEIGHT = 100000` |
| resize 监听器分发 | 调用 `emit("resize", { height })` 与 `syncHeight(h)` | — |
| 协议版本号、字段命名 | 不复制；只 import `POST_MESSAGE_PROTOCOL` / `POST_MESSAGE_VERSION` / `decodeEmbedIframeMessage` | 协议包单一来源 |

第三轮删除：

- `const EMBED_HEIGHT_MAX = 100000`（SDK 副本）
- `case "resize"` 分支内 `<= 0 || > EMBED_HEIGHT_MAX` 二次判断

第三轮新增：

- `case "resize"` 仅 `emit` + `syncHeight`，依赖协议层 `decodeEmbedIframeMessage` 单一拒绝
- 协议测试 `decodeEmbedIframeMessage resize boundary (A6)` 7 用例（见 [post-message.test.ts](../../../runtimes/pi/packages/protocol/test/embed/post-message.test.ts)）

## 6. SDK 仍待决项（前端范围内）

1. SDK 包名/导出名是否冻结为 `@earendil-works/embed-sdk` + `createEmbed` / `EmbedInstance`？[contract-questions.md §5.5 Q20](./contract-questions.md)
2. postMessage 协议是否需要 v2？[contract-questions.md §5.5 Q20](./contract-questions.md)
3. 多实例 host 约束：建议把"不重写 `window.addEventListener("message", ...)` / 不在 SDK 之外添加同协议监听 / 不主动卸载 SDK 挂载的 iframe"三条 host 约束写入 `@earendil-works/embed-sdk` README。**待定**。
4. Launch Token 内存清理：当前"断开引用"已满足硬性要求；如需更严格策略（GC buffer 清零）需总架构师拍板时机与对调试的影响。

## 7. 其它观察项

### 7.1 Launch Token 在内存中"释放"是约定性

`destroy()` 把 `pendingLaunchToken = undefined`，但 JavaScript 字符串不可变，"释放"只是断开引用、不会清零底层 buffer。当前实现已满足 [frontend.md §3](../../development/agent-platform-v2/frontend.md) "Secret 不进入 DOM、URL、localStorage / sessionStorage、前端日志或错误上报" 的硬性要求。若总架构师要求更严格（如不再 retry exchange 后清零 buffer），需要明确清理时机与对调试的影响。**当前无证据表明需要更严格清理**，暂记为观察项。

### 7.2 多实例共享宿主 window 的 host 约束

`makeSharedEnv(iframeCount)` 工具验证：两个 SDK 共享同一 `window` 时，监听器与事件流按 iframe 来源精确路由。本原型已通过"两实例同 window、四断言"覆盖（§4 多实例隔离块）。host 集成时需保证：

- 不重写 `window.addEventListener("message", ...)`；
- 不在 SDK 之外再添加与 SDK 兼容协议的 message 监听器（否则同一事件会被消费两次）；
- 不主动卸载被 SDK 挂载的 iframe DOM 节点（必须走 `inst.destroy()`）。

## 8. 风险与下一步

- **CI 集成**：当前 SDK 32 通过、0 skip；protocol 328 通过、0 失败。
- **§6 仍待决项**：M1 SDK 改造时一并落地（独立提交）。
- **页面骨架、状态壳、fixture 适配层仍暂停**：等待 R1～R5 后端独立提交契约或代码，并由总架构师执行第二轮审查、首批 DTO 冻结（见 [contract-questions.md §5.7](./contract-questions.md)）。
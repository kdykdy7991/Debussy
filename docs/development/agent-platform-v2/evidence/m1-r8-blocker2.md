# M1 R8 Blocker 2 — capability 数据源待后端契约冻结

> 状态：R8 验证过程中识别。
> 决策：FE 不自行扩展 DTO；架构师待确认会话级 capability 只读契约。

## 1. 阻断项原文

> 2. capability 来源不是会话固定版本
>
> 当前通过：
>
>     conversation.agentId
>     → AgentApi.getAgentDetail()
>     → 当前 Agent modelId
>     → 当前 LLM catalog
>
> 这会让旧会话在 Agent 新 Revision 或新版本发布后显示新的档位，
> 与后端基于固定 PublishedAppVersion 的语义冲突。
>
> 前端必须消费后端提供的"该会话固定版本 capability"，不能查询当前
> Agent Definition 推导。需要和后端一起确定只读契约；在契约
> 冻结前不要自行扩展 DTO。
>
> 补测试：Agent 发布 v2 后，v1 会话仍显示 v1 的 effort 档位。

## 2. 根因

R7 之前的 capability 推导链：

```
ConversationAdminSummary.agentId
  → AgentApi.getAgentDetail(agentId)         // ← 当前 Agent Revision
  → detail.modelId
  → LlmApi.listModels()                       // ← 当前 LLM catalog
  → LlmAvailableModel.parameterCapabilities  // ← 当前能力
```

这条链路在 Agent 升级后**会**让 v1 会话在 UI 上看到 v2 档位。问题：

- **会话级 effort 覆盖的语义是"基于该会话创建时锁定的版本"**——用户改
  v1 会话的努力不能因为 Agent 后续发版而漂移到新档位集合。
- **DTO 不允许 FE 自行扩展**——必须在 BE + 协议层定义"会话固定
  capability"的只读契约，FE 消费该契约。

## 3. R8 临时方案

`reasoning-tab.tsx` 顶部增加显眼 TODO（`// TODO(architect-confirm)`），
**不**调用 `agentApi.getAgentDetail` / `llmApi.listModels`：

- `CapabilityState` 简化为两种形态：
  - `awaiting-contract`：BE 契约待定；UI 隐藏档位编辑入口，渲染说明壳。
  - `ready`：BE 契约冻结后接入——R8 暂未实现，留占位说明。
- 移除 `ReasoningTab` 的 `agentApi` / `llmApi` props（`conversation-detail.tsx` 同步移除）。
- 移除 `AgentApi` / `LlmApi` import（这两个 import 在 conversation-detail 不再被使用）。
- `getReasoning` / `putReasoning` 仍可用（事实源 + 写接口不变），但 UI 不暴露
  非空档位保存——`onSave` 在 `nextEffort !== null` 时返回 `REASONING_INVALID_EFFORT`
  错误，提示等待契约；`null`（清除覆盖）仍可发，服务端 422 兜底。

### 3.1 R8 不做的事

- **不**新增 capability DTO 字段到 `ConversationReasoningState`。
- **不**调用 `agentApi.getAgentDetail` 或 `llmApi.listModels`（推导当前 Agent
  状态会与"会话固定"语义冲突）。
- **不**实现 `ConversationsApi.getCapability`（等契约冻结）。
- **不**在 FE 缓存"v1 capability 快照"——R8 之后 capability 完全不加载。

## 4. 推荐的 BE 契约草案（待架构师确认）

### 4.1 端点

```
GET /api/control/v1/conversations/{conversationId}/capability
```

返回 200：会话创建时锁定的 capability 快照。

### 4.2 响应

```ts
interface ConversationPinnedCapability {
  readonly conversationId: ConversationPublicId;
  readonly publishedAppVersionId: PublishedAppVersionPublicId;
  readonly modelId: string;
  readonly parameterCapabilities: ModelParameterCapabilities;
}
```

### 4.3 错误码

- `404 CONVERSATION_NOT_FOUND`：跨租户 / 跨属主，**不**暴露归属。
- `409 CAPABILITY_NOT_PINNED`：v0 旧会话（无 publishedAppVersion 字段）——该
  会话是 V1 prototype，UI 应当提示"该会话未固定 capability，不可调整"。

### 4.4 写入一致性

- `GET /reasoning` 与 `GET /capability` **不**要求在同一事务——capability
  是会话创建时一次性写入的快照，read 时不变。
- `PUT /reasoning` 时不需要重新校验 capability（`effort` 已经在
  `parameterCapabilities.reasoning.efforts` 内的会话级别校验），服务端
  复用会话创建时的 capability 即可。
- **如果 capability 是 null（V0 legacy 会话）** → `PUT /reasoning` 一律返回
  `REASONING_NOT_CONFIGURABLE`（或更具体的 `CAPABILITY_NOT_PINNED`——待定）。

## 5. 接入步骤（BE 契约冻结后）

1. 在 `packages/protocol/src/admin-workbench-reasoning.ts` 新增：
   - `ConversationPinnedCapability` 类型；
   - 端点常量 `AGENT_V2_REASONING_CAPABILITY_PATH`；
   - 错误码 `CAPABILITY_NOT_PINNED`（若需要）。
2. `ConversationsApi.getCapability(conversationId, signal?)` 走新端点。
3. `reasoning-tab.tsx` 接入 capability 加载：
   - 新增独立 `capabilityGuard`（不与 `stateGuard` / `saveGuard` 共享）。
   - `loadCapability` 调 `getCapability(cid, ticket.signal)` → 解析为
     `CapabilityState`（`loaded` / `missing` / `unsupported` / `error`）。
   - `stateGuard` 与 `capabilityGuard` 互不取消（R7 阻断项 #1 已修）。
4. 启用 `conversation-reasoning-pinned-capability.test.tsx` 的三个 `it.skip`：
   - **v1 → v2 隔离**：mock `getCapability` 返回 v1 capability，Agent
     升级到 v2 后再次渲染组件，断言档位列表仍是 v1 的 `["low", "medium"]`。
   - **capability 失败不取消 state**：mock `getCapability` reject + `getReasoning` resolve，
     断言 component DOM 出现 `<select>` 显示已加载的 effort（如 "low"），capability 走 error 壳。
   - **切换 conversation 不污染**：先以 conv_A 发起 load，再 unmount + remount conv_B，
     断言 conv_A 的 capability 响应不写到 conv_B 的 state。

## 6. 回归约束（防回退）

- 禁止在 `reasoning-tab.tsx` 内重新 `import` `AgentApi` / `LlmApi` ——除非
  BE 契约冻结并经架构师 review 通过。
- `CapabilityState` 形态**必须**只有 `awaiting-contract` + `ready` 两种；
  旧的 `idle / loading / loaded / missing-model / unsupported / no-configurable / error`
  七态在 R8 已删除。
- `test/admin/user-conversations/conversation-reasoning-tab.test.tsx` 断言
  "不存在 `<select id="reasoning-effort-draft">`"——BE 契约冻结后这断言
  改为"存在 select 且档位来自 `getCapability` 返回的 efforts"。

## 7. 关联

- [m1-browser-acceptance-2026-08-24.md](./m1-browser-acceptance-2026-08-24.md) — R2 联调 8 场景 evidence doc，本 blocker 是其中"4 错误场景"里 FE 发现 capability 错误的子集。
- `src/admin/user-conversations/reasoning-tab.tsx` — TODO(architect-confirm) 注释。
- `src/admin/user-conversations/conversation-detail.tsx` — 移除 `agentApi` / `llmApi` 构造。
- `test/admin/user-conversations/conversation-reasoning-pinned-capability.test.tsx` — 占位脱型测试。

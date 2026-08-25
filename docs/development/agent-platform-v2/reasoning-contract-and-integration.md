# Conversation Reasoning — 后端接口契约与前端联调材料

基线分支：`feature/agent-v2-reasoning-backend` @ `dbe175e`（工作区 `/home/hello/workspace/skdy-agent-backend`）。

本文给前端联调提供：能力范围、路由、请求/响应字段、错误码、流式事件与审计格式、五组 mock 示例、改动文件清单、测试命令与结果。当前共享 `.git` 为只读文件系统，本分支**不 commit / push / fetch / merge / 建分支**，源码与测试可正常进行。

## 1. 能力范围

会话级"思考强度"（reasoning effort）覆盖。生效优先级固定为：

```
会话 effort 覆盖  >  Agent Revision 默认  >  Provider/模型默认
```

- `effort: null` = 清除会话覆盖，回落 Agent Revision 默认。
- 只允许改 `effort` 一个字段；其它生成采样参数由服务端代码或 Provider 固定。
- 事实源与审计分离：
  - **事实源**（恢复 / 查询读这里）= 新表 `conversation_reasoning_state`，更新即写；
  - **审计日志** `conversation.reasoning-updated` = `audit_events` 独立只追加日志，**不是**
    `conversation_events`，不推进事件 sequence、不参与 turn 回放。
  - 写事实源 + 写审计在同一 **PostgreSQL 事务**。

两个入口共享同一服务操作，仅授权门不同，避免 Control Admin 与 Embed 会话权限混在一条路由里。

## 2. DTO（`@earendil-works/pi-protocol` → `admin-workbench-reasoning.ts`）

```ts
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 更新请求体（两个入口共用）。*/
export interface ReasoningUpdateRequest {
	/** 会话思考强度覆盖；null = 清除覆盖，回到 Agent Revision 默认。 */
	readonly effort: ReasoningEffort | null;
}

/** 单个会话当前生效的 reasoning 状态（事实源读取）。 */
export interface ConversationReasoningState {
	readonly conversationId: ConversationPublicId;   // 形如 conv_<uuid>
	readonly effort: ReasoningEffort | null;
	readonly updatedAt: string;                       // ISO 8601 UTC
	readonly configurable: boolean;                   // pinned 版本是否允许会话级覆盖
	readonly pinnedCapability: {
		readonly publishedAppVersionId: PublishedAppVersionPublicId; // pav_<uuid>
		readonly modelId: string;
		readonly reasoning: ModelParameterCapabilities["reasoning"];
	} | null;                                          // 无冻结能力时为 null
}
```

`ModelParameterCapabilities["reasoning"]` 形状（发布时冻结进 Published App Version）：

```ts
{
	supported: boolean;
	toggle: boolean;                 // 是否可用 enabled 关思考
	efforts: ReasoningEffort[];      // 该模型允许的档位白名单
	defaultEffort?: ReasoningEffort; // 默认档位（可选）
}
```

## 3. 路由、请求与响应

### 3.1 控制面管理员（Admin Token）

- `GET  /api/control/v1/conversations/:conversationId/reasoning`
- `PUT  /api/control/v1/conversations/:conversationId/reasoning`

### 3.2 Embed 属主（会话属主 Embed principal）

- `GET   /api/embed/v1/conversations/:conversationId/reasoning`（会话 reasoning 状态读取 / 刷新重连恢复）
- `PUT   /api/embed/v1/conversations/:conversationId/reasoning`（会话属主调整 effort）

请求体两入口一致，均为 `ReasoningUpdateRequest`。响应 `{ data: ConversationReasoningState, requestId }`。

`PUT` 幂等（请求体即目标状态）。

## 4. 错误码

稳定错误码定义在 `admin-workbench-reasoning.ts`：

| 场景 | 状态 | code | retryable | 触发 |
| --- | --- | --- | --- | --- |
| 请求体形状错误（非对象 / 缺 `effort` / 多余字段 / `effort` 非 `null` 非字符串） | 400 | `INVALID_REQUEST` | false | HTTP 边界解析 |
| JSON 解析失败（embed 面） | 400 | `INVALID_JSON` | false | embed 边界 |
| 请求体过大（embed 面） | 413 | `PAYLOAD_TOO_LARGE` | false | embed 边界 |
| `effort` 是字符串但不是协议档位（6 档之外），或不在 pinned 模型声明档位内 | 422 | `REASONING_INVALID_EFFORT` | false | 边界 / 服务层 |
| 合法属主但策略禁止调整，或该 pinned 版本无冻结 reasoning 能力 | 403 | `REASONING_NOT_CONFIGURABLE` | false | 服务层 |
| 跨租户 / 跨属主 / 会话不存在（不暴露归属与存在性） | 404 | `CONVERSATION_NOT_FOUND` | false | 服务层 |
| 服务内部故障 | 5xx | 视具体 | true | 服务层 |

> 边界解析区分两档：`effort: "ultra"`（字符串但不属 6 协议档位）→ 422 `REASONING_INVALID_EFFORT`；`effort: 42`（非字符串非 null 的类型错）→ 400 `INVALID_REQUEST`。模型能力档位不匹配（协议 6 档内但不在 pinned 模型 efforts 里）也是 422 `REASONING_INVALID_EFFORT`。

错误响应信封（控制面与 Embed 同构）：

```json
{ "error": { "code": "REASONING_INVALID_EFFORT", "message": "...", "requestId": "req_...", "retryable": false } }
```

成功响应：`{ "data": <ConversationReasoningState>, "requestId": "req_..." }`。

## 5. 流式事件与审计

- **不改变 turn 流式事件格式**：reasoning 不是流式/对话事件能力。它只在 turn 请求组装点把会话 effort 叠加入模型请求：
  `withConversationEffort(base, conversationEffort)` → `resolveModelStreamOptions` →
  `AI StreamOptions / thinkingLevel`。
- 每次覆盖写入一条 append-only 审计记录（`audit_events`），字段：

```ts
{
	action: "conversation.reasoning-updated";
	actorType: "platform_admin" | "embed_owner";
	actorId: string;                        // "admin" / 内部 principal uuid
	resourceType: "conversation";
	resourceId: string;                     // 内部 conversation uuid
	requestId: string;
	metadata: {
		conversationId: "conv_<uuid>";
		principal: { type: "admin" | "embed-owner"; id: string };
		before: ReasoningEffort | null;      // 写入前持久状态值
		after:  ReasoningEffort | null;
		requestedAt: string;                 // ISO 8601 UTC
	};
	createdAt: string;
}
```

## 6. 前端联调 mock 示例（五组）

### M1 成功·设置覆盖

```
PUT /api/control/v1/conversations/conv_a1b2c3/reasoning
Content-Type: application/json
{ "effort": "high" }
```

```json
{
	"data": {
		"conversationId": "conv_a1b2c3",
		"effort": "high",
		"updatedAt": "2026-08-24T09:35:00.000Z",
		"configurable": true,
		"pinnedCapability": {
			"publishedAppVersionId": "pav_v9",
			"modelId": "Qwen3.8-Agent",
			"reasoning": { "supported": true, "toggle": true, "efforts": ["low", "medium", "high"], "defaultEffort": "high" }
		}
	},
	"requestId": "req_01"
}
```

### M2 成功·清除覆盖（回落 Revision 默认）

```
PUT /api/control/v1/conversations/conv_a1b2c3/reasoning
{ "effort": null }
```

```json
{
	"data": {
		"conversationId": "conv_a1b2c3",
		"effort": null,
		"updatedAt": "2026-08-24T09:40:00.000Z",
		"configurable": true,
		"pinnedCapability": {
			"publishedAppVersionId": "pav_v9",
			"modelId": "Qwen3.8-Agent",
			"reasoning": { "supported": true, "toggle": true, "efforts": ["low", "medium", "high"], "defaultEffort": "high" }
		}
	},
	"requestId": "req_02"
}
```

### M3 空状态·从未写入（GET，读取回仅 effort:null）

```
GET /api/control/v1/conversations/conv_a1b2c3/reasoning
```

```json
{
	"data": {
		"conversationId": "conv_a1b2c3",
		"effort": null,
		"updatedAt": "2026-08-24T08:00:00.000Z",
		"configurable": true,
		"pinnedCapability": {
			"publishedAppVersionId": "pav_v9",
			"modelId": "Qwen3.8-Agent",
			"reasoning": { "supported": true, "toggle": true, "efforts": ["low", "medium", "high"], "defaultEffort": "high" }
		}
	},
	"requestId": "req_03"
}
```

### M4 非法档位（422）

```
PUT /api/control/v1/conversations/conv_a1b2c3/reasoning
{ "effort": "max" }
```

```json
{ "error": { "code": "REASONING_INVALID_EFFORT", "message": "parameters.reasoning.effort must be one of: low, medium, high", "requestId": "req_04", "retryable": false } }
```

（模型能力不匹配示例；若 `effort` 本身不在 6 协议档位内，message 为
`effort is not one of the supported reasoning tiers`。）

### M5 策略禁止（403）/ 不存在或越权（404）

```
PUT /api/control/v1/conversations/conv_a1b2c3/reasoning
{ "effort": "medium" }
```

```json
{ "error": { "code": "REASONING_NOT_CONFIGURABLE", "message": "policy forbids adjusting reasoning effort for this conversation", "requestId": "req_05", "retryable": false } }
```

```
PUT /api/control/v1/conversations/conv_missing/reasoning
{ "effort": "low" }
```

```json
{ "error": { "code": "CONVERSATION_NOT_FOUND", "message": "conversation not found in tenant scope", "requestId": "req_06", "retryable": false } }
```

## 7. 改动文件清单（本次 reasoning 工作涉及）

源码：

- `runtimes/pi/packages/protocol/src/admin-workbench-reasoning.ts`（DTO + 错误码 + 常量）
- `runtimes/pi/packages/server/src/agent-v2/reasoning.ts`（共享 apply 操作 + pinned 能力解析）
- `runtimes/pi/packages/server/src/model-parameters.ts`（`withConversationEffort` / 校验 / 档位映射）
- `runtimes/pi/packages/server/src/persistence/postgres/migrations/0011_conversation_reasoning_state.sql`
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/conversation-reasoning.ts`
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/index.ts`
- `runtimes/pi/packages/server/src/publishing/repositories.ts`（仓库接口）
- `runtimes/pi/packages/server/src/publishing/control/http.ts`（GET/PUT 控制面路由）
- `runtimes/pi/packages/server/src/publishing/control/service.ts`（`getConversationReasoning`/`setConversationSessionEffort`）
- `runtimes/pi/packages/server/src/embed/conversations/http.ts`（PUT Embed 路由）
- `runtimes/pi/packages/server/src/embed/conversations/service.ts`（`setConversationReasoning` + turn 载入会话 effort）
- `runtimes/pi/packages/server/src/runtime/scope-context.ts`（`conversationEffort`）
- `runtimes/pi/packages/server/src/runtime/pi-runtime-adapter.ts`（`withConversationEffort` 叠加）

测试：

- `runtimes/pi/packages/protocol/test/admin-workbench-reasoning.test.ts`
- `runtimes/pi/packages/server/test/publishing/control-reasoning.test.ts`
- `runtimes/pi/packages/server/test/embed/reasoning.test.ts`
- `runtimes/pi/packages/server/test/publishing/conversation-reasoning-repository.test.ts`
- `runtimes/pi/packages/server/test/publishing/control-service.test.ts`
- `runtimes/pi/packages/server/test/runtime/pi-runtime-adapter.test.ts`
- `runtimes/pi/packages/server/test/model-parameters.test.ts`

## 8. 测试命令与结果（已于工作区实际运行）

需本地 PostgreSQL（测试库 `postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test`）。

```bash
# 1) protocol 契约（纯，不需 DB）
cd runtimes/pi/packages/protocol
node ../../node_modules/vitest/dist/cli.js --run test/admin-workbench-reasoning.test.ts
# => Test Files 1 passed; Tests 4 passed

# 2) server reasoning 契约/仓库/路由/适配器/参数（需 DB，DB 不可达自动 skip）
#    含 embed GET/PUT /reasoning 路由 + 跨租户404/跨属主404/configurable/null capability/覆盖值/cleared/401
cd runtimes/pi/packages/server
node ../../node_modules/vitest/dist/cli.js --run \
  test/publishing/control-reasoning.test.ts \
  test/embed/reasoning.test.ts \
  test/publishing/conversation-reasoning-repository.test.ts \
  test/runtime/pi-runtime-adapter.test.ts \
  test/publishing/control-service.test.ts \
  test/model-parameters.test.ts
# => Test Files 6 passed; Tests 74 passed

# 3) model-parameters 档位校验/映射（已含在 #2，单独跑亦可）
node ../../node_modules/vitest/dist/cli.js --run test/model-parameters.test.ts
# => Test Files 1 passed; Tests 14 passed
```

合计 reasoning 相关：**7 个测试文件、78 个用例全部通过**（本工作区 Postgres 5433 已运行；
embed reasoning 单文件 16 用例，含新增 GET 路径）。

服务器启动：control 与 embed 的 reasoning 端点挂载在同一个 HTTP 服务上（control 经
`createControlHttpHandler`，embed 经 `createConversationsHttpHandler`）。常规启动走 `packages/server` 的
`npm run dev` / 既有 serve 入口；联调可用第 6 节 mock 直接验证，不要求先起完整 Compose 栈。

## 9. 前端需要配合的事项

1. 本分支 `packages/web` **尚未**实现对会话 reasoning 端点（GET/PUT）的调用；当前仅有
   `admin/agents/reasoning-efforts.ts`（模型能力档位 → UI 标签映射，M0 阶段产物）。前端需新增
   `conversations.reasoning` API 与状态管理。
2. Embed SDK 侧新增"会话属主调整思考强度"调用（`PUT /api/embed/v1/conversations/:id/reasoning`）；
   对话框"思考强度"控件的选项集来自 `pinnedCapability.reasoning.efforts`，而不是硬编码 6 档。
3. `reasonable efforts` 展示应使用 `ConversationReasoningState.effort`；`null` 表示"使用 Agent
   Revision 默认"（可在 UI 显示为"跟随默认"，或根据 `pinnedCapability.reasoning.defaultEffort` 提示默认值）。
4. `configurable === false` 或 `pinnedCapability === null` 时，禁止会话思考强度控件交互（显示只读/禁用）。
5. 错误处理按第 4 节映射：400（请求形状）/ 422（非法档位）/ 403（策略禁止）/ 404（不存在或越权），
   用 `error.retryable` 决定是否重试；`REASONING_NOT_CONFIGURABLE` 与 `CONVERSATION_NOT_FOUND` 都要展示成
   "不可调整"，但**不要**因 404 而暴露会话归属信息。
6. 成功示例 / 空状态 / 非法 / 403 / 404 五组 fixture 见第 6 节，可直接作为前端 mock 与单元测试基线。
---

## 10. 分工决策记录（Q1–Q8，后端确认；待总架构师冻结）

以下为后端对前端 8 个契约问题的确认结论。标 `[已实现]` = 当前 `dbe175e` 代码已如此；
标 `[需小改]` = 需对 DTO/服务做增量小改并补测试，属契约增补，需下轮验收冻结。

### Q1 capability 数据源 → 是，固定内嵌，原子返回
`[已实现]` `pinnedCapability` 正式固定为 `ConversationReasoningState` 的内嵌字段，与 `effort` 在同一
JSON 对象原子返回（GET 与 PUT 成功响应同构）。数据源=会话固定的 Published App Version runtimeSpec 内
冻结的 `model.parameterCapabilities`（`reasoningCapabilitiesForVersion`），**不查实时 LLM catalog**。
`GET /conversations/{id}/capability` **不提供**；capability 只随 reasoning 状态内嵌返回。
（Embed 面 GET+PUT 均提供；Control 面 GET+PUT。）

### Q2 capability 状态定义 → `unavailable | ready` 两态，不加 awaiting-contract
`[已实现]` 以 `pinnedCapability` + `pinnedCapability.reasoning.{supported,efforts}` 派生即可，
`awaiting-contract` 已随本分支契约冻结而作废，不再需要。前端状态判定：

| 场景 | GET 返回的字段/值 | 前端状态 |
| --- | --- | --- |
| legacy 会话（未固定 reasoning 能力） | `pinnedCapability:null`，`configurable:false` | `unavailable` |
| `pinnedCapability.reasoning.supported=false` | `pinnedCapability` 存在，`supported:false`，`efforts:[]`，`configurable:true` | `unavailable` |
| `pinnedCapability.reasoning.efforts=[]` | 同上（`efforts=[]`） | `unavailable` |
| `configurable=false`（无论原因） | → `unavailable`（当前代码仅 legacy 触发） | `unavailable` |
| `supported:true && efforts.length>0 && configurable:true` | 正常 | `ready` |

> 说明：`toggle` 只表示该模型是否可关闭思考（`enabled:false`）。会话覆盖端点不改 `toggle`，
不经它判定 ready/unavailable；`toggle:false` 仍可在 `ready` 态调整 effort 档位。

### Q3 错误码契约 → 不新增 `CAPABILITY_NOT_PINNED`；GET 直接表达不可用
`[已实现]`
- legacy / 无冻结能力：沿用 **403 `REASONING_NOT_CONFIGURABLE`**，**不新增** `CAPABILITY_NOT_PINNED`。
  区分信息已在 GET 的 `pinnedCapability:null` 中表达，不再造第二个错误码；
- `supported=false` / `efforts=[]`：**GET 直接表达不可用**（`supported:false`、`efforts:[]`），
  前端据此禁用 select、不发起非 `null` 的 PUT。后端仍以 **422 `REASONING_INVALID_EFFORT`** 兜底
  （请求一个该模型不接受的档位），不新增错误码；
- `effort:null`（清除）在支持/不支持两种情况下都返回 200（清除是安全操作）。

### Q4 Agent Revision 默认值 → 字段 `revisionDefaultEffort`（**已撤销，见 §11 Q1**）
`[需小改]` 选择"使用 Agent Revision 默认"时，当前 DTO 只有 `pinnedCapability.reasoning.defaultEffort`
（模型能力默认），**不含** Revision 配置的默认档位。决定：**扩展现有 GET reason reasoning DTO**（同一原子
响应），不新增接口。字段：

```ts
/** pinned Agent Revision 显式配置的默认 effort；null = Revision 未设档位（落 Provider/模型默认）。 */
readonly revisionDefaultEffort: ReasoningEffort | null;
```

- 取值：pinned runtimeSpec `agent.model.params.reasoning.effort`；
- 空值语义：`effort`（会话覆盖）为 `null` 时，前端展示的"实际生效默认"
  = `revisionDefaultEffort ?? pinnedCapability.reasoning.defaultEffort ?? null`（三者都空则完全交给 Provider）。
- 这是**契约增补**，需同时改 `reasoningCapabilitiesForVersion`/GET 服务返回值 + 测试，走下轮验收冻结。

### Q5 保存协议与进度 → 同步，不做 SSE
`[已实现]` PUT 为**同步**请求：单 PostgreSQL 事务写事实源+审计，`200` 立即返回完整状态，无模型调用，
耗时可控。**本次不做 SSE/流式进度**；若未来需要，事件 schema 另行冻结，不占本次范围。前端仅展示本地
`saving` 状态并禁用 select；失败由用户手动重试（PUT 幂等，重试安全）。

### Q6 审计展示 → 本次只展示时间；"谁"不入 reasoning 状态 DTO
`[已实现/决策]` `ConversationReasoningState.updatedAt` 已返回"何时"；**"谁"不加入 GET reasoning DTO**
（MVP 不展示）。`updated_by` / `audit_events` 已持久化，"谁"如需展示，后续从审计读取或加个一字节字段即可，
不阻塞本次联调。看板如需"最后修改人"，前端先用 `updatedAt` + 空 `lastModifiedBy`，后端不做承诺。

### Q7 模型下架 → pinned 能力不随目录变化，无"下架"态
`[已实现]` 能力在发布时**冻结进版本**，`modelId` 即使从 LLM catalog 下架，GET reasoning 仍返回原
`pinnedCapability`（同一模型、同一档位白名单、`configurable` 不变）。**前端不需要展示"模型已下架"，也不禁止
修改 effort**；仅 `pinnedCapability===null`（Q2 `unavailable`）才禁用。运行时实际无法服务（Provider 挂了）
属运行期 `runtimeUnavailable`，归 turn 通道，不属 reasoning 状态。

### Q8 长请求与网络策略 → 采纳：30s 超时 + 手动重试，无自动重试
`[决策]` 后端不提供 `Retry-After` / 服务端重试约束。采纳前端方案：请求超时 **30s**；失败仅用户手动重试，
**不做网络恢复后的自动重试**。因为 PUT 幂等，手动重试安全，不会产生重复覆盖副作用。

---

## 11. 契约层追加确认（前端第二轮问题，后端 owner 确认）

### Q1 revisionDefaultEffort → **不加**，DTO 维持 `dbe175e` 原样（BE 不动）
后端确认：`ConversationReasoningState` **不新增** `revisionDefaultEffort` 字段。理由：
- 会话 reasoning 状态只承载"会话级覆盖 + 允许档位能力"；"Agent Revision 默认档位"属 Revision 配置面，
  不在会话 reasoning 契约里重复导出，避免把已冻结 DTO 扩大到一个纯展示便利字段；
- 前端"使用 Agent Revision 默认" = `effort:null`，可渲染为"跟随 Revision 默认"，无需数值；如需精确档位，
  从 Agent/Revision 配置读取，不走会话 reasoning 状态；
- 这消除上一轮"决策 #4"单边改动的风险：两端 DTO 回到同一冻结版本，BE 零改动，前端可立即回滚。
- **陷阱提示**：`pinnedCapability.reasoning.defaultEffort` 是**模型/Provider 默认**，**不是** Agent Revision
  默认档位；修复后若前端拿它冒充"Revision 默认"会展示错值。

### Q4 Embed 错误码 → **不再细分**，沿用共享冻结码（当前已按语义独立）
后端确认：Embed 与 Control 平面共享同一 `AGENT_V2_REASONING_ERROR_CODES`，当前已把"形状 / 档位 / 策略 /
不存在"四类语义拆成独立 `code`：
- shape 错 → 400 `INVALID_REQUEST`
- 档位非法（协议外档位或不在模型档位内）→ 422 `REASONING_INVALID_EFFORT`
- 合法属主但不可配置/无冻结能力 → 403 `REASONING_NOT_CONFIGURABLE`
- 越权/不存在 → 404 `CONVERSATION_NOT_FOUND`
此外 `INVALID_JSON`(400) / `PAYLOAD_TOO_LARGE`(413) 为 embed 边界保留。请前端按 `code` 分支（不要只按状态码），
四类已各自独立，无需再细分。

### Q5 Embed 无 GET → **已补齐**：`GET /api/embed/v1/conversations/:id/reasoning` 已实现
后端确认现状：`dbe175e` 原始实现 Embed **只有 PUT reasoning、没有 GET reasoning**；且现有
`GET /api/embed/v1/conversations/:id`（`conversationView`）**不返回 effort**。所以"会话上下文 GET 一定能拉到
effort"不成立，前端不能依赖它做刷新恢复。
但 V2-README §4.3 / 管理清单明确要求"刷新/重连可恢复"会话覆盖——仅靠 PUT 返回无法在全新加载后恢复。
**决策与实现：已由后端在本分支新增 `GET /api/embed/v1/conversations/:conversationId/reasoning`**
（镜像 Control GET），复用既有 `ConversationReasoningState`（含 `effort`，恢复足够）。前端**不要自行加 GET**。
实现位置：`embed/conversations/service.ts`（`getConversationReasoning`，owner scope 解析 + pinned 能力读取）、
`embed/conversations/http.ts`（`GET .../reasoning` 路由）。测试覆盖：ready 空覆盖 / 覆盖值 / cleared(null) /
`pinnedCapability:null`(unsupported → `configurable:false`) / 跨租户 404 / 跨属主 404 / 无 token 401（见 §8 结果）。

---

## 12. Embed GET vs Control GET 同构性确认 + 交付说明

### 同构性确认
`GET /api/embed/v1/conversations/:id/reasoning` 与 `GET /api/control/v1/conversations/:id/reasoning`
（dbe175e + 本次实现）完全同构：

| 维度 | Control GET | Embed GET | 一致 |
| --- | --- | --- | --- |
| 成功响应 | `{ data: ConversationReasoningState, requestId }`（200） | 同 | ✓ |
| 状态字段 | `conversationId/effort/updatedAt/configurable/pinnedCapability` | 同（同一接口构造） | ✓ |
| null 覆盖语义 | `state?.effort ?? null` | 同 | ✓ |
| 越权/不存在 | 404 `CONVERSATION_NOT_FOUND`（getByTenant scope） | 404 同（owner scope） | ✓ 均不泄露归属 |
| 错误信封 | `{ error:{ code, message, requestId, retryable } }` | 同 | ✓ |
| 鉴权 | Admin Bearer Token（401 统一） | Embed Access Token（401 统一） | 不同主体，语义一致 |

唯一差异是授权主体来源（admin token vs embed owner token）与 scope 解析（tenant vs tenant+app+principal），
不影响 wire 结构。实现对照：`embed/conversations/service.ts getConversationReasoning` 与
`control/service.ts getConversationReasoning` 的 DTO 构造逐行一致。

### 交付清单（本分支新增，未 commit）
- 源码：
  - `runtimes/pi/packages/server/src/embed/conversations/service.ts`（+`getConversationReasoning`；+import `reasoningCapabilitiesForVersion`/`toPublicId`/`ConversationPublicId`）
  - `runtimes/pi/packages/server/src/embed/conversations/http.ts`（GET reasoning 路由 + `getReasoningRoute`；端点注释）
- 测试：`runtimes/pi/packages/server/test/embed/reasoning.test.ts`（16 用例；新增 GET：跨租户404 / 跨属主404 / ready空覆盖 / 覆盖值 / cleared(null) / null-capability→configurable:false / 401）
- 文档：`docs/development/agent-platform-v2/reasoning-contract-and-integration.md`（§3.2/§8/§10-Q4 撤销标注/§11-Q5 已实现 + 本§12）

### 类型检查（受影响的 `packages/server`）
命令：`npx tsgo -p tsconfig.test.json`（workdir `runtimes/pi/packages/server`）
结果：55 行报错，**全部为既有问题**——`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 未构建
（无 `dist/.d.ts`）导致的无法解析级联，以及既有 `src/protocol.ts` 报错；本次改动的 3 个文件 **0 报错**。
（完整通过需先 `npm run build` 缺依赖包；按仓库规则未擅自触发。）

### 测试命令与结果（全部通过）
```bash
# protocol 契约（纯，无需 DB）
cd runtimes/pi/packages/protocol
node ../../node_modules/vitest/dist/cli.js --run test/admin-workbench-reasoning.test.ts   # 1 文件 / 4 通过

# server reasoning 全套（需 Postgres 5433）
cd runtimes/pi/packages/server
node ../../node_modules/vitest/dist/cli.js --run \
  test/publishing/control-reasoning.test.ts \
  test/embed/reasoning.test.ts \
  test/publishing/conversation-reasoning-repository.test.ts \
  test/runtime/pi-runtime-adapter.test.ts \
  test/publishing/control-service.test.ts \
  test/model-parameters.test.ts                                                     # 6 文件 / 74 通过
```
合计 reasoning 相关：**7 测试文件 / 78 用例全部通过**。

### 建议 commit message
```
feat(server): add embed GET conversation reasoning state

Mirror the control GET for the embed owner surface so a fresh reload can
restore the conversation override ("刷新/重连可恢复"). Owner-scoped reads
return a uniform 404 CONVERSATION_NOT_FOUND on cross-tenant/owner access;
returns ConversationReasoningState (effort/updatedAt/configurable/pinnedCapability).
Adds route + service read + tests (cross-tenant/owner 404, ready empty, override
value, cleared null, null-capability -> configurable:false, 401).
```

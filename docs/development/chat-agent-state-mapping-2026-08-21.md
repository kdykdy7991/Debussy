# Chat 与 Agent 形象状态映射

状态：V1 已冻结

负责人：未指定

创建日期：2026-08-21

冻结日期：2026-08-21

## 1. 背景与目标

Chat 同时存在认证、连接、会话、回复、工具、上传和语音状态，而 Agent 形象引擎提供独立的视觉状态集合。当前实现已覆盖会话、回复、工具、焦点、空闲、部分 Reaction 和失败阶段，但尚未完整覆盖 Chat 全生命周期。

本功能要建立一个统一的形象状态协调规则，使同一个业务事件在管理员 Chat 和后续 Embed Chat 中得到稳定、可解释的视觉反馈。

相关官方规则：[交互规范](../product/INTERACTION.md)。

### 1.1 V1 冻结说明

- 3.3 节“当前已实现映射”是 Agent 形象设计 V1 的最终映射基线；
- V1 冻结范围包括管理员 Chat 的形象入口、当前业务状态映射、瞬时状态时长、空闲随机轮换、增强鼠标跟随、`dragging` 右视眼睛序列和资源失败降级；
- 前端保留 `SHOW_AGENT_STATE_DEBUG` 开关，默认关闭，后续排障时可临时开启；
- V1 冻结后不再进行主观动画微调或映射试验；只处理影响正确性、稳定性、可访问性或安全性的缺陷；
- 认证、连接、发送、上传、特殊会话阶段、取消、语音、Embed Chat 共享映射和统一状态协调器不纳入 V1，延期到 V2 再设计与实施。

## 2. 范围

### 包含

- 盘点形象引擎可用状态；
- 盘点 Chat 当前真实可观测状态；
- 设计业务状态到形象状态的映射；
- 定义优先级、持续时间、中断和回退规则；
- 定义减少动画和资源加载失败时的降级行为；
- 实现统一状态协调器并接入管理员 Chat；
- 为稳定映射建立自动化测试；
- 增强形象的鼠标视线跟随，并为 `dragging` 定制右视眼睛序列。

### 不包含

- 除当前已实现的鼠标跟随增强和 `dragging` 眼睛序列外，新增其他形象引擎动画；
- 根据自然语言回答推测 Agent 情绪；
- 修改 Agent、工具或语音服务端协议，除非后续确认缺少必要事件；
- 将尚未验证的映射直接写入官方交互规范。

## 3. 当前行为

### 3.1 形象引擎可用状态

核心生命周期：

`sleeping`、`waking`、`idle`、`listening`、`thinking`、`searching`、`working`

Reactions：

`excited`、`surprised`、`suspicious`、`angry`、`drowsy`、`happy`、`curious`、`confused`、`bored`、`proud`、`shy`、`sad`、`laughing`、`scared`、`playful`、`celebrate`

Agent Morphs：

`orbit`、`radar`、`progress`

Product Lifecycle：

`spawning`、`humming`、`loading`、`dictating`、`writing`、`sending`、`receiving`、`uploading`、`notifying`、`alerting`、`dragging`、`bouncing`、`powering-down`

### 3.2 Chat 可观测状态源

| 状态源 | 当前状态 |
| --- | --- |
| 管理员认证 | `locked`、`connecting`、`connected`、`error` |
| WebSocket | `disconnected`、`connecting`、`connected`，以及独立错误信息 |
| 会话 UI | 无活动会话、`loading`、已就绪、`submitting`、错误、空会话 |
| 会话阶段 | `idle`、`turn`、`compaction`、`branch_summary`、`retry` |
| Assistant | `streaming`、`complete`、`error`、`aborted` |
| Tool | `running`、`complete`、`error` |
| 本地上传 | `uploading`、`failed` |
| 附件处理 | `uploading`、`scanning`、`parsing`、`indexing`、`ready`、`restricted`、`failed`、`removed` |
| 实时语音 | `idle`、`waiting_for_text`、`generating`、`streaming`、`draining`、`ended`、`stopped`、`error` |
| 手动朗读 | `idle`、`requesting`、`buffering`、`playing`、`draining`、`ended`、`stopped`、`error` |
| 输入交互 | 未聚焦、已聚焦、空输入、正在输入、可发送、禁用、提交、失败恢复 |

### 3.3 当前已实现映射（V1 冻结基线）

| Chat 条件 | 当前 UI 状态 | 形象引擎状态 |
| --- | --- | --- |
| 创建或切换到另一条会话 | `waking` | `waking`，播放 800ms 后回到当前业务状态 |
| 会话空闲且输入框无焦点 | `idle` | 每 4–8 秒在 `sleeping`、`idle`、`suspicious`、`drowsy`、`curious`、`confused`、`bored`、`shy`、`sad`、`laughing`、`scared` 中随机切换，不连续重复 |
| 输入框获得焦点且会话空闲 | `waiting` | `dragging`；失焦后进入随机 `idle` 形象状态，发送后由任务状态接管 |
| 用户发送明确、无否定的积极夸奖 | `playful` | `playful`，播放 1600ms；原始消息仍完整发送，不调用额外 LLM |
| 用户消息已发送、尚未收到首个 Agent 响应事件 | `loading` | `loading`；持续到首个 thinking、文本或工具事件到达 |
| 出现思考内容 | `thinking` | `notifying` |
| 搜索类工具运行 | `searching` | `loading` |
| 其他工具运行 | `working` | `loading` |
| 工具已运行且正文未开始 | `reading` | `loading` |
| 正在生成正文 | `writing` | `writing` |
| LLM 输出已完整展示 | `completed` | `spawning`，播放 1000ms 后根据输入框焦点进入 `waiting → dragging` 或随机 `idle` 形象状态 |
| Agent 运行失败 | `failed` | 保留上一个活动形象状态约 1200ms，然后退化为失败红点 |

当前映射尚未覆盖认证、连接、发送、上传、特殊会话阶段、取消和语音状态。

## 4. 目标行为

### 4.1 已确认映射

已确认并实现的映射以 3.3 节为唯一当前表。本节不再维护第二份重复映射，避免与实现状态偏离。

“持续显示”的边界是 Chat 工作区已经完成管理员认证并挂载；认证连接中或认证失败时，仍由独立的工作台连接状态页面负责反馈。

### 4.2 设计约束

最终方案必须满足：

- 任意时刻只有一个形象状态生效；
- 每个状态能追溯到明确的 Chat 状态源；
- 高频状态切换不会造成闪烁；
- 瞬时状态结束后回到仍然有效的业务状态；
- 错误和关键进度同时具有文字反馈；
- 不通过回答文本猜测 Reaction 状态；
- UI `idle` 是常态和所有活动结束后的默认回退业务状态；形象引擎在随机空闲状态间轮换，不得用“隐藏形象”表达空闲。

## 5. 技术方案

当前实现由两层组成：

- `ActiveAgentPresence` 根据会话 phase、当前 turn、Assistant status、工具状态、输入框焦点和本地 Reaction 解析 UI 业务状态；
- `AgentStatusAvatar` 将 UI 业务状态映射为形象引擎状态，管理脚本预热、形象实例、瞬时计时器、空闲随机轮换和资源失败降级；
- 增强鼠标跟随通过 `followPointerBody` 和 `followPointerStrength` 参数选择性开启；`dragging` 眼睛播放列表已改为右视姿态 `[15, 0]`；
- 前端保留 `SHOW_AGENT_STATE_DEBUG` 调试开关；默认关闭，开启后在形象旁显示 `UI: <state>`，用于对照业务状态和形象动画。

当前解析逻辑仍位于 React 组件内；在扩展认证、连接、上传和语音映射前，应抽取为可单元测试的统一状态协调层。

## 6. 状态与异常

已实现：

- `waking` 持续 800ms；`playful` 持续 1600ms；`completed → spawning` 持续 1000ms；`failed` 保留上一活动形象约 1200ms；
- UI `idle` 期间每 4–8 秒随机切换形象状态，且不连续重复；
- 新的业务状态到达时会停止空闲轮换并立即接管形象；
- 形象脚本加载失败时保留占位形象和文字状态，不阻塞 Chat；
- `prefers-reduced-motion` 会关闭增强的身体鼠标跟随，形象引擎继续负责其他减动画降级。

延期到 V2：

- 全局状态优先级；
- 新高优先级状态的中断规则；
- 断线、重连和页面可见性变化；
- 认证、上传、取消和语音状态的中断与回退规则。

## 7. 兼容与安全

- 不改变现有认证与租户隔离边界；
- 形象状态不得暴露内部错误、工具输入、凭据或用户敏感信息；
- 形象加载失败不能阻塞 Chat；
- 状态协调器不得改变会话、工具、上传或语音业务行为。

## 8. 实施拆分

已完成：

- 管理员 Chat 固定形象入口和形象资源预热；
- 会话生命周期、回复阶段、工具阶段、焦点、积极反应和失败的基础映射；
- 完成态误判修复、空闲随机轮换、增强鼠标跟随和 `dragging` 右视眼睛序列。

延期到 V2：

- 抽取统一、可测试的状态协调器；
- 补齐认证、连接、发送、上传、特殊会话阶段、取消和语音映射；
- 为随机轮换、计时器、优先级和回退行为建立专项自动化测试；

## 9. 验收标准

V1 冻结标准：

- 3.3 节映射均能追溯到明确的当前 Chat 状态源；
- 发送后按 `loading → thinking / working / writing → completed` 的实际事件顺序切换，不再将请求确认阶段误判为完成；
- 瞬时状态按已确认时长回退，空闲状态按 4–8 秒随机轮换；
- 减少动画模式和形象资源失败时 Chat 仍可正常使用；
- `SHOW_AGENT_STATE_DEBUG` 默认关闭，不在正常 UI 中显示调试文字。

V2 完整方案将另行定义全局优先级、剩余业务状态映射和完整自动化验收标准。

## 10. 验证方式

已执行：

- Web TypeScript 检查；
- 受影响的既有 App 测试；
- 形象脚本语法检查；
- 通过临时 `UI: <state>` 标签人工对照业务状态。

延期到 V2：

- 状态解析纯函数单元测试；
- React 生命周期、随机轮换与计时器测试；
- 管理员 Chat 完整人工流程验证；
- 消除现有无关 lint 警告后执行仓库完整检查。

## 11. 未决问题

以下问题不阻塞 V1 冻结，统一进入 V2 规划：

- 认证、连接、发送、上传、特殊会话阶段、取消和语音状态的最终映射；
- 全局优先级顺序；
- 除 `playful` 和空闲随机状态外，其他 Reaction 状态是否进入正式 Chat；
- 是否需要服务端增加明确的 reaction 或工具类别事件；
- 管理员 Chat 与 Embed Chat 是否共享完全相同的映射。

# INTERACTION SYSTEM

来源：`design-reference2.html` 的 JS 行为（class 状态机、定时编排、menu toggle、textarea 自适应）与结构语义。
本文件规范"行为"，不重复视觉细节（见 COMPONENT_PATTERNS.md）。

---

## 1. Streaming

- **流是内容，motion 是包装**：文本由 stream 实时追加；motion 只负责"block 完成"的出现（`motion-streaming-reveal`）。
- 流式中（全部同时成立）：
  - Signature：running dot + 运行态 meta（思考耗时）
  - 最后内容 block 挂 streaming 光标
  - 对应 trace event 处于 running；最后一个 event 保持 running 直到正文结束
  - Actions 行隐藏
- 完成时（顺序）：
  1. 光标移除
  2. 末个 trace event → completed
  3. Signature → completed（状态短语 + 最终 "步数 · 耗时"）
  4. Actions 行渐入（`motion-actions-enter`，+300ms）
- 失败时：光标移除；event → failed（detail 显示原因）；signature 显示失败态；已完成 block 保持正常显示，不整块回滚。

---

## 2. Progressive Disclosure

原则：复杂信息默认不全部展开；披露入口是**文字链接**（弱色 + "→"），不是按钮。

| 信息 | 默认态 | 展开入口 | 展开形态 |
|---|---|---|---|
| Agent 完整轨迹 | rail ≤5 summary events | "查看 N 次调用的完整轨迹 →"（rail 底部） | Panel（同组件，不限事件数，含原始 payload mono 块） |
| Tool payload | detail 行仅 1 行聚合结果 | full trace 内 | mono 块 |
| Sources 明细 | 列表常显（title + meta + type） | Cite 芯片锚定；hover 提亮 | 无（列表即完整） |
| Artifact 内容 | TOC（章节 + 摘要） | Actions 中"阅读视图打开" / 导出 | 独立阅读视图 |
| Attachment menu | 隐藏 | `[+]` toggle | box 上方 chip 行 |

- 披露链接文本必须带总量信息（"5 次调用"）——用户要知道会看到什么。
- 展开内容不推动页面既有布局：panel 覆盖或独立视图，不内联挤开正文。

---

## 3. Agent Lifecycle

状态机：`pending → running → completed | failed`

- **一个 event = 一个 DOM node，全程不变**。状态切换只换 class / state：node、连线、title 不重排；detail 内容可原地更新。
- 事件按出现顺序排列，出现后不再移动、不重排。
- **Tool result 不创建新 node**——在原 node 上更新结果指标（行数 / 耗时进入 detail）。
- 参考实现（同一元素上切换 `.live` / `.done` class）是标准实现，直接照此模式。
- 失败分支：event 停在 failed，detail 一行原因；不产生"错误事件"追加。

---

## 4. Semantic Event Aggregation

多个底层 protocol event → 一个用户级 action。

```
tool_call(name=warehouse.query)
tool_arguments_delta(...)
tool_started
tool_result(rows=214, duration=840ms)
        ↓ 聚合（UI 层）
AgentTraceEvent:
  title:  查询数据仓库
  detail: warehouse.query · 214 rows · 840ms
```

规则：

- title = 动词 + 对象，禁止协议术语（tool_call / delta / stream / chunk）。
- detail ≤ 1 行，格式 `技术名 · 指标 · 耗时`；技术名可 mono 弱化显示。
- 同一语义动作的子事件（重试、并行分支）聚合为一个 event；仅失败分支产生 failed node。
- 聚合发生在 UI 层；原始 protocol events 保留在 full trace 中供审计。
- 指标选择：行数 / 条数 / 耗时，最多 2 个，不堆砌。

---

## 5. Trace Collapse / Expand

- Rail 默认视图：title + ≤5 events + 披露链接。
- Full trace：AgentTrace 组件不限事件数；含每步的原始 payload（mono 块，默认折叠，点击展开）。
- **<1100px（rail 隐藏）**：披露链接移至 Actions 行下方、正文内联；Signature completed meta（"8 步 · 2m 14s"）是兜底摘要。
- 展开 full trace 不改变 rail 宽度：panel 覆盖层或独立视图，默认 panel。
- 完成态的 trace 可整体折叠为一行摘要（"运行轨迹 · 8 步 · 2m 14s"）——由 disclosure 链接承担，不另设组件。

---

## 6. Citation

- 正文 Cite 芯片（编号）↔ Sources item（编号）一一映射。
- 点击 Cite：滚动到 / 高亮对应 source item（hover 样式，200ms）。
- 被 cite 而未列入 Sources = 违规；列入 Sources 而未被 cite 允许（"相关上下文"）。
- Sources 列表默认完整可见，不是披露对象（见 §2）。

---

## 7. Actions（afoot）

- 位置：answer 末尾、artifact 之外；margin-top 24px；gap 8px。
- 数量 ≤ 4；纯文字按钮（11px，6×13px，radius 8px，ghost：hover 显 border + 背景）。
- 至多 1 个 **key action**：accent 级 + 箭头，语义是"建议的下一步"（如"追问：华东客群漏斗 →"）。
- 可见性：生成中隐藏，完成/失败后才渐入（`motion-actions-enter`）。
- 破坏性操作（发送、删除）不直接放 actions 行——进确认层。
- Plain 形态无 actions 行。

---

## 8. Composer 交互

- 键盘：`⏎` 发送 / `⇧⏎` 换行 / `/` 唤起工具与知识源（hint 行明示）。
- Textarea：1 行起步（min-height 26px），随内容自适应至 150px，之后滚动。
- Modes：多选 toggle（知识库 / 联网 / 深思考可任意组合）；Model：单选下拉。
- `[+]`：toggle AttachmentMenu；menu item 触发对应流程（上传 / 引用知识库文档 / 选择 Agent 技能 / 联网搜索 / 引用日程数据）。
- 生成中：Send → **Stop**（中断当前 stream；参考未展示，必需状态）。Stop 被点击后：流式光标移除、running event → completed（附中断标记）或 failed（视语义）、actions 照常渐入。
- 提交后：用户消息以 UserMessage 形态插入流中，composer 清空回到 1 行。

---

## 9. TopBar / History

- History tabs 切换会话；当前项背景强调；末位 "+" 新建会话。
- Tab 文案 = 会话标题，单行截断。
- 切换会话 = 整页内容替换（无过渡动画要求；参考无定义，保持即时）。

---

## 10. Responsive Behavior

- **<1100px**：
  - Turn 退化 single column；rail 隐藏，disclosure 内联至 Actions 下方（见 §5）。
  - 用户 bubble 62% max-width 保留。
  - Composer 820px → 容器宽（100% − 64px）。
  - History tabs overflow-x 滚动。
- Touch：hover 专属效果（source translateX 等）需 tap 高亮回退；disclosure / Cite 的点击热区 ≥ 44px。

---

## 11. Agent UI Patterns（总结）

1. **答案与执行分离**：final answer 在 canvas，execution 在 rail（250px）；两者永不共享容器。
2. **Signature 承载执行状态**：running meta（思考耗时）→ completed 摘要（步数/耗时）；rail 承载执行明细。
3. **复杂任务交付 artifact**：产出交付物时，answer = signature + artifact + actions，不再堆正文。
4. **执行语义化**：protocol events 聚合为用户可理解动作；不暴露 chain-of-thought。
5. **视觉权重排序**：answer > artifact > 数据容器 > sources > trace。trace 字号（12px）小于正文（16px），居右列，全页最弱。
6. **生命周期原地更新**：同一 event node 走完 pending → running → completed/failed，不创建、不重排。
7. **披露而非堆叠**：full trace、tool payload、artifact 内容都走 progressive disclosure。

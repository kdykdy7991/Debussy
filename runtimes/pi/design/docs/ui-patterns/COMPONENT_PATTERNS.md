# COMPONENT PATTERNS

来源：`design-reference2.html`。颜色一律走主题 token（`--border-soft` / `--border-strong` / `--accent` / `--success` / `--danger` / `--muted-*` 等语义色），本文件不定义颜色值。
字号引用 `LAYOUT.md` 的语义 typography token；间距引用 spacing scale。

---

## 0. Container 通用规则

适用于 DataTable / ChartContainer / Sources item / ReportArtifact：

- 1px border（主题 border token）+ 圆角分档：item 级 10px，数据卡 12px，大块（artifact / composer）16px。
- **Caption 语法**（表/图共用）：label 级 10.5px、uppercase、字距 .18em；双槽位——左 = 名称/标题，右 = 来源/单位（更弱一档）。caption 是容器与正文之间的契约：没有 caption 的容器不允许存在。
- 容器位于 prose 流内，下 margin 用 em（1.6–1.7em），不贴边（full-width artifact 除外）。
- 容器内部背景可提升一档（card 级背景），但不允许投影堆叠超过一层。

---

## 1. UserMessage

```
UserMessage（wrapper：flex，justify-end，margin-top 56px）
└── Bubble（max-width 62%；padding 14×20 → 16×24；radius 14px，右下角 4px）
    ├── AttachmentChip?   "📎 fileA · fileB"
    └── Text              14.5px / 1.65（body-small 级）
```

**AttachmentChip**：inline-flex，gap 7px，11px，padding 3×10px，radius 6px，margin-bottom 8px。多文件放同一 chip，文件名用 "·" 分隔。chip 在文本之前。

**Variants**：

| Variant | 触发 | 差异 |
|---|---|---|
| `default` | 正常提问 | 有背景 + 1px border |
| `plain` | 问候 / 短句 | 透明背景、弱色文字、14px |
| `with-attachment` | 带文件 | `default` + AttachmentChip |

Do / Don't：

- Do：单 bubble；chip 在文本前；多文件合并进一个 chip。
- Don't：左对齐；bubble 内放第二个容器；给用户消息加 action 栏（参考无此设计）。

---

## 2. AssistantResponse

Assistant 内容是 **reading canvas**，不是 bubble：整体无背景、无边框。

```
AssistantResponse
├── AssistantSignature                 首行，永远第一
├── Content（按形态选一）：
│   ├── Plain:     单段文本（16px/1.8）
│   ├── Analysis:  Lede → Prose（p / 编号 h3 小节）→ DataTable? → Chart? → Sources
│   └── Artifact:  单个 ReportArtifact
└── Actions（afoot）                    永远最后
```

**内容构件**：

- **Lede**：display 级 29px/1.35，一句话，下 margin 0.75em。每篇 answer 至多 1 处，必须为首块。
- **Prose**：16px/1.9；段落下 margin 1.3em。
- **Section（h3）**：display 级 23px；上 2em 下 0.7em；多小节 answer 带编号芯片（10px、宽字距、accent 级，01/02/03… 顺序递增）。
- **Inline**：
  - `strong`：提亮 + 1px 下划线 accent。仅用于关键结论，不滥用。
  - `code`：mono 0.82em，chip 化背景，padding 2×7px，radius 5px。
  - **Cite**：17×17px 芯片，radius 5px，10px 字号，内联于文字流（vertical-align -3px），编号与 Sources 一一对应，可点击（见 INTERACTION.md §6）。

**组合规则**：

- 顺序固定：Signature 首、Actions 尾；Sources 是 Actions 前最后一个内容块。
- 容器（表/图）与 prose 之间保留 em 间距，不直接相贴。
- Lede 之后必须接 prose 段落，不直接接容器。
- Plain 形态无 Actions、无 Sources。

Do / Don't：

- Do：canvas 自身无边框；结构化数据用容器；容器与 prose 保持节奏。
- Don't：整段回答套 card；一篇 answer 多个 Lede；多小节 answer 用无编号 h3；在 canvas 上放背景色。

---

## 3. AssistantSignature

```
Signature（margin-bottom 24px；gap 12px）
├── StatusDot?   8px 圆点（仅 Analysis / Artifact 形态）
├── Identity     label 级 10.5px，uppercase，字距 .24em
└── Meta         11px，最弱档：模型 · 执行事实
```

**States**：

| State | Dot | Identity | Meta 内容 |
|---|---|---|---|
| `plain` | 无 | 无（整行并入 meta） | "Nocturne · GLM-5"（名称与模型合并） |
| `running` | active（静态 glow，不 pulse） | 助手名 | 运行态，如 "GLM-5 · 深度思考 4.2s" |
| `completed` | 状态色（success 级） | 状态短语，如 "Agent 运行完成" | 最终事实，如 "8 步 · 2m 14s" |

规则：

- Meta 至多两个事实（模型 + 时间/步数），用 "·" 分隔。
- completed 态的 Identity 位从"身份"切换为"执行摘要"——这是 signature 承载执行状态的机制（见 INTERACTION.md §11）。
- Dot 是静态状态标记；pulse 只属于 trace node（见 MOTION.md）。

Do / Don't：

- Do：每个 response 必有 signature，且为首行。
- Don't：signature 里超过 2 个执行数字；把 signature 放进容器；让 dot 做 pulse 动画。

---

## 4. AgentTrace

表示 **agent execution**，不是 chain-of-thought。独立组件：

```tsx
<AgentTrace>
  {/* rail-title：生成中 "Agent 活动" / 完成后 "运行轨迹" */}
  <AgentTraceEvent state="pending|running|completed|failed" />
  {/* ≤5 个 summary event */}
  <AgentTraceDisclosure />   {/* "查看 5 次调用的完整轨迹 →" */}
</AgentTrace>
```

**几何**：

- 列宽 250px；事件区左缩进 26px（结构几何量，保留）。
- 垂直连接线 1px，贯穿 node 中心，底端渐隐至 transparent（top 8px / bottom 12px）。
- Node：9px 圆，1.5px border，位于线上。
- Event 间距 16px（参考 18px）；detail 距 title 2px。
- Rail title：label 级 10px、字距 .26em、下 margin 20px。

**AgentTraceEvent 结构**：

```
AgentTraceEvent
├── Node（9px，状态色）
├── Title   12px / 1.5　语法：动词 + 对象（"解析附件" / "MCP 调用完成"）
└── Detail  10.5px　    至多 1 行技术信息（工具 id · 行数 · 耗时），可含链接（虚线下划线）
```

**States**（同一 node 原地更新，见 INTERACTION.md §3）：

| State | Node | 文字 |
|---|---|---|
| `pending` | 空心 border | 全弱 |
| `running` | 实心 + `motion-status-running`（视口内唯一 pulse） | 提亮（accent 级） |
| `completed` | success 色 + 25% 填充 | 恢复常规；detail 可含结果符号（✓） |
| `failed` | danger 色 | detail 显示失败原因（1 行）——参考未展示，按状态色体系补全 |

**内容语法**：

- Title = 用户可理解的语义动作，禁止协议术语（tool_call / delta / stream）。
- Detail = `技术名 · 指标 · 耗时`，至多 1 行；技术名用 mono + 弱色。
- 聚合规则见 INTERACTION.md §4。

**披露**：

- 默认展示 ≤5 个 summary event + 披露链接（链接文本带总数："查看 5 次调用的完整轨迹 →"）。
- 完整轨迹 = 同组件不限事件数，含原始 payload（mono 块）。以 panel 呈现，不内联堆叠在 rail。

Do / Don't：

- Do：event 逐个 `motion-enter-soft` 浮现；最后一个 event 保持 running 直到正文流结束。
- Don't：展示 chain-of-thought（推理文本、内部 deliberation）；tool result 新建 node（必须更新原 node）；summary 超过 5 个 event。

---

## 5. DataTable

```
DataTable（1px border，radius 12px，card 级背景，margin-bottom 1.6em）
├── Caption（padding 12×18；10.5px uppercase；左=表名，右=数据源）
└── table（width 100%）
    ├── thead：10px uppercase、字距 .14em；左对齐（数字列右对齐）；padding 12×18
    └── tbody：13.5px；行分隔 1px 下 border；末行无 border；无竖线
```

- **数字列**：mono 12px，右对齐（`td.n` 语义类）。
- **状态值**（up/down/flat）：语义 class + 主题语义色，禁止硬编码颜色。
- **密度**：行内 padding 12×18，无 zebra，无外层单元格边框。

Do / Don't：

- Do：每张表必有 caption（含数据源）；数字右对齐 mono。
- Don't：左对齐数字；zebra 条纹；竖线；无 caption 的表。

---

## 6. ChartContainer

只规范容器，不规定图表配色：

```
ChartContainer（1px border，radius 12px，padding 16×24×12，margin-bottom 1.7em）
├── Caption（左=图名，右=单位/来源；margin-bottom 16px）
├── Plot region（固定高 130px）
└── X labels（10px，居中于数据点下方，margin-top 8px，字距 .1em）
```

- 柱类图表：等宽列（flex），gap 16px（参考 14px）；数值标签在柱上方（10px mono，距柱顶约 19px 预留区）。
- **强调数据点**：用主题 accent + glow 区分（参考 `.fill.hot`），不另设配色。
- Plot 高度固定；数值标签在 plot 区域内但不压缩柱高计算。

Do / Don't：

- Do：caption 含单位（"百万元"）；图表首次渲染用 `motion-data-enter`。
- Don't：图孤立出现——前后必须有 prose 上下文；用 legend 替代 caption（caption + 标签足够）；把 caption 放进 plot 区。

---

## 7. Sources

```
Sources（margin-top 2em；list gap 12px）
├── Label   "来源 · 3"（label 级 10.5px，字距 .22em）
└── SourceItem*（grid：22px 1fr auto；gap 16px；padding 12×16；radius 10px）
    ├── Index   11px，与正文 Cite 编号一一对应
    ├── Title   13px + Meta（11px，margin-top 2px：组织 · 日期 · 页数 · 命中数，"·" 分隔）
    └── TypeBadge（9.5px uppercase，pill，1px border；区分 知识库/共享盘/外部）
```

- 边框：1px border + **2px 左 accent 线**（结构性强调线，主题色——"accent line" 模式，同族用法：key action 的高亮）。
- Hover：border 提亮、左线提亮、背景升一档、translateX(3px)，200ms。

Do / Don't：

- Do：索引号与正文 Cite 严格一致；type badge 必选。
- Don't：单 item 超过 2 行文字；无 type badge；索引与 Cite 不对应。

---

## 8. ReportArtifact（通用 Artifact 模式）

交付物 = 有身份、有状态、自成一体的块。**Artifact body 是 TOC，不是内容**：内容进 reading view / 导出。

```
Artifact（1px border，radius 16px，card 级背景渐变，overflow hidden）
├── Header（padding 24×32；底 1px 分隔线；左列信息 + 右上 badge，gap 20px）
│   ├── Eyebrow   "管理纪要 · 草稿"（label 级 10px，accent 级，字距 .28em）
│   ├── Title     display 级 30px（margin-top 10px）
│   ├── Meta      11.5px："供管理层参阅 · 基于 4 篇来源与上轮分析 · 数字校验 14 / 14"
│   └── StatusBadge（右上，pill：10px、字距 .18em、1px border、padding 5×14px；如 "待审阅"）
├── Body（padding 8×32×24）
│   └── SectionRow*（grid：180px 1fr；gap 24px；padding 16×0；行分隔 1px；末行无）
│       ├── 编号 + 章名（11px；编号 10px accent 级，margin-right 8px）
│       └── 关键结果（14px）+ 摘要（12px，margin-top 3px，弱色）
└── （Actions 在 artifact 之外，属于 AssistantResponse）
```

**Variants**：

- `risk` 章节：章名用 danger 级（语义色），提示该章含预警内容。
- StatusBadge 是状态机：草稿 / 待审阅 / 已定稿…（主题色，不硬编码）。

**Meta 行语法**：受众 · 依据 · 校验事实，"·" 分隔；校验事实（14/14）是可信度信号，必带。

Do / Don't：

- Do：header 必含状态 badge；meta 含校验事实；Actions 放 artifact 外。
- Don't：artifact 内展开全文；Actions 放 artifact 内；对非交付物内容（普通分析）使用 artifact。

---

## 9. Composer

```
ComposerDock（fixed bottom；padding 0 32px 24px；向上渐变遮罩）
└── Dock（max-width 820px，居中）
    ├── AttachmentMenu?（展开态位于 box 上方；margin-bottom 10px；padding 10px；radius 12px）
    │   └── Chip*（11.5px，7×13px，radius 8px，1px border；gap 8px，wrap；如 上传/知识库/技能/联网/日程）
    ├── Box（radius 16px，1px border（strong 档），padding 16×18×10 → 16×16×8）
    │   ├── Textarea（15px/1.6；min-height 26px（1 行）；auto-grow 至 150px 后滚动）
    │   └── ToolRow（margin-top 8px）
    │       ├── [+]（32×32，radius 9px；hover 显 border + 背景）
    │       ├── ModeSegmented（容器：2px padding、radius 9px、1px border；item：11px、5×12px、radius 7px）
    │       ├── spacer
    │       ├── ModelSelector（11px，下拉；"GLM-5 ▾"）
    │       └── Send（高 32px，padding 0 18px，radius 9px，12px、字距 .08em——全页唯一 strong emphasis 按钮）
    └── Hint（居中 10.5px，字距 .1em："⏎ 发送 · ⇧⏎ 换行 · / 唤起工具与知识源"；快捷键 kbd 提亮）
```

**行为与状态**：

- Box `focus-within`：border 提亮 + 外阴影，200ms（焦点态由主题提供）。
- **Modes 多选**（参考中"知识库"与"深思考"同时开启）；**Model 单选**下拉。
- `[+]` 切换 AttachmentMenu（toggle）；menu item 触发对应流程（上传 / 引用知识库 / 技能 / 联网 / 日程）。
- 生成中 Send 切换为 **Stop**（中断当前流）——参考未展示，为必需状态。

Do / Don't：

- Do：Send 是全视口唯一高强调控制；hint 行居中于 box 下方；textarea 1 行起步自适应。
- Don't：页面其他位置出现 primary 级按钮（artifact/answer actions 一律 ghost/pill）；textarea 超 150px 继续生长；hint 放 box 内部或左侧。

---

## 10. TopBar / HistoryTabs

- 槽位见 LAYOUT.md §1。
- HistoryTabs：12px；当前项背景强调（accent-soft 档）；项 padding 6×12px、radius 8px；hover 显背景。
- Tab 文案 = 会话标题，单行截断；末位 "+" = 新会话。
- 分隔：history 区与 brand 之间 1px 竖线 + 20px 间距。

# LAYOUT System

来源：`design-reference2.html`。本文件是结构规范，不含任何颜色值；颜色一律由主题系统提供。
尺寸基于 4px 网格；参考中出现的非网格值（10/14/18/22/26/28）在实现时归一到最近的 scale 值，结构几何量（如 rail 缩进 26px）保留原值。

---

## 1. Page Skeleton

自上而下四层：

| 层 | 定位 | 关键尺寸 | 说明 |
|---|---|---|---|
| **TopBar** | sticky top | 高 58px；内容宽 1240px；padding 0 32px；槽间 gap 20px | 背景 blur + 1px 底部分隔线 |
| **ConversationHeader** | flow 顶部 | 居中；eyebrow→title 14px；title→sub 10px；sub→正文 64px | 全页唯一的居中对齐块 |
| **ConversationFlow** | 主体 | max-width 1240px；padding 48px 32px 220px | 底部 220px 为 Composer 安全区 |
| **ComposerDock** | fixed bottom | 内容宽 820px 居中；底部 padding 24px（参考 22px）；向上渐变遮罩 | 遮罩只用于与正文分离，不作装饰 |

TopBar 槽位（左→右）：

```
Brand（图形 22px + 名称，display 级 21px）
│ 分隔：1px 竖线 + 20px
HistoryTabs（12px；当前项背景强调；末位 "+" 新会话）
│ spacer
Avatar（30px 圆形）
```

ConversationHeader 三级结构（全部居中）：

```
Eyebrow     label 级，会话编号（如 "Session · 08 / 18"）
Title       display 级 44px/1.15
Sub         meta 级 12.5px；关键数字加粗提亮（"检索 3 篇 · 分析 48,221 行 · 9 次调用"）
```

Sub 的 meta 行语法：多个关键事实用 "·" 分隔，数字是信息重点（加粗），文字是说明（弱化）。

---

## 2. Conversation Flow

### 2.1 Turn 构成

```
Turn
├── UserMessage            右对齐
└── AssistantTurn          grid：[reading 列] [Agent rail 250px]
```

垂直节奏：

| 位置 | 距离 |
|---|---|
| Header → 第一个 UserMessage | 64px |
| 上一 Turn 结束 → UserMessage | 56px |
| UserMessage → AssistantTurn | 32px（参考 28px，归一） |
| Signature → 内容首块 | 24px（参考 22px） |

规则：

- Turn 是原子单位：一条用户消息后恰好跟一条 assistant 响应，不交错。
- 用户消息的 margin 只在上方（56px），assistant 侧不加底 margin——turn 间距由下一个 UserMessage 的上 margin 统一控制，避免间距叠加失控。

### 2.2 为什么用户消息右对齐且紧凑

- 右对齐标注"输入"身份，与左对齐的阅读内容形成轴对称：输入贴右缘，内容走左对齐主列。
- max-width = 内容宽的 62%（1240 容器下约 730px）。单 bubble、不拆行；bubble 右下角半径缩小为 4px（非对称 bubble），指向说话者。
- 用户消息用 body 低一档的字号（14.5px / 1.65）：输入是瞬时的、低信息密度的，不需要阅读节奏。

### 2.3 为什么 Assistant 内容不是 bubble

- Assistant 输出是阅读材料：有 lede、编号小节、表格、图表、来源列表。
- 放在 canvas 上（无背景、无边框）后，内容宽度由页面网格决定而非 bubble；字号可以走完整阅读节奏（16px / 1.9）。
- 边框只属于结构化数据（DataTable / Chart / Sources / Artifact）：**容器边界 = 数据边界**。正文自身永远没有边框。

### 2.4 Turn 的三种形态

| 形态 | 触发 | 结构 |
|---|---|---|
| **Plain** | 问候 / 一句话应答 | Signature（无 dot）+ 单段 plain 文本（16px/1.8）。无容器、无来源、无 Actions（参考中 plain turn 无 action 行） |
| **Analysis** | 检索 / 数据分析任务 | Signature（running dot）+ Lede + Prose（含编号 h3 小节）+ DataTable? + Chart? + Sources + Actions；右侧挂 Agent rail |
| **Artifact** | 产出了交付物 | Signature（completed 态）+ 单个 ReportArtifact + Actions。不再堆正文 |

规则：turn 形态由**交付物性质**决定，不由文本长度决定。长文本身不构成使用容器的理由；结构化数据才构成。

---

## 3. Content Width

| 槽位 | 宽度 | 说明 |
|---|---|---|
| 页面内容 | max-width **1240px**，padding 0 32px（≈1176px） | 唯一宽度上限，TopBar 与 flow 共用 |
| Reading 列 | 内容宽 − rail 250px − gap 40px（≈886px） | 正文 / 表格 / 图 / 来源 / artifact 的宿主列 |
| Agent rail | 固定 **250px** | 全页唯一固定宽列 |
| 用户 bubble | 内容宽的 **62%** | 右对齐 |
| Composer | **820px** 居中 | 比 reading 列窄，居中而非左对齐 |

### 何时用哪种布局

- **Single column**：无 agent 执行的 turn（plain 回复）；窄屏所有 turn。
- **Main + rail**：凡是存在 agent 执行（工具调用、检索、多步）的 turn。rail 恒为 250px，gap 恒为 40px（参考 40px）。
- **Full-width artifact**（扩展规则）：artifact 内容天然超宽（宽表、dashboard）时，artifact 横跨整个 1176px 内容宽，该 turn 的 rail 隐藏。参考中的 artifact 位于 reading 列内；full-width 只为宽数据服务，宽度逻辑不变。

---

## 4. Spacing System

基础单位 4px。结构几何量（rail 缩进 26px、node 偏移）不属于 spacing scale。

### Scale

```css
--space-2xs:  2px;  /* 微偏移：chip 内 gap、meta 行距、mode 容器内 gap */
--space-xs:   4px;  /* 微 padding */
--space-sm:   8px;  /* 行内 gap：actions 间距、x 轴标签间距、textarea→工具行 */
--space-md:   12px; /* 卡片内 padding 档：source item 12×16、caption 12×18 */
--space-lg:   16px; /* 卡片内 padding 档：chart 20×22 → 16/24、事件间距 */
--space-xl:   24px; /* 块级节奏：signature→内容、actions→内容上距 */
--space-2xl:  32px; /* 页面侧 padding、turn 间距档 */
--space-3xl:  40px; /* 主列与 rail 的 gap */
--space-4xl:  48px; /* 页面顶部 padding */
--space-5xl:  56px; /* turn → user message */
--space-6xl:  64px; /* header → 正文 */
--space-safe: 220px;/* Composer 安全区（页面底部 padding） */
```

### 参考值 → scale 归一

| 参考原始值 | 用途 | 归一 |
|---|---|---|
| 10–11px | caption padding、source list gap | 12 |
| 14px | source item 内 gap、bubble 竖 padding | 16 |
| 18px | trace 事件间距、单元格 padding | 16 |
| 22px | signature→内容、actions 上距、dock 底 padding | 24 |
| 26/28px | report 内 padding | 结构保留 / 32 |
| 28px | turn 上 margin | 32 |

### 节奏分层

- **Turn 节奏**（跨 turn）：64 / 56 / 32，px 值，来自 scale。
- **Block 节奏**（answer 内部，参考用 em 跟随字号）：
  - 段落间距 `1.3em`
  - 小节标题：上 `2em`、下 `0.7em`
  - 容器（表/图）下 margin `1.6–1.7em`
  - Sources 上 margin `2em`
  - Lede 下 margin `0.75em`
- **Internal 节奏**（组件内部）：px 值，12–24 档。

规则：正文内部节奏用 **em**（跟随字号缩放），结构间距用 **px token**。不混用。

### 关键间距速查

| 关系 | 值 |
|---|---|
| user message 与上一轮 | 56px |
| user message 与 agent response | 32px |
| heading 与正文 | 上 2em / 下 0.7em |
| 段落之间 | 1.3em |
| card 内部 padding | 12×16（行类）/ 16×24（面类）/ 26×28→24×32（artifact 头） |
| 表格行 padding | 12×16（th 同；参考 11×18 归一） |
| trace 事件间距 | 16px；detail 与 title 距 2px |
| composer 内部 | textarea→行 8px；行内 gap 8px；box padding 16×18×10→16×16×8 |
| 页面底部安全区 | 220px |

---

## 5. Responsive

断点：**1100px**（参考 `@media (max-width:1100px)`）。

| ≥1100px | <1100px |
|---|---|
| Turn = `1fr + 250px` grid | Turn = single column |
| Agent rail 可见 | rail 不显示——**trace 不得静默丢失**（见下） |
| Composer 820px | Composer 跟随容器宽（100% − 64px） |

窄屏 trace 替代方案（强制）：

1. rail 的披露链接（"查看 N 次调用的完整轨迹 →"）移到 **Actions 行下方**，作为正文内联入口——窄屏上它是 full trace 的唯一入口。
2. Signature 的 completed 态已携带执行摘要（"8 步 · 2m 14s"），关键执行事实在窄屏依然可见。
3. 参考实现直接 `display:none` 了 rail；这是不可接受的默认——执行信息必须可达，不是删除。

其他：

- 用户 bubble 62% max-width 保留。
- TopBar history tabs 窄屏横向滚动（overflow-x），保留 brand 与 "+"。
- hover 专属效果（source 位移等）在 touch 环境需 tap 高亮回退。

---

## 6. Typography Hierarchy

不绑定 font-family。参考使用两级字族结构：**display 级（衬线）** 用于标题/导语/小节标题，**sans 级**用于一切 UI 与正文，**mono** 用于代码与数字。实现时以语义 token 表达：

```css
--text-display:  44px / 1.15;  /* 会话标题（居中头） */
--text-title:    30px / 1.2;   /* Artifact 标题 */
--text-lede:     29px / 1.35;  /* 导语：每篇 answer 至多 1 处 */
--text-heading:  23px / 1.3;   /* 小节标题（编号 01/02…） */
--text-body:     16px / 1.9;   /* 正文；plain 回复 16/1.8 */
--text-body-small: 14.5px / 1.65; /* 用户消息；plain 变体 14px */
--text-table:    13.5px / 1.5; /* 表格单元格、source 标题 13px */
--text-label:    10.5px / 1;   /* eyebrow / signature / caption / 章节号；uppercase + 宽字距 .18em–.32em */
--text-meta:     11px / 1.5;   /* signature meta / source meta / trace detail 10.5px */
--text-code:     0.82em mono;  /* 行内代码、数字列 */
```

补充档位：

- 微标签 9.5–10px（source 类型徽章、trace 编号）：label 档的非 uppercase 变体。
- 字距规则：label 级一律宽字距 + uppercase（作为区块标记时）；meta 级正常大小写、近零字距；正文近零字距。

### 什么必须突出，什么必须弱化

| 视觉突出（亮 / 大 / accent） | 必须弱化（小 / 暗） |
|---|---|
| Lede、小节标题、Artifact 标题 | 全部 label/meta 级：eyebrow、sub、caption、th、signature、hint |
| 正文中的 `strong`（亮 + 1px 下划线 accent） | trace 标题（12px）与 detail（10.5px） |
| 小节编号、Cite 芯片、source 索引号 | source meta（作者·日期·命中数） |
| Key action（accent + 箭头） | 模型选择器、未选中的 mode |
| 语义状态值（up/down/risk，经主题语义色） | 工具技术名（mono + 弱化色） |

规则：一个视觉层级内只有一个最亮元素。Metadata 永远小于且暗于其描述的内容——metadata 是"出处"，不是"内容"。

### Alignment

- 默认左对齐。
- 居中对齐仅三处：ConversationHeader、Composer hint、图表 x 轴标签。
- 右对齐仅两处：用户消息、表格数字列。
- 数字与代码值：mono + 右对齐（表格内）/ 内联（正文内）。

---

## 7. Visual Grammar（为什么这样排）

| 问题 | 答案 |
|---|---|
| 为什么用户消息紧凑？ | 输入是瞬时的、低信息密度 turn：14.5px/1.65 + bubble，扫一眼即完成。 |
| 为什么 Assistant 内容宽松？ | 它是阅读材料：16px/1.9 + em 段落节奏 + lede。行高与间距为持续阅读服务，不是 chat 节奏。 |
| 为什么 Assistant 不用 bubble？ | bubble 暗示"聊天"并约束宽度；answer 可以是文档（小节/表/来源），canvas + 页面网格更合适。 |
| 为什么 metadata 小而弱？ | 层级是 内容 > 结构 > 元数据。模型名/耗时/工具名若与正文同级，用户必须扫过信息噪音。 |
| 为什么正文 line-height 1.9？ | 长文阅读含 cite 芯片、code、strong，需要垂直呼吸；1.9 + 1.3em 段落距构成节奏。 |
| 为什么卡片只用于结构化信息？ | 容器边界 = 数据边界。给正文套 card 制造假"卡片"，打断阅读流。 |
| 为什么 Agent trace 视觉权重低于 final answer？ | 执行是手段，答案是目的。rail：更窄（250px）、更小字号（12px vs 16px）、更弱、位于右列。 |
| 为什么复杂任务用 artifact 不继续堆正文？ | 交付物有身份、状态、章节，需要自己的 header / badge / TOC；堆进正文丢失状态与入口。 |
| 为什么工具与数据来源用次级层级？ | 它们是"出处"不是"内容"：10–11px、弱化、置于 caption 或 detail 行、按需可达（full trace）。 |

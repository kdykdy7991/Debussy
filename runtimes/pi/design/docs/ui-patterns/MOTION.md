# MOTION System

来源：`design-reference2.html` 的 CSS transition/keyframes 与 JS 时序编排。
总原则：

1. **Motion = 状态通信**。每个动画必须对应一个状态变化（出现 / 运行 / 完成 / 数据到达 / 交互反馈）。无状态对应的动画一律禁止。
2. 只动画 `opacity` 与 `transform`，不碰布局属性。
3. 动画作用于**语义 block**，不是 token / 字符。
4. 同一元素的状态切换走同一动画路径（enter → 保持），不中途换动画。

---

## 1. Tokens

### Durations

```css
--motion-fast:     150ms;  /* hover、border/背景微反馈（参考：transition all .15s） */
--motion-base:     200ms;  /* source item hover、focus-within（参考 .2s） */
--motion-enter:    500ms;  /* enter-soft（参考 .5s） */
--motion-actions:  600ms;  /* actions 行渐入（参考 .6s） */
--motion-data:     1000ms; /* 图表生长、指标计数（参考 1s） */
--motion-pulse:    1600ms; /* running pulse 循环（参考 1.6s） */
--motion-blink:    1100ms; /* streaming 光标（参考 1.1s） */
```

### Easing

```css
--ease-standard: cubic-bezier(.2, .7, .2, 1); /* enter、data enter（参考图表 transition） */
--ease-loop:     ease-in-out;                 /* pulse 循环（参考 breathe） */
--ease-steps:    steps(2);                    /* blink（参考光标） */
```

归一说明：参考中 enter 类动画使用默认 `ease`（`transition: all .5s`）；实现统一为 `--ease-standard`，观感等价、曲率可控。

---

## 2. Primitives

### 2.1 motion-enter-soft

- From：`opacity: 0`，`translateX(6px)`（水平时间线元素，如 trace event）或 `translateY(6px)`（纵向内容，如 prose block / card）
- To：`opacity: 1`，`transform: none`；`--motion-enter`，`--ease-standard`
- 适用：AgentTraceEvent 浮现、DataTable / Chart / Artifact 首次出现、增量结果块
- 参考依据：`.evt { opacity:0; transform:translateX(6px); transition:all .5s }`；prose block 内联 `opacity 0 + translateY(6px) → 1/none`
- 方向约定：rail（水平语境）用 X 轴位移，正文（垂直语境）用 Y 轴位移。不混用。

### 2.2 motion-status-running

- 循环：`--motion-pulse`，`--ease-loop`；50% 处 node `scale(1.15)`，glow 半径 12px → 22px
- 适用（仅限）：当前 running 的 AgentTraceEvent node、活动 tool 指示、streaming 状态点
- **约束：视口内同时至多 1 个此类 pulse。** Signature dot 用静态 glow，不参与 pulse。
- 禁止：大面积 card、背景、整页呼吸。

### 2.3 motion-streaming-reveal

- 粒度：**语义 block**（一个 `<p>` / 一个 h3 小节 / 一个表 / 一个图 / 一组 sources），逐块
- 单块：`opacity 0 + translateY(6px) → 可见`，`--motion-enter`，`--ease-standard`
- 时序：参考用固定 640ms stagger；真实流式中改为**块流式完成即触发**——motion 只负责"出现"，stream 负责"何时"
- Streaming 光标：9×17px，`--motion-blink`（steps(2)），挂在最后一个 block，流结束即移除
- 禁止：token / 字符级动画；整块一次性弹入替代逐块 reveal

### 2.4 motion-data-enter

- 柱：`height 0 → value`，`--motion-data`，`--ease-standard`（参考 `.fill { transition: height 1s cubic-bezier(.2,.7,.2,1) }`）
- 指标计数：0 → 终值，`--motion-data`，ease-out 计数（扩展 primitive，用于 signature / report meta 的数字，如 "48,221 行"）
- 仅触发于图表/指标**首次渲染**；re-render 不重放
- 适用：bar growth、metric count、chart initialization
- 禁止：table 行用它（行用 enter-soft 或直接出现）；数值反复跳动

### 2.5 motion-actions-enter

- `opacity 0 → 1`，`--motion-actions`；无 transform
- 触发：answer 完成之后（参考：最后一个 block + 300ms）
- 目的：生成过程中 actions 不抢视觉注意力
- Plain（无流式）answer：actions 随内容直接出现

### 2.6 micro-interactions

| 交互 | 时长 | 内容 |
|---|---|---|
| hover | 150ms | 背景 / border / 文字色 |
| source item hover | 200ms | translateX(3px) + border/左线提亮 + 背景升档 |
| composer focus-within | 200ms | border 提亮 + 外阴影 |
| mode / tab 切换 | 150ms | 背景 / 颜色过渡 |

---

## 3. Orchestration（参考时序还原）

```
t = 0          turn 开始
t ≈ 200ms      首个 trace event 浮现（running）；后续事件随执行推进（参考 200/900/1800/2500/3200ms）
t ≈ 1400ms     首个内容块浮现；后续块随流式完成出现（stagger ≤ 640ms/块）
t ≈ 2400ms     图表柱生长（1s）
t ≈ 末事件     最后一个 trace event 保持 running（held），与正文流并行
t = 流结束     末事件 → completed；光标移除；signature → completed（步数/耗时落定）
t = +300ms     actions 行渐入（motion-actions-enter）
```

编排规则：

- Trace events 略领先正文、与正文同速推进；**最后一个 event 保持 running 直到正文结束**，不提前标完成。
- 单块内容出现时长 ≤ 500ms；块间 stagger ≤ 640ms。
- Answer 失败：pulse 立即停止，对应 event → failed（无额外动画），已完成块保持正常显示。

---

## 4. Reduced Motion

```css
@media (prefers-reduced-motion: reduce) { /* 必须实现 */ }
```

| Primitive | 退化 |
|---|---|
| enter-soft | 去掉位移，仅 opacity ≤200ms，或直接出现 |
| status-running | 静态实心 node（无 pulse、无 glow 循环） |
| streaming-reveal | 块直接出现（至多 opacity ≤200ms） |
| data-enter | 直接终值（柱高/计数不动画） |
| actions-enter | 直接出现 |
| blink | 光标隐藏或静态 |

- 状态变化必须仍可感知：通过颜色 / border / 形状，不依赖运动。
- 循环动画（pulse、blink）一律关闭。

---

## 5. Do / Don't

Do：

- 每个动画对应一个状态变化
- 只动 opacity / transform
- block 是最小动画粒度
- 视口内单一 running pulse
- actions 延迟到完成后再出现

Don't：

- 装饰性动画（无状态对应的循环/位移）
- token / 字符级动画
- 大面积呼吸背景
- re-render 重放 enter 动画
- 用 motion 掩盖布局跳变（内容高度变化时让布局自然流动，不补动画）
- 超过 1 个 running pulse 同时存在

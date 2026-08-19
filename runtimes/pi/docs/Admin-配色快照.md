# Admin Workbench — Aurora 配色快照

> 用途:在切换配色方案前,把当前生效的所有颜色 token 完整记录下来,便于
> 任意时刻通过「赋值回去」还原。配色源文件:`packages/web/src/admin/styles.css`
> 的 `:root` 块(也包含 `--admin-*` 老 token,本次快照以 `--aurora-*` 为准)。

**当前生效版本**:v10 背景以 `rgb(255,249,245)` 为主色的 135deg 小幅渐变 + Tab/选中态加 `rgb(255,140,66)` 边框 + 所有边框加粗到 1.5px + 暖珊瑚橘品牌渐变。
v9 淡橙三段渐变底色作为前一版(已并入 v10,但差异是 v9 三色 `#fff7f3/#fef0e8/#fff5ec` 比 v10 `#fff9f5/#fff5ed/#fff9f5` 更深,v10 收得更克制)。

## 1. 背景层

| Token | Hex | 用途 |
|-------|-----|------|
| `--aurora-bg` | `#fbfaf7` | 页面背景(暖白底,比 #fff 更克制) |
| `--aurora-surface` | `#ffffff` | 卡片 / 弹层 / 主按钮白底 |
| `--aurora-surface-soft` | `#f8f6f1` | 凹陷:tabs 容器 / field / insets |
| `--aurora-canvas` | `#ffffff` | canvas 主区(shell 内主区底) |
| `--aurora-overlay` | `rgba(251, 250, 247, 0.85)` | 顶部 sticky 玻璃态(已无 topbar,空闲) |

## 2. 文字层

| Token | Hex | 用途 |
|-------|-----|------|
| `--aurora-ink` | `#1f1b2e` | 主文字(接近黑,带紫调) |
| `--aurora-ink-2` | `#4b4b63` | 副文字 |
| `--aurora-ink-3` | `#8b8aa0` | 弱化文字、placeholder、表头 |
| `--aurora-inverse` | `#ffffff` | 反色文字(用于暖色背景按钮上) |

## 3. 边框层

| Token | Hex | 用途 |
|-------|-----|------|
| `--aurora-line` | `#ece9e0` | 默认细线 |
| `--aurora-line-soft` | `#f4f2ec` | 极浅分割(footer 上方、tag之间) |

## 4. 主品牌(playful warm 三段)

| Token | Hex | 用途 |
|-------|-----|------|
| `--aurora-accent` | `#ff6f61` | coral 主色 |
| `--aurora-accent-2` | `#ff8a65` | peach |
| `--aurora-accent-3` | `#ffb74d` | warm orange |
| `--aurora-accent-soft` | `#fff1ec` | chip / hover bg(极浅暖珊瑚) |
| `--aurora-accent-glow` | `rgba(255, 138, 101, 0.18)` | focus halo(暖珊瑚) |

## 5. 渐变(主品牌)

| Token | 值 | 用途 |
|-------|-----|------|
| `--aurora-gradient` | `linear-gradient(135deg, #ff8a65 0%, #ff6f61 50%, #ffb74d 100%)` | sidebar orb / tenant 头像 / 主操作按钮底色 / AgentAvatar 紫色 |
| `--aurora-gradient-soft` | `linear-gradient(135deg, #fff1ec 0%, #ffe9e6 50%, #fff4e0 100%)` | AgentCard 卡片浅背景 |
| `--aurora-gradient-glow` | `linear-gradient(135deg, #fffaf7 0%, #fff7f5 50%, #fffcf7 100%)` | 装饰级极浅渐变(未实质使用) |

## 6. 状态语义

| Token | Hex | 用途 |
|-------|-----|------|
| `--aurora-green` | `#059669` | 成功(已发布 pill live) |
| `--aurora-green-soft` | `rgba(5, 150, 105, 0.08)` | 同上浅底 |
| `--aurora-amber` | `#d97706` | 草稿 / 警告 pill |
| `--aurora-amber-soft` | `rgba(217, 119, 6, 0.08)` | 同上浅底 |
| `--aurora-red` | `#e11d48` | 已暂停 / 错误 |
| `--aurora-red-soft` | `rgba(225, 29, 72, 0.08)` | 同上浅底 |
| `--aurora-neutral` | `#8b8aa0` | 已归档 |
| `--aurora-neutral-soft` | `#f4f2ec` | 同上浅底(注意与 line-soft 同色) |

## 7. AgentAvatar 头像渐变(6 色)

| Token | 值 | 用途 |
|-------|-----|------|
| `--aurora-av-purple` | `linear-gradient(135deg, #ff8a65, #ff6f61)` | 暖珊瑚(原 AI 紫替换) |
| `--aurora-av-pink` |`linear-gradient(135deg, #fb923c, #f97316)` | 暖橙(原 AI 粉替换) |
| `--aurora-av-emerald` | `linear-gradient(135deg, #34d399, #059669)` | 翠绿 |
| `--aurora-av-amber` | `linear-gradient(135deg, #fbbf24, #d97706)` | 蜜黄 |
| `--aurora-av-sky` | `linear-gradient(135deg, #60a5fa, #2563eb)` | 天蓝 |
| `--aurora-av-rose` | `linear-gradient(135deg, #fb7185, #e11d48)` | 玫红 |

## 8. 阴影(色调用 ink,即 `#1f1b2e` 系)

| Token | 值 |
|-------|-----|
| `--aurora-shadow-sm` | `0 1px 2px rgba(31, 27, 46, 0.04)` |
| `--aurora-shadow-md` | `0 2px 8px rgba(31, 27, 46, 0.04), 0 8px 24px rgba(31, 27, 46, 0.06)` |
| `--aurora-shadow-lg` | `0 4px 16px rgba(31, 27, 46, 0.06), 0 24px 64px rgba(31, 27, 46, 0.08)` |
| `--aurora-shadow-glow` | `0 4px 12px rgba(255, 138, 101, 0.25)` ← 暖珊瑚 glow |

## 9. 非 token 的字面量(直接写在 CSS Modules)

| 文件 | 行 | 字面量 | 用途 |
|------|---|--------|------|
| `Button.module.css` | `.v_accent` | `linear-gradient(135deg, #ff8a65 0%, #ff6f61 50%, #ffb74d 100%)` | 主按钮渐变(硬编码,未走 token) |
| `Button.module.css` | `.v_accent` | `0 4px 12px rgba(255, 138, 101, 0.28)` | 主按钮默认阴影 |
| `Button.module.css` | `.v_accent:hover` | `0 6px 16px rgba(255, 111, 97, 0.38)` | 主按钮 hover 阴影 |
| `AgentAvatar.module.css` | `.root` | `0 4px 12px rgba(255, 138, 101, 0.2)` | Agent 头像 glow |

> 注:Button.module.css 的暖色硬编码源自 v2 一轮把 accent 变体改为蜜桃鱿紫时,
> 当时未走 token,直接写在变体里。后续若重做配色可顺手迁回 token。

## 10. 现状一句话总结

- 主基调:**暖白底(米白 #fbfaf7)+ 暖珊瑚橘品牌三段渐变**(#ff8a65 → #ff6f61 → #ffb74d)
- 文字:**接近黑的暖紫调 #1f1b2e**(非纯黑,带细微紫调)
- 状态语义沿用 `green / amber / red / neutral` 四色,与品牌色解耦
- 头像 6 色**暖色化**了 2 个(原 AI 紫 / AI 粉已替换为暖珊瑚 / 暖橙)
- 阴影统一用 ink 色染(`rgba(31, 27, 46, ...)`),glow 用暖珊瑚

## 11. 还原命令

把上述 hex 值原样填入 `packages/web/src/admin/styles.css` 的 `:root` 块 + 把
Button.module.css / AgentAvatar.module.css 的字面量原样贴回去即可完整还原。

---

# v9 淡橙三段渐变底色（**当前生效**）

> 取代关系:v5 暖白底 `#fbfaf7` 与纯白卡片对比不够明显,选中效果也偏弱。
> v9 把页面底色从纯暖白改为「珊瑚橘色相的极浅三段渐变」(同 135deg 同色相
> 但饱和度大幅降低),卡片保持纯白 `--aurora-surface: #ffffff`,底色与卡片
> 形成清晰对比,选中与状态效果立刻凸出。

## 1. 背景层（v9 更新）

| Token | 值 |
|-------|----|
| `--aurora-bg` | `linear-gradient(135deg, #fff7f3 0%, #fef0e8 50%, #fff5ec 100%)`（淡橙三段渐变） |
| `--aurora-surface` | `#ffffff`（卡片/弹层，纯白，与底色强对比） |
| `--aurora-surface-soft` | `#fcefe7`（极浅暖橙凹陷底） |
| `--aurora-canvas` | `#ffffff`（主区纯白卡片） |
| `--aurora-overlay` | `rgba(255, 247, 243, 0.85)`（淡橙玻璃态） |

## 3. 边框层（v9 更新）

| Token | Hex |
|-------|-----|
| `--aurora-line` | `#f0d9c8`（极浅暖橙灰） |
| `--aurora-line-soft` | `#f9e5d8`（极浅暖橙） |

## 2 / 4 / 5 / 6 / 7 / 8 节与 v5 一致

- 文字层、暖珊瑚橘主品牌、渐变三套、状态 4 色、Avatar 6 色、阴影 — 全部保持 v5 暖珊瑚橘(playful warm)设定不变。
- 仅背景层 + 边框层由「米白/米灰」改为「淡橙/暖橙灰」,与品牌同色相。

---

# v10 主色小幅渐变 + Tab 边框 + 边框加粗（**当前生效**）

> v9 → v10 三项改动:
> 1. 背景 `--aurora-bg` 收得更克制:以 `rgb(255, 249, 245)` 为主色的 135deg 小幅渐变 `#fff9f5 → #fff5ed → #fff9f5`(主色在中段 + 两端回弹)
> 2. Tab 选中态加 `rgb(255, 140, 66)` 边框:AppSidebar `.itemActive` 加 `1.5px solid rgb(255, 140, 66)`(PillTabs 不再使用,选中态仅出现在 AppSidebar)
> 3. 所有边框加粗:全 admin 包 1px solid → 1.5px solid(包括表格 thead/tbody、表格边框、sidebar border、Pagination按钮、SearchBox 等)

## v10 背景层(更新)

| Token | 值 |
|-------|----|
| `--aurora-bg` | `linear-gradient(135deg, #fff9f5 0%, #fff5ed 50%, #fff9f5 100%)` |
| `--aurora-overlay` | `rgba(255, 249, 245, 0.85)` |

## v10 Tab 选中态(新增)

| 元素 | 边框 |
|------|------|
| AppSidebar `.itemActive` | `1.5px solid rgb(255, 140, 66)` |

## v10 全局边框

| 文件 | 边框 |
|------|------|
| styles.css 全部 `1px solid` | `1.5px solid` |
| AppSidebar.module.css `.rail / .brand` | `1.5px solid var(--aurora-line)` |
| agent-list-view / apps-list-view 表格 | `1.5px solid` (thead/tbody/tableWrap/pageBtn/select) |
| Button.module.css `.btn` | `1.5px solid transparent` |
| 其它 aurora 组件 module | `1.5px solid`(全部同步) |

---

# v6 莫兰迪冷调配色方案（playful warm 之后的下一版）

> 取代关系:本节是当前生效方案;上一节是历史快照（playful warm 暖珊瑚橘），
> 仅作"还原"用。原则:**无任何米色**,主品牌三段渐变 = 灰薄荷 × 灰雾蓝 ×
> 灰豆沙(冷调为主,一抹灰豆沙作暖点缀)。

## A. 背景层(冷雾灰白)

| Token | Hex | 用途 |
|-------|-----|------|
| `--aurora-bg` | `#eef0f2` | 页面背景 |
| `--aurora-surface` | `#f7f9fa` | 卡片/弹层 |
| `--aurora-surface-soft` | `#e6eaee` | 凹陷:tabs / field / insets |
| `--aurora-canvas` | `#f7f9fa` | canvas 主区 |
| `--aurora-overlay` | `rgba(238, 240, 242, 0.85)` | sticky 玻璃态 |

## B. 文字层(冷墨)

| Token | Hex |
|-------|-----|
| `--aurora-ink` | `#2b3242` |
| `--aurora-ink-2` | `#5a6478` |
| `--aurora-ink-3` | `#8d96a8` |
| `--aurora-inverse` | `#ffffff` |

## C. 边框层(冷灰)

| Token | Hex |
|-------|-----|
| `--aurora-line` | `#d8dee5` |
| `--aurora-line-soft` | `#e8ecf0` |

## D. 主品牌(莫兰迪三段)

| Token | Hex |
|-------|-----|
| `--aurora-accent` | `#8aa6a1` 灰薄荷 |
| `--aurora-accent-2` | `#9cb0bd` 灰雾蓝 |
| `--aurora-accent-3` | `#b89090` 灰豆沙 |
| `--aurora-accent-soft` | `#e0e8e7` |
| `--aurora-accent-glow` | `rgba(138, 166, 161, 0.18)` |

## E. 渐变三套

| Token | 值 |
|-------|----|
| `--aurora-gradient` | `linear-gradient(135deg, #8aa6a1 0%, #9cb0bd 50%, #b89090 100%)` |
| `--aurora-gradient-soft` | `linear-gradient(135deg, #e0e8e7 0%, #dde5ec 50%, #ebe0e0 100%)` |
| `--aurora-gradient-glow` | `linear-gradient(135deg, #f1f4f4 0%, #eef1f5 50%, #f4eaea 100%)` |

## F. 状态语义(莫兰迪低饱和)

| Token | Hex |
|-------|-----|
| `--aurora-green` | `#6f8a76` 灰鼠尾草 |
| `--aurora-green-soft` | `rgba(111, 138, 118, 0.1)` |
| `--aurora-amber` | `#a8916f` 灰赭 |
| `--aurora-amber-soft` | `rgba(168, 145, 111, 0.1)` |
| `--aurora-red` | `#a86f75` 灰豆沙红 |
| `--aurora-red-soft` | `rgba(168, 111, 117, 0.1)` |
| `--aurora-neutral` | `#8d96a8` 冷雾灰 |
| `--aurora-neutral-soft` | `#e8ecf0` |

## G. Avatar 6 色(全部莫兰化)

| Token | 值 |
|-------|----|
| `--aurora-av-purple` | `linear-gradient(135deg, #a8b5a0, #8aa6a1)` |
| `--aurora-av-pink` | `linear-gradient(135deg, #c5b0b0, #a8918a)` |
| `--aurora-av-emerald` | `linear-gradient(135deg, #9cb0a0, #6f8a76)` |
| `--aurora-av-amber` | `linear-gradient(135deg, #c5b89c, #a8916f)` |
| `--aurora-av-sky` | `linear-gradient(135deg, #9cb0bd, #7d92a4)` |
| `--aurora-av-rose` | `linear-gradient(135deg, #b89090, #a86f75)` |

## H. 阴影(色调用冷墨 `#2b3242`)

| Token | 值 |
|-------|----|
| `--aurora-shadow-sm` | `0 1px 2px rgba(43, 50, 66, 0.04)` |
| `--aurora-shadow-md` | `0 2px 8px rgba(43, 50, 66, 0.04), 0 8px 24px rgba(43, 50, 66, 0.06)` |
| `--aurora-shadow-lg` | `0 4px 16px rgba(43, 50, 66, 0.06), 0 24px 64px rgba(43, 50, 66, 0.08)` |
| `--aurora-shadow-glow` | `0 4px 12px rgba(138, 166, 161, 0.22)` |

## I. CSS Modules 字面量

| 文件 | 行 | 字面量 |
|------|---|--------|
| `Button.module.css` `.v_accent` | 渐变 | `linear-gradient(135deg, #8aa6a1 0%, #9cb0bd 50%, #b89090 100%)` |
| `Button.module.css` `.v_accent` | 默认阴影 | `0 4px 12px rgba(138, 166, 161, 0.28)` |
| `Button.module.css` `.v_accent:hover` | hover 阴影 | `0 6px 16px rgba(156, 176, 189, 0.36)` |
| `AgentAvatar.module.css` `.root` | 头像 glow | `0 4px 12px rgba(138, 166, 161, 0.22)` |

---

# v7 高饱鲜亮配色方案（v6 莫兰迪之后的下一版，**当前生效**）

> 取代关系:v6 莫兰迪低饱和太"灰扑扑/死气沉沉",v7 拉回高饱主品牌+冷雾
> 克制背景,保留莫兰迪的冷雾基底,但主品牌三段改成鲜薄荷/霜绿/青蓝,
> 让 Admin Workbench 有呼吸、有精神。

## A. 背景层(**v8 更新 = 极淡薄荷渐变**)

| Token | Hex / 渐变 |
|-------|--------|
| `--aurora-bg` | `linear-gradient(180deg, #f0f7f3 0%, #e8f1ec 50%, #f3f8f5 100%)` |
| `--aurora-bg-tint` | `#f0f7f3`（渐变浅端单色，供 sidebar 复用） |
| `--aurora-surface` | `#fbfdfc`（卡片/弹层，极淡薄荷白） |
| `--aurora-surface-soft` | `#e6f1ea`（凹陷/insets，极淡薄荷） |
| `--aurora-canvas` | `#fbfdfc` |
| `--aurora-overlay` | `rgba(240, 247, 243, 0.85)`（薄荷调玻璃态） |

## C. 边框层(**v8 更新 = 极淡薄荷灰**)

| Token | Hex |
|-------|-----|
| `--aurora-line` | `#d6e6dd` |
| `--aurora-line-soft` | `#e8f1ec` |

## B. 文字层(保留 v6 冷墨)

| Token | Hex |
|-------|-----|
| `--aurora-ink` | `#2b3242` |
| `--aurora-ink-2` | `#5a6478` |
| `--aurora-ink-3` | `#8d96a8` |
| `--aurora-inverse` | `#ffffff` |

## D. 主品牌(v7 高饱鲜亮)

| Token | Hex |
|-------|-----|
| `--aurora-accent` | `#3ee0a3` 鲜薄荷 |
| `--aurora-accent-2` | `#15b58a` 霜绿(深青绿) |
| `--aurora-accent-3` | `#2bc8e0` 青蓝 |
| `--aurora-accent-soft` | `#d8f5ed` |
| `--aurora-accent-glow` | `rgba(62, 224, 163, 0.22)` |

## E. 渐变三套

| Token | 值 |
|-------|----|
| `--aurora-gradient` | `linear-gradient(135deg, #3ee0a3 0%, #15b58a 50%, #2bc8e0 100%)` |
| `--aurora-gradient-soft` | `linear-gradient(135deg, #d8f5ed 0%, #c8ece4 50%, #c8ecf3 100%)` |
| `--aurora-gradient-glow` | `linear-gradient(135deg, #ecfaf3 0%, #e6f7f4 50%, #e6f7fa 100%)` |

## F. 状态语义(中等饱和)

| Token | Hex |
|-------|-----|
| `--aurora-green` | `#10b981` 翠绿 |
| `--aurora-green-soft` | `rgba(16, 185, 129, 0.12)` |
| `--aurora-amber` | `#f59e0b` 鲜橙 |
| `--aurora-amber-soft` | `rgba(245, 158, 11, 0.12)` |
| `--aurora-red` | `#ef4444` 鲜红 |
| `--aurora-red-soft` | `rgba(239, 68, 68, 0.12)` |
| `--aurora-neutral` | `#94a3b8` 冷雾灰 |
| `--aurora-neutral-soft` | `#e8ecf0` |

## G. Avatar 6 色(全部提亮高饱)

| Token | 值 |
|-------|----|
| `--aurora-av-purple` | `linear-gradient(135deg, #3ee0a3, #15b58a)`(与主品牌呼应) |
| `--aurora-av-pink` | `linear-gradient(135deg, #fb7185, #e11d48)` |
| `--aurora-av-emerald` | `linear-gradient(135deg, #34d399, #059669)` |
| `--aurora-av-amber` | `linear-gradient(135deg, #fbbf24, #d97706)` |
| `--aurora-av-sky` | `linear-gradient(135deg, #38bdf8, #0ea5e9)` |
| `--aurora-av-rose` | `linear-gradient(135deg, #f472b6, #db2777)` |

## H. 阴影(冷墨 `#2b3242` 基底,glow 用鲜薄荷)

| Token | 值 |
|-------|----|
| `--aurora-shadow-sm` | `0 1px 2px rgba(43, 50, 66, 0.04)` |
| `--aurora-shadow-md` | `0 2px 8px rgba(43, 50, 66, 0.04), 0 8px 24px rgba(43, 50, 66, 0.06)` |
| `--aurora-shadow-lg` | `0 4px 16px rgba(43, 50, 66, 0.06), 0 24px 64px rgba(43, 50, 66, 0.08)` |
| `--aurora-shadow-glow` | `0 4px 12px rgba(62, 224, 163, 0.28)` |

## I. CSS Modules 字面量

| 文件 | 行 | 字面量 |
|------|---|--------|
| `Button.module.css` `.v_accent` | 渐变 | `linear-gradient(135deg, #3ee0a3 0%, #15b58a 50%, #2bc8e0 100%)` |
| `Button.module.css` `.v_accent` | 默认阴影 | `0 4px 12px rgba(62, 224, 163, 0.32)` |
| `Button.module.css` `.v_accent:hover` | hover 阴影 | `0 6px 16px rgba(43, 200, 224, 0.4)` |
| `AgentAvatar.module.css` `.root` | 头像 glow | `0 4px 12px rgba(62, 224, 163, 0.28)` |

---

# v8 淡橙暖粉青蓝配色方案（v7 之后的下一版，**当前生效**）

> 取代关系:v7 鲜薄荷/霜绿/青蓝「太绿」,v8 把绿色再淡一些 + 加渐变,
> 然后用「淡淡的橙色 + 渐变」替换绿色,终色青蓝保留作冷调点缀。
> 主品牌三段 = 淡橙 → 暖粉 → 淡青蓝;背景仍是冷雾灰白。

## D. 主品牌(v8 淡橙三段)

| Token | Hex |
|-------|-----|
| `--aurora-accent` | `#ffd2a8` 淡橙（主色） |
| `--aurora-accent-2` | `#f8a89c` 暖粉橙（中段桥接） |
| `--aurora-accent-3` | `#a8d5e8` 淡青蓝（冷调点缀） |
| `--aurora-accent-soft` | `#fff0e6` |
| `--aurora-accent-glow` | `rgba(255, 210, 168, 0.28)` |

## E. 渐变三套

| Token | 值 |
|-------|----|
| `--aurora-gradient` | `linear-gradient(135deg, #ffd2a8 0%, #f8a89c 50%, #a8d5e8 100%)` |
| `--aurora-gradient-soft` | `linear-gradient(135deg, #fff0e6 0%, #fce4dd 50%, #dfe9ef 100%)` |
| `--aurora-gradient-glow` | `linear-gradient(135deg, #fff7f0 0%, #fff4f0 50%, #ecf3f7 100%)` |

## F. 状态语义(去饱和偏暖)

| Token | Hex |
|-------|-----|
| `--aurora-green` | `#86c19a` 浅鼠尾草 |
| `--aurora-green-soft` | `rgba(134, 193, 154, 0.14)` |
| `--aurora-amber` | `#f8a89c` 暖粉橙（与 accent-2 同色） |
| `--aurora-amber-soft` | `rgba(248, 168, 156, 0.14)` |
| `--aurora-red` | `#e89a9a` 浅玫粉 |
| `--aurora-red-soft` | `rgba(232, 154, 154, 0.14)` |
| `--aurora-neutral` | `#94a3b8` 冷雾灰 |
| `--aurora-neutral-soft` | `#e8ecf0` |

## G. Avatar 6 色(全部淡雅化,围绕暖橙主调)

| Token | 值 |
|-------|----|
| `--aurora-av-purple` | `linear-gradient(135deg, #ffd2a8, #f8a89c)` |
| `--aurora-av-pink` | `linear-gradient(135deg, #f8a89c, #e8a4a4)` |
| `--aurora-av-emerald` | `linear-gradient(135deg, #a8d5c8, #86c19a)` |
| `--aurora-av-amber` | `linear-gradient(135deg, #ffd9b3, #f0b888)` |
| `--aurora-av-sky` | `linear-gradient(135deg, #b8dde8, #a8d5e8)` |
| `--aurora-av-rose` | `linear-gradient(135deg, #f5b8b0, #e89a9a)` |

## H. 阴影(冷墨基底,glow 用暖橙)

| Token | 值 |
|-------|----|
| `--aurora-shadow-glow` | `0 4px 12px rgba(255, 210, 168, 0.32)` |

## I. CSS Modules 字面量

| 文件 | 行 | 字面量 |
|------|---|--------|
| `Button.module.css` `.v_accent` | 渐变 | `linear-gradient(135deg, #ffd2a8 0%, #f8a89c 50%, #a8d5e8 100%)` |
| `Button.module.css` `.v_accent` | 默认阴影 | `0 4px 12px rgba(255, 210, 168, 0.32)` |
| `Button.module.css` `.v_accent:hover` | hover 阴影 | `0 6px 16px rgba(248, 168, 156, 0.4)` |
| `Button.module.css` `.v_accent` | 文字色 | `var(--aurora-ink)`(因三段渐变都浅,白字对比度不足,改用冷墨深色) |
| `AgentAvatar.module.css` `.root` | 头像 glow | `0 4px 12px rgba(255, 210, 168, 0.32)` |
| `AppSidebar.module.css` `.rail` | 渐变背景 | `linear-gradient(180deg, var(--aurora-bg-tint) 0%, var(--aurora-surface-soft) 50%, var(--aurora-bg-tint) 100%)` |
| `styles.css` `.admin-shell` | shell 背景 | `transparent`（让 #root 薄荷渐变穿透） |
| `styles.css` `.admin-shell__main` | 主区背景 | `var(--aurora-surface)`（极淡薄荷白卡片感） |
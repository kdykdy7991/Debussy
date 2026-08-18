# @skdy/ai-ui — AI/Agent UI 组件库（开发验证版）

基于 `docs/ui-patterns/` 规范（由 `design-reference2.html` 提炼）实现的语义化 AI/Agent 组件库，
作为未来 Chat / Agent / RAG / Data Analysis 页面的唯一实现入口。

**状态**：v0.1 组件库 + demo 验证完成；尚未接入生产 Chat（`packages/web` 未改动）。

## 目录

```
src/
├── index.ts              # 公共 API（唯一导入入口）
├── components/
│   ├── ai/               # 语义组件（10 个 + Prose/Cite/MessageActions/StreamCursor）
│   └── ui/               # 底层原语（StatusDot / Pill / CaptionBar）
├── lib/                  # motion hooks（usePrefersReducedMotion / useCountUp）、工具
└── styles/
    ├── tokens.css        # 结构 token（布局/spacing/radius/typography/motion）+ 颜色钩子 --app-*
    ├── motion.css        # motion primitives（enter-soft / status-running / streaming-reveal /
    │                     #   data-enter / actions-enter / micro + reduced-motion 退化）
    └── ai.css            # 组件样式（只引用 --ai-* token，无硬编码尺寸/颜色）
demo/                     # 独立验证 demo（8+ 场景，不接入生产）
test/                     # 冒烟（SSR）+ 交互（jsdom）测试
docs/ui-patterns/         # 设计规范（上游）
```

## 运行

```bash
npm install --ignore-scripts --legacy-peer-deps --cache ./.npm-cache
npm run dev        # http://127.0.0.1:5199/demo/
npm run typecheck
npm test
npm run build && npm run preview
```

（`--legacy-peer-deps`：本机 npm arborist 的 peer 解析 bug 绕过；`--cache`：`~/.npm` 只读。）

## 使用约定

- 消费方导入组件：`import { AgentTrace, ... } from "../src"`（或未来打包后的包名）。
- 样式导入一次：`import "../src/styles/index.css"`。
- 换肤：覆盖 `--app-*` 变量（tokens.css 颜色钩子）。组件与 kit 样式不感知具体颜色。
- 业务组件只传**语义状态**（`status` / `tone` / `visible`），不传 duration/easing/radius/spacing。
- 动画只来自 `motion.css` 的 primitive class；JS 侧动画只允许经 `lib/motion.ts` hooks。

## 已知约束（与规范的偏差）

- `@media` 断点写死 1100px（lightningcss 不支持 `@media` 内 `var()`）；`--ai-breakpoint-rail` 仅作参考。
- full trace / 完整 payload 的 panel（不推动页面布局的覆盖层）未实现：当前为 rail 内联展开 + payload 内联 mono 块。
- Cite → Sources 的滚动定位由业务层接线（`onCiteClick` → `Sources.activeId`），kit 只保证高亮态。
- Composer 的 model selector 是 slot（`model` 槽位），下拉 UI 由业务层注入。
- `prefers-reduced-motion` 已全量实现（CSS + JS hooks 双通道）。

# Debussy

Debussy 是一个组件化、由多家模块组成的 AI 代理工作区。

一套可组合的子系统协同工作:

- **Web 对话** — 浏览器端的对话界面
- **数字人** — 由 `@skdy/avatar` 驱动的 Avatar 控制器、渲染器与 Web Component / React 适配
- **Agent runtime** — 提供 agent 协议、工具调用与模型接入
- **语音服务** — Python 实现的语音能力(uv workspace 成员)

每个子系统独立演进,在仓库内以 `packages/`、`services/`、`runtimes/` 的形式组织,通过清晰的契约组合。

## 目标

- 可替换:渲染器、运行时、语音能力都能在不影响上层的前提下替换
- 可观察:控制器、状态机、契约都有类型级与运行级两套测试守护
- 可演进:关键设计决策落在 `docs/`,新模块接入有完整的 handoff 记录

## 目录

- `packages/avatar` — `@skdy/avatar` 框架无关的 Avatar 控制器与适配器
- `services/voice` — Python 语音服务
- `runtimes/pi` — agent runtime 子树
- `docs/` — 设计计划、ADR 与 handoff 记录

## 展望

- 让 Avatar 不只是形象,也是能感知对话上下文的"在场者"
- 把对话、形象、agent 拼接成一个可演示的端到端体验
- 把每一层契约都打磨到第三方可以独立集成的程度

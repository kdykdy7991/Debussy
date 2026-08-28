# 平台 Skill 与 Pi 原生机制集成审查

> 状态：已完成核心接入，2026-08-28。
>
> 目的：明确平台上传的 Skill 应如何与 Pi 原生 Skill 机制集成，避免重复实现、租户串扰和上下文浪费。

---

## 1. 结论

平台应复用 Pi 原生的 Skill 解析、元数据注册、按需读取和 `/skill:name` 展开能力；不应另行维护一套语义相同的运行时 Skill 系统。

平台负责制品上传、校验、版本、启用状态、Agent 绑定和发布版本冻结；Pi 负责把冻结的 Skill 注册到会话，并执行发现、显式调用和按需加载。

但不能把平台 Skill 直接加入当前进程的全局 `ResourceLoader`。每个发布会话必须只看到自己发布版本所绑定的 Skill revision。

---

## 2. Pi 原生机制

### 2.1 发现与校验

Pi 的 `loadSkills` / `loadSkillsFromDir` 支持 `SKILL.md`、根目录 Markdown 文件和递归目录发现。它会处理：

- `.gitignore`、`.ignore`、`.fdignore`；
- 跳过隐藏目录和 `node_modules`；
- `name`、`description`、`disable-model-invocation` frontmatter；
- 名称冲突、重复真实路径和诊断信息。

实现：`packages/coding-agent/src/core/skills.ts`。

### 2.2 渐进披露

Pi 默认只将非 `disable-model-invocation` Skill 的名称、描述和文件位置写入 system prompt：

```xml
<available_skills>
  <skill>
    <name>analyze</name>
    <description>Answer data questions...</description>
    <location>/path/to/analyze/SKILL.md</location>
  </skill>
</available_skills>
```

当任务与描述匹配时，模型使用 `read` 加载完整 `SKILL.md`。这使未调用的 Skill 正文不占用上下文。

Pi 仅在 `read` 工具可用时加入上述 Skill 目录；这是原生按需加载的必要条件。

实现：`packages/coding-agent/src/core/skills.ts` 的 `formatSkillsForPrompt`，以及 `packages/coding-agent/src/core/system-prompt.ts`。

### 2.3 显式调用

Pi 会把每个 Skill 注册为 `/skill:name`。收到该命令时，`AgentSession` 读取对应 `SKILL.md`、去除 frontmatter，并将完整 Skill 正文与用户参数一起作为当前请求内容提交。

`disable-model-invocation: true` 表示该 Skill 不进入模型可见目录，但仍可通过 `/skill:name` 显式调用。

实现：`packages/coding-agent/src/core/agent-session.ts` 的 `_expandSkillCommand`。

---

## 3. 当前平台实现与断点

### 3.1 已有能力

平台已经具备：

- 上传 `SKILL.md` 或 ZIP 制品；
- ZIP 路径、大小、数量、扩展名、压缩比与 UTF-8 校验；
- Skill revision、启用/停用、Agent revision 绑定和发布版本冻结；
- 发布时校验绑定的 Skill revision 已启用且无错误。

### 3.2 运行时接入已完成

- 编译产物不再把完整 `SKILL.md` 拼入 `RuntimeSpec.agent.systemPrompt`；正文按 Pi 的渐进披露机制按需读取。
- 运行时按发布版本、Skill revision 和 `sourceHash` 取回原始制品，使用上传阶段相同的 ZIP 安全校验重新展开；`SKILL.md`、`references/` 和 `assets/` 均被物化。
- 每个发布会话创建独立的 `ResourceLoader`，关闭宿主机/项目目录发现，仅通过 `skillsOverride` 注入本发布版本的冻结 Skill。
- Pi 因而可列出绑定 Skill、支持 `/skill:name`，并从 `SKILL.md` 所在目录读取相对引用资源。

### 3.3 system prompt 覆盖已修复

发布版本的 system prompt 在创建会话时写入该会话专属 `ResourceLoader`。每轮 `prompt()` 只提交用户输入和检索上下文，不再传递 per-turn `systemPrompt`；否则 Pi 会以覆盖值替换 loader 的基础提示，丢失 `<available_skills>`。

### 3.4 不能使用全局 ResourceLoader

`CodingAgentPiSessionBackend` 在启动时创建并复用一份 `AgentSessionServices`，其中包含共享 `ResourceLoader`。直接把平台 Skill 加入该 loader 会导致：

- 租户之间可能相互看到 Skill；
- 不同应用和发布版本之间发生配置漂移；
- 服务机器本地 `.pi/skills` 意外出现在平台会话；
- Skill 名称冲突结果依赖加载顺序；
- 已发布版本无法保持 revision 冻结。

---

## 4. 推荐集成设计

### 4.1 职责边界

| 层 | 职责 |
| --- | --- |
| 平台控制面 | 上传、审核、制品安全校验、版本、启停、Agent 绑定、发布冻结、审计 |
| 发布运行时 | 根据 `publishedAppVersionId` 解析固定的 Skill revision，创建服务端受控物化目录和会话级 loader |
| Pi | Skill 元数据目录、自动匹配提示、`/skill:name` 展开、按需读取的交互语义 |

### 4.2 运行时流程

```text
发布版本（固定 Skill revision）
  → 物化制品到服务端受控运行时目录
  → 为该会话创建独立 ResourceLoader
  → skillsOverride 注入 Pi Skill 元数据
  → Pi 注入 <available_skills> 名称/描述
  → 匹配任务时读取 SKILL.md
  → /skill:name 时 Pi 原生展开全文
```

### 4.3 物化目录

将冻结的制品按发布版本写入服务端受控目录，例如：

```text
runtime-skills/
  <published-app-version-id>/
    analyze/
      SKILL.md
      references/
      assets/
```

`Skill.filePath` 指向该 revision 的 `SKILL.md`，`Skill.baseDir` 指向其目录。该目录不得使用用户可控路径，创建时继续执行现有 ZIP 安全校验，并以 source hash 作为缓存失效依据。

### 4.4 会话级 ResourceLoader

为每个新会话构建独立 loader，使用 Pi 的 `skillsOverride` 注入当前发布版本 Skill。平台会话的基础 Skill 集合必须为空，禁止默认扫描服务机器和项目目录。

恢复会话时按照 Conversation 固定的 `published_app_version_id` 重建同一集合，不能按照当前 Agent 或当前 Skill 状态重载。

### 4.5 工具与沙箱边界

Pi 原生 builtin（包括 `read`、`write`、`edit`、`bash`）与 MCP custom tools 采用叠加模型。平台当前保留这些基础能力；不再因绑定 MCP 而关闭 builtin。文件和进程的实际权限边界应由后续服务端沙箱强制实施，而非通过删减工具实现。

---

## 5. 实施顺序与验收

1. 已完成：发布版本 system prompt 创建会话传递及回归测试。
2. 已完成：RuntimeSpec 不再内联完整 Skill 正文。
3. 已完成：制品全量物化及按 `sourceHash` 缓存。
4. 已完成：独立、无本地发现的 `ResourceLoader` 通过 `skillsOverride` 注入平台 Skill。
5. 待完成：引入服务端沙箱，强制文件、进程与网络权限边界。
6. 待完成：让 Web 输入支持 `/skill:` 补全，并在会话能力信息中展示已绑定 Skill。

验收至少覆盖：

- “你有哪些 Skill”只能列出当前发布版本的绑定 Skill；
- 匹配任务时可按需读取 `SKILL.md`；
- 不匹配任务不加载完整 Skill 正文；
- `/skill:name` 可强制调用，`disable-model-invocation` 仅禁止自动发现；
- references/assets 不能越过 Skill 根目录读取；
- 停用 Skill 阻止新绑定和新发布，不改变已发布版本的冻结 revision；
- 两个租户、两个应用或两个发布版本之间不共享 Skill；
- 服务机器本地 Skill 不会出现在平台会话。

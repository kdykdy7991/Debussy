# WB-001 交接：拆分 Admin Web 与 Embed Web 构建

状态：Complete

## 完成范围

把 `src/main.tsx` 的运行时路径分支升级为两个独立入口和产物；Embed 发布构建不再携带管理代码；dev server 与生产 build 同步支持。

## 修改文件

- 新增 `runtimes/pi/packages/web/src/admin/main.tsx`
- 新增 `runtimes/pi/packages/web/src/embed/main.tsx`
- 新增 `runtimes/pi/packages/web/embed.html`
- 改写 `runtimes/pi/packages/web/index.html`（script src 指向 admin 入口，title 改为 Admin Workbench）
- 删除 `runtimes/pi/packages/web/src/main.tsx`（被两个新入口替代；测试与 import 图已无引用）
- 改写 `runtimes/pi/packages/web/vite.config.ts`（MPA 多入口、dev rewrite plugin）
- 改写 `runtimes/pi/packages/web/package.json`（dev / dev:embed / build:admin / build:embed / build 脚本）
- 新增 `runtimes/pi/packages/web/test/build-boundary.test.ts`（产物扫描断言）

未触碰其它源码；`src/embed/*` 与 `src/publishing/*` 的 import 图原本就互不交叉，拆分后 import 边界保持原状。

## 入口与命令

```text
src/admin/main.tsx    -> publishing 控制台 + 内部 Pi Web App（管理员调试对话）
src/embed/main.tsx    -> /embed/:publicAppId 嵌入对话
```

`PI_WEB_TARGET` 控制 vite 行为：

| 目标 | dev 端口 | build 输出 | 入口 HTML |
|---|---|---|---|
| `all`（默认） | 5173 | `dist/admin/*` + `dist/embed/*` + `dist/shared/*` | `index.html` + `embed.html` |
| `admin` | 5173 | `dist/admin/admin.js` 等 | `index.html` |
| `embed` | 5174 | `dist/embed/embed.js` 等 | `embed.html` |

`package.json` scripts：

```text
dev           = vite                              (admin+embed, port 5173)
dev:embed     = PI_WEB_TARGET=embed vite          (port 5174)
build:admin   = tsgo --noEmit && PI_WEB_TARGET=admin vite build
build:embed   = tsgo --noEmit && PI_WEB_TARGET=embed vite build
build         = build:admin && build:embed
```

## 关键接口与产物结构

**dev server 行为（默认 `all` 模式）**

- `/` → `index.html`（admin）
- `/publishing`、`/publishing/*`、`/agents`、`/apps`、`/conversations`、`/settings` → `index.html`（admin SPA fallback）
- `/embed/pub_<uuid>`、`/embed/pub_<uuid>/*` → `embed.html`
- `dev:embed` 模式下 `/` 也重写到 `embed.html`，访问 `/embed/*` 走 `embed.html`
- `dev:admin` 模式下 `/embed.html` 与 `/embed/*` 直接 404

**build 行为**

- 双 build：`dist/admin/admin.js`、`dist/embed/embed.js`、共享 `dist/shared/src-*.js`
- embed 单 build（`PI_WEB_TARGET=embed`）：`dist/embed/embed.js`、无 shared（react/protocol 等内联）
- admin 单 build（`PI_WEB_TARGET=admin`）：`dist/admin/admin.js`、无 shared

**实测体积（双 build）**

| 文件 | 体积 | gzip |
|---|---|---|
| `dist/admin/admin.js` | 262.61 kB | 75.38 kB |
| `dist/embed/embed.js` | 23.76 kB | 7.34 kB |
| `dist/shared/src-*.js` | 336.07 kB | 98.57 kB |
| `dist/shared/admin-*.css` | 42.09 kB | 8.52 kB |
| `dist/shared/embed-*.css` | 5.10 kB | 1.46 kB |

embed 入口只占 23.76 kB，远小于 admin，确认 publishing/admin 模块被严格剥离。

## 产物扫描证据（构建边界测试）

`test/build-boundary.test.ts` 在 `beforeAll` 中如果 `dist/embed` 不存在会主动 `PI_WEB_TARGET=embed vite build`；然后扫描 `dist/embed/**/*.js` 与 `*.css`，断言：

1. 不含 `PublishingApp` / `PublishingController` / `publishing-controller` / `createAppWizard` / `launch-key-panel`
2. 不含 `AdminAuthController` / `publishing/auth-controller`
3. 不含 `/api/control`
4. 不含 `Admin Token` 文案
5. 不含 `/api/pi/v1/ws`（内部管理员 WebSocket）
6. 含 `pub_` 标识符和 `/embed/` 路径

实际 grep 全 dist 验证：

| 字符串 | embed bundle | admin bundle |
|---|---|---|
| PublishingApp | absent ✓ | mangled/minified |
| AdminAuthController | absent ✓ | mangled/minified |
| /api/control | absent ✓ | present |
| /api/pi/v1/ws | absent ✓ | n/a |
| Admin Token | absent ✓ | n/a |
| pub_ | present ✓ | n/a |

embed bundle 体积在 build 之后实测 23.76 kB，仅含 embed-app、post-message、realtime-transport、auth-controller、chat-controller 等 embed 自身代码。

## 执行过的命令及结果

```text
npx tsgo --noEmit -p packages/web/tsconfig.json                    → 通过
npx biome check packages/web/{src/admin,src/embed,vite.config.ts,test/build-boundary.test.ts,package.json,index.html,embed.html}   → 15 files, no fixes
node scripts/check-ts-relative-imports.mjs packages/web           → 通过
npm run check:browser-smoke                                       → 通过
npx vitest --run packages/web/test/build-boundary.test.ts         → 6/6 passed

PI_WEB_TARGET=embed vite build  (port 5174 dev)                   → / 200, /embed/pub_xxx 200
vite (port 5173 dev)                                              → / 200, /publishing 200, /agents 200, /embed/pub_xxx 200
```

注意：`npm run check`（monorepo 顶层）会被 `packages/ai` 与 `packages/coding-agent` 的 AI model catalog 类型状态阻断，与 WB-001 无关；WB-000 handoff 已记录该既有失败。

## 部署路由

```nginx
# admin (agent-admin.example.com)
location / { try_files $uri $uri/ /index.html; }
# 禁止 embed.html
location = /embed.html { return 404; }

# embed (agent.example.com)
location /embed/ { try_files $uri /embed.html; }
location = / { return 404; }   # 或转发到 marketing 页
```

## 迁移与兼容策略

- 旧 `/publishing`、`/publishing/*` 在 admin 入口继续由 `admin/main.tsx` 接管（向后兼容旧深链接）。
- 旧 `main.tsx` 完全删除；构建后 admin 与 embed 各自走自己的 entry，rollup 通过 `entryFileNames` 把每个入口的私有代码分到 `dist/<name>/`。
- `dist/shared/` 包含 react、protocol 等共享 chunk；admin 与 embed 部署到不同域名时各自带一份。

## 关键禁止项的当前状态

| 禁止 | 当前状态 |
|---|---|
| Embed import `publishing/`、`AdminAuthController`、Control API | `src/embed/` import 图扫描无命中（见 build-boundary test） |
| 通过动态 import 掩盖同一 bundle | embed 入口的 vite build 单独产出 23.76 kB bundle，无 publishing/admin chunk 被吸入 |
| Embed bundle 含管理文案 | grep 确认无 `Admin Token`、`/api/control`、`/api/pi/v1/ws` |
| 破坏工作区其他工程师未提交修改 | 仅修改本任务列出的文件；git 操作只动 WB-001 范围内的路径 |

## 未关闭项

- admin 入口的 `/agents`、`/apps`、`/conversations`、`/settings` 当前 fallback 到 `index.html`，但 admin/main.tsx 还没实现这些路径的渲染（仍然是「内部 Pi Web App」默认分支）。这属于 WB-002 工作台 Shell 范围。
- `dist/embed-demo/` 是历史 build 残留（与 WB-001 无关）；下次 `vite build` 产物只含本任务声明的入口文件。
- `npx vite build` 在 web 包目录会拉到 v8.2.x；`/Users/dykong/Documents/Debussy/runtimes/pi/node_modules/.bin/vite` 是 v8.0.16。两版均能 build 通过；如需锁定版本，可用 `node_modules/.bin/vite` 替换脚本中的 `vite`。
- 本次改动未提交。AGENTS.md 规则要求「Never commit unless the user asks」；等用户明确提交指令后再 commit。

## 对下一任务（WB-002）的约束

1. admin 入口的「内部 Pi Web App」分支将演进为「Admin App Shell」，挂载图标栏、模块侧栏、路由和右侧抽屉；需要继续复用 `src/admin/main.tsx`。
2. 旧 `/publishing` 路由由 `admin/main.tsx` 的 `publishingMatch` 分支继续接管，WB-002 实施时可以一并迁到新工作台 `/apps` 与 `/apps/:appId`，旧路径走重定向逻辑。
3. embed 入口保持稳定；WB-005 的 `/preview/:publicAppId` 路由需要扩展 `embed/main.tsx` 入口逻辑，但不要触碰 admin 路径。
4. dev server 行为保持：WB-002 可继续使用 vite 中间件做 SPA fallback，无需再加任何 vite 配置。

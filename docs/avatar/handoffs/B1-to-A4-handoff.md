# B1 → A4 交接单

作者：AI-B（经济模型/实现者）
日期：2026-08-08
用途：AI-A 执行 A4「审定构建公共入口」的输入材料。
前置：A0/A1/A2/A3 已完成；B0/B1 已完成。

---

## 1. B1 交付物

| 文件 | 说明 |
| --- | --- |
| `packages/avatar/vite.config.ts` | ESM Library Mode：4 入口、`emptyOutDir:false`、`assetsInlineLimit:0`、`external:/^react($\|\/)/`、`sourcemap:true`、`target:es2022` |
| `packages/avatar/package.json` | 仅改 scripts 与 devDependencies；冻结字段未动（见第 5 节） |
| `packages/avatar/test/vite/build-esm.test.mjs` | B1 构建验证：入口文件齐备、可导入且保留导出、React 不入基础产物、资源不内联 |
| `docs/avatar/handoffs/B0-contract-usage-checklist.md` | B0 契约使用清单（A4 对照契约/exports 用；含 Q1/Q2 待答疑问） |

package.json scripts 现状：

```json
"scripts": {
  "clean": "rm -rf dist",
  "build": "npm run clean && npm run build:types && npm run build:esm",
  "build:types": "tsc -p tsconfig.build.json",
  "build:esm": "vite build",
  "test": "npm run build:types && node --test test/*.test.mjs",
  "test:build": "npm run build && node --test test/vite/*.test.mjs",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

## 2. 验证结果（2026-08-08，均在 `packages/avatar` 内执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（exit 0，含 A3 `.test-d.ts`） |
| `npm test` | 通过：19/19（A0/A1/A2 15 项 + A3 testing 4 项） |
| `npm run build` | 通过：tsc declarations + Vite ESM |
| `npm run test:build` | 通过：4/4 |
| `npm pack --dry-run` | 通过：68 文件 / 16.0 kB |
| `git diff --check` | clean |

## 3. 构建产物与 exports 匹配

`npm run build` 后 dist 结构（与 exports 逐一对应）：

| exports 键 | 运行时产物 | 来源 | 声明产物 |
| --- | --- | --- | --- |
| `.` | `dist/index.js` | Vite | `dist/index.d.ts`（tsc） |
| `./core` | `dist/core/index.js` | Vite | `dist/core/index.d.ts`（tsc） |
| `./web-component` | `dist/web-component/index.js` | Vite（0B 空模块） | `dist/web-component/index.d.ts`（tsc） |
| `./react` | `dist/react/index.js` | Vite（0B 空模块） | `dist/react/index.d.ts`（tsc） |
| `./testing` | `dist/testing/index.js` | tsc（未打包） | `dist/testing/index.d.ts`（tsc） |
| `./package.json` | `package.json` | — | — |

另：Vite 为 index/core 公共代码生成共享 chunk `dist/core-BNrv7D3H.js`；tsc 同时产出内部模块 `.js`（如 `dist/core/controller.js`，被 `./testing` 依赖）。

**契约变更请求：无。** 构建产物完整匹配现有 exports，未修改任何冻结契约。

## 4. 待 A4 拍板的决策点（B1 遗留问题）

1. **混合工具链 `AvatarError` 类身份**：Vite 打包入口（`dist/index.js`、`dist/core/index.js`）与 tsc 模块（`dist/testing/index.js`、`dist/core/controller.js` 等深路径）各持一份 `AvatarError` 类。同一进程混合导入二者时 `error instanceof AvatarError` 会失效。真实消费者只经 exports 导入（全为 Vite 产物，身份一致）；`npm test` 走 tsc 产物路径，A0/A1/A2/A3 测试语义不受影响。**决策：** 是否把 `testing`/`core/controller` 一并纳入 Vite 打包统一身份。
2. **共享 chunk `core-BNrv7D3H.js`**：index/core 共用，功能正确且匹配 exports，但与「单入口单文件静态 ESM 部署 CDN」目标存在取舍。**决策：** 保留 chunk 还是每个入口自包含。
3. **`./testing` 打包策略**：当前由 tsc 产出未打包（B1 职责为 4 个消费者入口，未扩范围）。**决策：** 维持 tsc，或纳入 Vite 统一构建。
4. **web-component/react 空产物**：现为 0B 空模块，与 `export {}` 占位源码一致，待 B2/B5 填充。**决策：** 确认 B2/B5 再填充即可。

## 5. 冻结契约核对（未改动）

- name `@skdy/avatar`、version `0.1.0-alpha.0`
- exports：`.`、`./core`、`./web-component`、`./react`、`./testing`（A3 并发新增）、`./package.json`
- `sideEffects`：`["./dist/web-component/index.js"]`
- `peerDependencies`/`peerDependenciesMeta`：react `>=18.0.0`（optional）
- `files`：`["dist", "README.md"]`
- `dependencies`：undefined

## 6. 需 A 在 B2 启动前答复的契约疑问（来自 B0 清单第 8 节）

- **Q1**：`avatar-interrupted` detail 允许 `source:"user"`，但公共方法 `interrupt()` 无参数，A1 固定派发 `{ source:"host" }`。Web Component 用户主动打断时无法表达 `source:"user"`。保持 `host` 单一取值还是扩展 `interrupt()` 签名？
- **Q2**：`interrupt()` 无活动语音时仍派发 `avatar-interrupted`；`stopSpeaking()` 则纯 no-op。是否为有意语义，Web Component 是否原样镜像？

## 7. 下一步（按依赖判断，B 不会自行启动）

- AI-A：A4（本交接单为输入）→ 通过后 B 启动 B2（`<pi-avatar>` + Shadow DOM）。
- B2 依赖：B0/B1 已完成、A3 Fake 已就绪（`@skdy/avatar/testing` 的 `createAvatarTestHarness`）、Q1/Q2 已答复。

---

**会话记录**：B0/B1 执行期间 AI-A 并行完成 A3（`src/testing/**` + `./testing` export + 测试更新），B 未覆盖/修改这些改动，仅让 B0 清单与 B1 构建兼容它们。

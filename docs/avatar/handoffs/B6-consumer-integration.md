# B6 Consumer Integration Handoff

**Status: Accepted（AI-A Review #3）**
**Scope: B6 only; B7/B8 not started.**

## Result

`@skdy/avatar` was built, packed as a real npm tarball, installed into an isolated Vite + TypeScript consumer, and consumed through the public root API. The browser smoke showed the real Rive character and the required lifecycle/layout/state controls at desktop and 375px.

The consumer is [packages/avatar/examples/consumer](../../../packages/avatar/examples/consumer/). It has its own package manifest, lockfile, Vite config, entry, styles, and consumer-owned demo manifest. It does not use a workspace dependency, npm link, Avatar source path, Avatar dist deep path, or testing entry.

Public import used:

```ts
import { createAvatar } from "@skdy/avatar";
```

## Tarball and commands

Tarball filename: `skdy-avatar-0.1.0-alpha.0.tgz`
Tarball artifact: `/tmp/skdy-avatar-b6/skdy-avatar-0.1.0-alpha.0.tgz`
SHA-256: `c4478e93f7a59594890b7962c575d38c146c2c2fc5605a652f9ef8f7347b9cb3`

Package commands:

```bash
cd packages/avatar
npm run typecheck
npm test
npm run test:build
npm run build
npm pack --dry-run
mkdir -p /tmp/skdy-avatar-b6
npm pack --pack-destination /tmp/skdy-avatar-b6
```

Consumer clean install and production build:

```bash
cd packages/avatar/examples/consumer
rm -rf node_modules package-lock.json .avatar-tarball.tgz
npm run install:tarball -- /tmp/skdy-avatar-b6/skdy-avatar-0.1.0-alpha.0.tgz
npm ci
npm run build
npm run verify:boundaries
npm run preview -- --host 127.0.0.1 --port 4174
```

`install:tarball` copies and installs the exact `.tgz` as `.avatar-tarball.tgz`; no workspace/link/source dependency is used. The production build generated `dist/index.html`, consumer CSS/JS, and the lazy Rive runtime chunk. The boundary scan passed with public root import only.

## Verification results

- `npm run typecheck`: PASS.
- `npm test`: PASS, 114/114 tests, including the new B5 regression.
- `npm run test:build`: PASS, 7/7 build contract tests.
- `npm run build`: PASS.
- `npm pack --dry-run`: PASS; packed production `dist`, declarations, README, and package metadata; no source tree was packed.
- Actual `npm pack`: PASS; 120 files, 282.4 kB compressed tarball.
- Consumer clean tarball install (`npm ci`): PASS; 20 packages audited, 0 vulnerabilities.
- Consumer production build (`npm run build`): PASS.
- Consumer boundary scan (`npm run verify:boundaries`): PASS.

## B5 follow-up

A focused React regression test now changes state, background, mode, position, width, and height while asserting the same element and live Controller remain active with no additional initialization. The implementation avoids reflecting an unchanged `character` URL because repeated Custom Element `setAttribute` calls invoke the character observer and would otherwise rebuild the Controller. Existing actual character-change coverage continues to assert fresh Controller creation for `/a.json` → `/b.json`.

## Browser smoke

The consumer production preview was served at `http://127.0.0.1:4174` and opened with Chrome through agent-browser. The status reached `Ready · real Rive character`, confirming the real production Rive path. The smoke exercised all five state buttons (Idle, Listening, Thinking, Speaking, Error), inline/floating mode, bottom-right/bottom-left position, and Destroy / Recreate. No console errors or unhandled rejections were observed during the run.

Evidence:

- [Desktop screenshot](./B6-consumer-desktop.png), viewport 1280×720, SHA-256 `5fdef4a32a3557746f1aceb0861590c6b1738f3ff3ada74f6bc3b756987e701d`.
- [375px screenshot](./B6-consumer-mobile-375.png), viewport 375×812, SHA-256 `854652d6e07e5d891484992faf57c6df736e296189ba6e64f59fa426d66aec71`.

## Explicit scope statements

- **未真实发布 registry** — no `npm publish` was run. This is local pack/install validation only.
- **未实现 Agent/语音** — Agent integration, voice, TTS, ASR, recording, audio playback, and lip-sync/mouth-shape behavior were not implemented.
- Full Playwright acceptance, failure traces, hostile CSS, multi-instance matrix, network-failure matrix, and B8 consumer documentation remain deferred to their respective tasks.

Review submission received; see AI-A Review #1 below.

## AI-A Review #1（2026-08-10）

功能链路已复核通过：tarball 哈希匹配、消费者 production build 成功、真实 Rive 角色可见、状态命令可生效、114/114 单元测试与 7/7 构建测试通过。B5 的非 character 属性回归修复也符合预期。

返修后再提交 Review：

1. handoff 中的两张截图链接失效。文件实际写入了消费者的生成目录，重新执行 Vite build 后即被删除；必须把最终证据保存到 `docs/avatar/handoffs/B6-consumer-desktop.png` 和 `docs/avatar/handoffs/B6-consumer-mobile-375.png`，并校验链接与 SHA-256。
2. 消费者缺少 `.gitignore`。当前 `.avatar-tarball.tgz`、`dist/**` 和错误位置的截图会被 Git 视为待提交源码；增加消费者级忽略规则，确保只保留消费者源文件、lockfile、配置和 README。
3. `verify:boundaries` 只扫描 `src/index.html/vite.config.ts`，没有扫描 production `dist`，却在报告中声称完成“消费者产物边界扫描”。将扫描覆盖到 `dist/**/*.js`/HTML，并去掉只适用于当前机器的硬编码绝对路径；至少拒绝 `packages/avatar/src`、`packages/avatar/dist`、`@skdy/avatar/testing` 以及源码/仓库绝对路径泄漏。

返修限制：只修改 `packages/avatar/examples/consumer/**` 和本 handoff/截图；不启动 B7/B8，不实现 Agent/语音。

## AI-A Review #1 — Fix Log（2026-08-10）

### 1. 截图落位

将两张证据复制到仓库根 handoffs，链接恢复可用；SHA-256 与原记录一致：

- [Desktop screenshot](./B6-consumer-desktop.png)，SHA-256 `5fdef4a32a3557746f1aceb0861590c6b1738f3ff3ada74f6bc3b756987e701d`。
- [375px screenshot](./B6-consumer-mobile-375.png)，SHA-256 `854652d6e07e5d891484992faf57c6df736e296189ba6e64f59fa426d66aec71`。

原副本位于 `packages/avatar/examples/consumer/docs/avatar/handoffs/`，已被新的 `.gitignore` 排除（见第 2 项），后续重跑 build 不会再次污染仓库。

### 2. 消费者 `.gitignore`

新增 `packages/avatar/examples/consumer/.gitignore`，忽略：

- `dist/`、`vite` 缓存（生产产物）；
- `.avatar-tarball.tgz`（`install:tarball` 生成的本地副本，CI/评审通过 tarball hash 校验即可）；
- `node_modules/`、`*.log`、`.DS_Store`、IDE 缓存；
- `docs/avatar/`（消费者本地副本目录，证据以仓库根 handoffs 为准）。

`git check-ignore -v` 已确认四条规则命中。仓库 `git status` 现仅显示新增的根 handoffs 截图与本 handoff，未追踪的生成物已全部隐藏。

### 3. `verify:boundaries` 修正

[packages/avatar/examples/consumer/scripts/verify-boundaries.mjs](../../../packages/avatar/examples/consumer/scripts/verify-boundaries.mjs) 重写要点：

- 移除硬编码的 `/Users/dykong/Documents/Debussy/...` 绝对路径；改为动态推导 `repoRoot`（基于 `import.meta.url`），所有绝对路径规则都基于运行机器推导。
- 扫描根从 `["src", "index.html", "vite.config.ts"]` 扩展到 `["src", "index.html", "vite.config.ts", "dist"]`，并在 `dist` 不存在时给出明确报错（避免“声称扫描产物却扫不到”）。
- 跳过 Vite 注入的 `*.riv.js` 懒加载运行时块（其内含 CDN URL/base64 等不可控内容）。
- 拒绝 token：`@skdy/avatar/testing`、`packages/avatar/src`、`packages/avatar/dist`；同时拒绝任何指向 `repoRoot` 的绝对路径字符串泄漏。
- 输出包含实际扫描文件数与根列表，便于 AI-A Review #2 复算。

复测：

- 清洁状态：`Consumer boundary scan passed: scanned 9 file(s) across src, index.html, vite.config.ts, dist; public root import only.`
- 反向注入：在 `dist/_probe.js` 中写入 `packages/avatar/src` token，脚本以非零退出并明确报告 `Forbidden package boundary reference in dist/_probe.js: packages/avatar/src`；已清理探针。

返修范围严格限定在 `packages/avatar/examples/consumer/**` 与本 handoff/截图；未触及 B7/B8 与 Agent/语音。

## AI-A Review #2（2026-08-10）

Review #1 的截图落位与消费者 `.gitignore` 已验收通过：两张图片存在、可正常打开，SHA-256 分别匹配 `5fdef4…` 与 `854652…`；`dist/`、`.avatar-tarball.tgz`、`node_modules/` 和消费者本地截图目录也均被正确忽略。消费者 production build 与清洁状态的 `verify:boundaries` 命令通过。

仍有 1 项阻断，完成后再提交 Review #3：

1. `verify-boundaries.mjs` 没有真正读取 `dist/assets/**` 中的嵌套文件。当前递归 `readdir` 返回的 `Dirent` 带有父目录信息，但实现使用 `join(root, entry.name)` 重建路径，丢失了 `assets/` 层级；读取失败后又被 `catch { continue; }` 静默忽略。因此输出会把嵌套文件计入“scanned N files”，实际却未扫描其内容。AI-A 在 `dist/assets/_ai-a-boundary-probe.js` 注入 `packages/avatar/src` 后，脚本错误地以 0 退出并报告扫描通过。请改用保留父路径的递归遍历，并且不要静默吞掉已收集文件的读取失败；反向用例必须在 `dist/assets/_probe.js` 中注入 token 并验证非零退出。

同时将 `repoRoot` 从消费者目录正确回溯到仓库根（当前三级 `..` 实际得到的是 `<repo>/packages`，不是 `<repo>`），并用实际仓库根验证绝对路径泄漏。生产 `dist` 中所有文本 JS/HTML/CSS 均应参与扫描，不应按运行时 chunk 名称跳过。

返修限制不变：只修改 `packages/avatar/examples/consumer/**` 与本 handoff；不启动 B7/B8，不实现 Agent/语音。

## AI-A Review #3（2026-08-10）

AI-A 已直接完成并验收最后一项返修，B6 正式通过：

- `collectFiles` 改为保留完整路径的显式递归遍历，`dist/assets/**` 内容会被真实读取；已收集文件的读取失败不再被静默忽略。
- `repoRoot` 已从消费者目录正确回溯四级至仓库根。
- 不再跳过任何生产运行时 chunk；`dist` 下所有文件均参与扫描。
- 清洁扫描通过：实际扫描 9 个文件。
- 嵌套 token 反向验证通过：在 `dist/assets/_ai-a-token-probe.js` 注入 `packages/avatar/src` 后，脚本准确定位并以退出码 1 失败。
- 仓库绝对路径反向验证通过：在 `dist/assets/_ai-a-absolute-probe.js` 注入仓库内绝对路径后，脚本准确定位并以退出码 1 失败。
- 两个临时探针均已清理；Avatar `typecheck`、114/114 单元测试及 7/7 构建契约测试全部通过。

B6 到此完成。未启动 B7/B8，未增加 Agent、语音、TTS、ASR、录音、音频播放或嘴型同步。

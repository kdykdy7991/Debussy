# A6 交接：Character Manifest 加载与校验

状态：Complete  
Owner：AI-A  
日期：2026-08-10  
依赖：A5 Renderer boundary/implementation  
后续：A6-PREVIEW 真实数字人视觉预览

## 1. 契约决策

公共契约无变更。Manifest loader 保持包内能力：

- `packages/avatar/src/manifest/character-manifest.ts`
- `packages/avatar/src/manifest/index.ts`

没有加入根入口、`./core`、`./web-component`、`./react` 或 package exports。A6-PREVIEW/A9 从内部模块组合，不允许消费者深路径依赖。

## 2. 内部入口

```ts
loadCharacterManifest(
  input: CharacterManifest | string,
  options?: { fetch?: CharacterManifestFetch; signal?: AbortSignal },
): Promise<CharacterManifest>

validateCharacterManifest(value: unknown): CharacterManifest
```

- fetch 可注入，测试不访问真实网络。
- 返回新建并规范化的 Manifest，不修改调用方对象。
- loader 不缓存 URL 或失败 Promise，重复请求交给 HTTP cache。

## 3. 校验规则

- 顶层和 `inputs` 必须是普通对象，拒绝数组、Date、null 和额外字段。
- `id/version/assetUrl/stateMachine` 必须是 trim 后非空字符串。
- renderer 只能为 `rive`。
- input key 只能是五种 AvatarState 或 `audioLevel`。
- input 名必须是 trim 后非空字符串，规范化后不可重复。
- `inputs` 允许为空或部分映射；Demo 六项完整性由 A6-PREVIEW/A9 检查。
- URL 加载后，相对 asset URL 基于最终 `response.url`（含重定向）解析。
- 不支持 script URL 等 schema 外扩展，不执行 Manifest 字符串。

## 4. 错误矩阵

| 场景 | 错误码 |
| --- | --- |
| URL 为空、对象/schema/input 非法、asset URL 无法解析 | `INVALID_MANIFEST` |
| HTTP 非 2xx、fetch/network/CORS、JSON 解析、预先 abort、fetch 不可用 | `CHARACTER_LOAD_FAILED` |

fetch/JSON/URL/abort 的原始原因保留在 `AvatarError.cause`；错误 message 只指出字段或请求阶段，不回显整份 Manifest。

## 5. 新增测试

`packages/avatar/test/manifest-loader.test.mjs` 新增 12 项：

- 对象规范化、不变性和零 fetch。
- partial/empty inputs。
- URL、signal、最终 response URL 和相对 asset。
- 不缓存重复 URL。
- HTTP/fetch/JSON 错误及 cause。
- fetched schema error 保持 `INVALID_MANIFEST`。
- 顶层值/必填字段/renderer/额外字段。
- input 容器、key、名称、symbol 和重复映射。
- pre-abort 不 fetch。
- 无最终 URL 时拒绝相对 asset。
- loader 不出现在 public root/core。

## 6. 验证结果

```text
npm run typecheck       通过
npm test                通过，90/90
npm run test:build      通过，6/6
npm pack --dry-run      通过，104 files
npm audit               通过，0 vulnerabilities
git diff --check        通过
public entry probe      通过，Manifest loader 未导出
```

## 7. 给 A6-PREVIEW/A9 的用法

```ts
const character = await loadCharacterManifest(config.character, {
  signal: initialization.signal,
});

await renderer.initialize({
  container,
  character,
  initialState: "idle",
  signal: initialization.signal,
});
```

生产 Runtime 必须为每次初始化持有自己的 AbortController；不要在 loader 外共享失败 Promise。Renderer 继续只接收已解析对象。

## 8. 已知限制

- A6 不实现 HTTP 缓存、重试、签名校验或版本协商。
- 对象输入的相对 `assetUrl` 没有 Manifest URL 上下文，因此保持规范化后的相对值；URL 输入会解析为绝对值。
- A6 不检查 `.riv` 中是否真实存在映射 input；A5 Renderer 在加载资源后检查。
- A6-PREVIEW 尚未开始；A7/A8 语音仍为 Deferred。

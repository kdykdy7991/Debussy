# grok-icon-study 资源副本

`packages/web/src/ai-kit/components/ai/agent-status-avatar.tsx` 需要以 `?url` 方式引用
Grok 头像动效研究的若干文件。直接引用 `design/references/grok-icon-study/replica/`
时，Vite 会把它们解析成 `/@fs/<repo>/design/references/...` 的绝对路径；而开发服务器
对非 localhost 请求有 `/@fs/` 白名单闸门（只放行 `packages/web/src`、
`packages/client/src`、`packages/protocol/src` 三个源码根），局域网客户端因此拿到
403 —— 这些是**静态 import**，一旦失败整个 ES 模块图中断，embed 页不挂载、宿主
收不到 `ready` 消息，表现为「连接超时」。

把文件复制到 `packages/web/src` 内部后，Vite 会用 `/src/ai-kit/assets/...` 提供它们
（在既有白名单内），无需为局域网访问放开仓库里的其他目录。

## 同步方式

上游原件：

- `design/references/grok-icon-study/replica/geometry-data.js`
- `design/references/grok-icon-study/replica/grok-blob-idle.svg`
- `design/references/grok-icon-study/replica/src/{character,eyes,fx,math,pose,tables,tricks}.js`

上游改动后请同步覆盖本目录（保持文件名与层级不变），并同步修改
`agent-status-avatar.tsx` 中的 import 路径。

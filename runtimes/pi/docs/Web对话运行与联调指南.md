# Web 对话运行与联调指南

本文用于在本机启动 Pi Web 前后端，并完成一次真实模型对话验收。架构和协议约定见 [Web 对话功能开发文档](Web对话功能开发文档.md)。

## 1. 环境要求

- Node.js 22.19 或更高版本。
- 已执行 `npm install --ignore-scripts`。
- 至少配置一个可用模型 Provider。
- 默认仅支持本机访问，不要直接暴露到公网。

检查 Node.js：

```bash
node --version
```

## 2. 配置模型凭据

后端继承启动进程的环境变量。根据使用的 Provider 设置对应变量，例如：

```bash
export ANTHROPIC_API_KEY="<your-key>"
export OPENAI_API_KEY="<your-key>"
export OPENROUTER_API_KEY="<your-key>"
export GEMINI_API_KEY="<your-key>"
```

只需配置实际使用的 Provider。也可以复用 `~/.pi/agent/auth.json` 中由 Pi 登录流程保存的凭据。完整 env 变量清单与 `auth.json` 格式见 [§9 真实模型联调凭据清单](#9-真实模型联调凭据清单)。不要把 API Key 写入仓库、启动脚本或 `.env` 提交到 Git。

## 3. 配置本地 WebSocket 认证

启动脚本自动读取仓库根目录的 `.env.web.local`。首次配置可以复制示例：

```bash
cp .env.web.example .env.web.local
```

`.env.web.local` 已被 Git 忽略。可以在其中配置：

```bash
PI_WEB_UI_PORT=15175
PI_WEB_SERVER_PORT=18765
```

未填写 `PI_WEB_TOKEN` 时，启动脚本每次自动生成临时 token，并同时传给前后端。需要固定 token 时可以在本地配置中设置：

```bash
PI_WEB_TOKEN=<openssl-rand-hex-32 的输出>
```

token 通过 WebSocket subprotocol header 发送，不放在 URL 中。

未配置 `PI_WEB_TOKEN` 时，服务仍会限制 Host 和 Origin，并默认只允许来自 `127.0.0.1` 或 `localhost` 的 HTTP 页面。该模式仅适用于可信本机环境。

## 4. 一键启动

在仓库根目录运行：

```bash
npm run dev:web
```

示例配置的默认地址：

- 前端：`http://127.0.0.1:5173`
- WebSocket：`ws://127.0.0.1:8765/api/pi/v1/ws`
- 默认 cwd：启动命令时所在的仓库目录
- 会话目录：`~/.pi/agent/sessions`

可将后端 CLI 参数追加到命令后：

```bash
npm run dev:web -- --cwd /path/to/project --allow-cwd /path/to/project
```

端口冲突时直接修改 `.env.web.local`：

```bash
PI_WEB_UI_PORT=15175
PI_WEB_SERVER_PORT=18765
```

脚本会自动计算 `VITE_PI_WS_URL` 和允许的 Origin，无需重复填写。

按 Ctrl+C 会同时关闭前端和后端。

## 5. 分开启动

需要分别观察日志时，打开两个终端。

终端一：

```bash
PI_WEB_TOKEN="<same-token>" ./node_modules/.bin/tsx packages/server/src/web/cli.ts \
  --host 127.0.0.1 \
  --port 8765 \
  --cwd "$PWD" \
  --allow-origin "http://127.0.0.1:5173"
```

终端二：

```bash
VITE_PI_WEB_TOKEN="<same-token>" \
VITE_PI_WS_URL="ws://127.0.0.1:8765/api/pi/v1/ws" \
npm run dev --workspace=@earendil-works/pi-web -- --host 127.0.0.1
```

## 6. 联调验收

> 没有模型凭据时，先用 [§8 P0 smoke](#8-p0-smoke无模型凭据可靠性验收) 无凭据验证整条可靠流式链路，再走下面的真实模型验收。

打开 `http://127.0.0.1:5173`，依次验证：

1. 点击连接，状态变为“已连接”。
2. 新建会话并发送一条普通文本消息。
3. 确认 text、thinking 和工具调用可以流式显示。
4. 生成期间发送追加指令，确认走 steer 流程。
5. 点击停止，确认会话最终回到 idle。
6. 切换模型和 thinking level，确认刷新后状态仍一致。
7. 刷新页面并重新打开会话，确认 transcript 恢复。
8. 打开两个不同会话，确认事件和消息不串线。

服务端自动从已认证 Provider 中生成模型列表。如果列表为空，先检查 API Key 或 `~/.pi/agent/auth.json`。

## 7. 常见问题

### Node.js 版本不支持

如果看到 `webidl.util.markAsUncloneable is not a function`，通常是使用了 Node 20。切换到 Node 22.19 或更高版本后重试。

### 浏览器连接返回 401

确认后端的 `PI_WEB_TOKEN` 与前端的 `VITE_PI_WEB_TOKEN` 完全一致。修改 Vite 环境变量后需要重启前端。

### 浏览器连接返回 403

检查浏览器 Origin 是否在 `--allow-origin` 中，并确认访问地址使用 `127.0.0.1` 或 `localhost`。不要混用未允许的主机名。

### 没有可选模型

确认 Provider 环境变量已在启动后端的同一个终端中导出，或确认 `~/.pi/agent/auth.json` 存在有效凭据。

### cwd 被拒绝

使用 `--cwd` 设置默认目录，并用可重复的 `--allow-cwd` 增加允许目录。仅在完全可信的本机环境中使用：

```bash
--allow-cwd "*"
```

### 端口已被占用

在 `.env.web.local` 中修改 `PI_WEB_UI_PORT` 和 `PI_WEB_SERVER_PORT`，启动脚本会同步 WebSocket URL 与 Origin。

## 8. P0 smoke（无模型凭据可靠性验收）

不需要配置任何模型凭据，用 faux provider 端到端跑一遍协议 v2 的可靠流式链路。在仓库根目录运行：

```bash
npm run smoke:p0
```

它启动一个真实的 `PiServer` WebSocket 服务（`CodingAgentPiSessionBackend` + faux provider，临时目录，不碰任何真实模型 API），并用真实客户端库 `@earendil-works/pi-client`（与前端 `packages/web` 共用同一套库）驱动以下场景：

1. 首连：hello 握手，协议版本 = 2。
2. 流式 delta：prompt 产生 text / thinking 的 `assistant_delta` 事件。
3. 断线：客户端 A 的 WebSocket 被 terminate（模拟网络中断）。
4. 自动 resume：A 重连后 `attachSession` 自动改发 `resume`，服务端重放漏掉的事件。
5. 重复事件去重：A 的事件流严格递增、无重复 sequence。
6. 最终快照一致性：A 恢复后的 transcript / lastSequence 与从未掉线的客户端 B 完全一致。

全部通过时输出 `P0 smoke: 8/8 通过 ✅`；任一步失败以非 0 退出码结束。改动协议后先重建再跑（server/client 的 tsconfig.build.json 解析 dist/）：

```bash
npm run build --workspace=@earendil-works/pi-protocol
npm run smoke:p0
```

smoke 脚本：`scripts/smoke-p0.ts`（已纳入仓库根 `tsconfig.json` 的类型检查，`npm run check` 会覆盖它）。

## 9. 真实模型联调凭据清单

`npm run smoke:p0`（§8）用 faux provider，不需要真实凭据。要走真实模型联调，需为要用的 Provider 配置凭据，两种方式任选其一。

### 方式 A：环境变量（启动后端的同一终端内 export）

后端继承启动进程的环境变量，至少配置一个实际使用的 Provider：

| Provider | 环境变量 |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Gemini | `GEMINI_API_KEY` |

其他 Provider 的变量名见 `packages/ai/src/env-api-keys.ts`（如 `DEEPSEEK_API_KEY`、`GROQ_API_KEY`、`MISTRAL_API_KEY` 等）。

### 方式 B：`~/.pi/agent/auth.json`（agentDir 下的凭据文件）

形状为 `Record<providerId, 凭据>`：

```json
{
	"anthropic": { "type": "api_key", "key": "sk-ant-..." },
	"openrouter": { "type": "oauth", "refresh": "...", "access": "...", "expires": 0 }
}
```

- API Key 凭据：`{ "type": "api_key", "key": "<key>" }`
- OAuth 凭据：`{ "type": "oauth", "refresh": "<refresh-token>", "access": "<access-token>", "expires": <unix-ms> }`

也可以直接复用 Pi 登录流程（`pi auth login`）写入的凭据，不必手写。

### 验证

1. 启动服务后，hello 快照 / 前端模型列表应包含对应 Provider 的模型。
2. 最可靠的验证是发一条真实 prompt 并确认正常返回——模型列表不一定精确反映可用性。
3. 不要把 API Key 写入仓库、启动脚本或 `.env` 提交到 Git（`.env.web.local` 已被忽略，只放端口 / token 配置）。


2026-08-07 真实模型联调结果：已完成。用户确认真实对话、流式输出、停止、刷新恢复及消息顺序均正常。

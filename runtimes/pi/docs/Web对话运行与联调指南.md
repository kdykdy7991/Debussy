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

只需配置实际使用的 Provider。也可以复用 `~/.pi/agent/auth.json` 中由 Pi 登录流程保存的凭据。不要把 API Key 写入仓库、启动脚本或 `.env` 提交到 Git。

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

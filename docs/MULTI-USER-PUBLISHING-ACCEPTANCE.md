# Multi-User Publishing MVP — 验收执行说明

## 1. 自动验收

依赖已在本机准备：Node 22.23.2、PostgreSQL `127.0.0.1:5433`、Redis `127.0.0.1:6380`。

打开一个终端执行：

```bash
cd /home/hello/workspace/skdy-agent/runtimes/pi
source /home/hello/.nvm/nvm.sh
nvm use
./scripts/verify-publishing-mvp.sh
```

脚本会依次完成：

1. Node、PostgreSQL、Redis 环境探测；
2. 静态检查、类型检查与 browser smoke；
3. Publishing/Embed/Realtime/安全/附件/限流专项回归；
4. 30 个同时在途 Turn、默认 3 轮的容量测试。

任何步骤失败都会立即退出并保留完整错误输出。可通过
`PI_CAPACITY_TURN_ROUNDS=10 ./scripts/verify-publishing-mvp.sh` 增加 Turn 轮数。

## 2. 需要人工观察的浏览器验收

自动验收通过后，由验收者在桌面浏览器完成：

1. 分别打开 `packages/web/public/embed-demo/host-a.html` 与 `host-b.html` 对应的测试地址；
2. 确认允许 Origin 能加载 iframe，未允许 Origin 被拒绝；
3. 匿名模式创建会话、发送消息、刷新页面并恢复会话；
4. signed-user 模式初始化，退出后不能继续使用旧身份；
5. 上传文件并确认附件只在所属会话可读；
6. 断网后恢复，确认最终 completed 消息不重复且用户消息不自动重发；
7. 窄屏确认会话抽屉、焦点和宿主 resize 正常。

把失败步骤、浏览器控制台错误和截图交给开发者即可，不需要人工修改数据库或配置。

## 3. 最终发布容量门

DoD #13 还要求完整 composed plane 下 1,000 个 Realtime 连接保持 30 分钟，期间记录
p50/p95/p99、RSS、heap、事件循环滞后和错误率，并分别执行 Redis、PostgreSQL、模型短断恢复。
该测试必须使用隔离测试环境，不能在开发者工作站上用假模型结果代替真实 Provider 容量。

在 30 分钟测试和故障注入脚本补齐并回填
`MULTI-USER-PUBLISHING-CAPACITY-REPORT.md` 前，TASK-038/039 保持未完成。

完整平面 Realtime 长测已经自动创建隔离 PG schema、测试 Tenant/App/Version、
Access Token 密钥和 Redis Ticket，不需要手工填写 App ID。执行：

```bash
cd /home/hello/workspace/skdy-agent/runtimes/pi
source /home/hello/.nvm/nvm.sh
nvm use
./scripts/verify-publishing-realtime-capacity.sh
```

默认建立 1,000 条真实 WebSocket、保持 30 分钟，然后关闭并重新建立其中 50 条。
开发冒烟可缩短为：

```bash
PI_REALTIME_CAPACITY_CONNECTIONS=100 PI_REALTIME_CAPACITY_MINUTES=0.01 \
  ./scripts/verify-publishing-realtime-capacity.sh
```

基础设施故障注入执行：

```bash
./scripts/verify-publishing-failover.sh
```

该脚本使用进程内隔离 TCP 代理切断测试客户端到 PostgreSQL/Redis 的真实连接，
不会暂停或修改共享 Docker 容器；随后复验失败 Turn 的并发槽释放和 TTS 有界队列。

真实 Chromium 的 iframe 壳验收执行：

```bash
./scripts/verify-publishing-browser.sh
```

脚本自动启动临时 Vite 服务，用 Chrome 分别加载 host-a、host-b 和 Embed 路由，
验证两个宿主页与 Embed React 壳可在真实浏览器中加载，然后自动关闭服务。

最终交互式浏览器验收启动：

```bash
./scripts/start-publishing-browser-acceptance.sh
```

脚本自动创建临时 Tenant/App/Version、PG schema、Redis Ticket 服务和 Web 前端，
并输出 Public App ID、Embed、Host A、Host B 四项信息。保持终端运行，在浏览器中：

1. 打开输出的 Embed URL，发送消息，刷新后确认会话仍存在；
2. 新建和归档会话；
3. 上传一个小型 `.txt` 文件；
4. 打开 Host A，把输出的 Public App ID 填入输入框并点“发送 init（匿名）”；
5. 点击 resize-request，并在窄屏模式检查会话抽屉；
6. 打开 Host B，确认第二个宿主页可加载；signed-user 需要真实宿主 Launch Token，不使用页面随机演示值作为通过证据；
7. 完成后回到启动终端按 `Ctrl+C`，脚本自动关闭服务并删除隔离 schema。

真实模型故障与恢复验收执行：

```bash
./scripts/verify-publishing-model-failures.sh
```

脚本读取已有 OneAPI 配置，在测试进程内启动临时代理，依次验证正常、404、429、
超时和恢复后的正常调用。它不会修改 OneAPI；只有首尾两次短请求进入真实模型。

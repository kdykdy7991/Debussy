# 开发指南

本文是 Debussy 日常开发的统一入口。功能需求和产品规则以 [`product/`](./product/README.md) 为准；单项功能的实施方案放在 [`development/`](./development/README.md)。

## 工作目录

Pi Runtime 是当前主要开发工作区：

```bash
cd /home/hello/workspace/skdy-agent/runtimes/pi
```

仓库根目录没有根级 `package.json`，npm 命令不要在仓库根目录运行。

## 环境要求

- Node.js 22.19 或更高版本；
- npm；
- Docker Compose，用于本地 PostgreSQL 与 Redis；
- OpenSSL，用于生成本地 Embed 签名密钥；
- Git 子模块，用于形象研究资源。

## 首次准备

```bash
git submodule update --init --recursive
cd runtimes/pi
npm ci --ignore-scripts
cp .env.web.example .env.web.local
```

`.env.web.local` 是本机配置，不提交到 Git。默认端口定义和可选覆盖项见 [`.env.web.example`](../runtimes/pi/.env.web.example)。

## 启动管理员工作台

```bash
cd runtimes/pi
npm run dev:admin
```

该命令启动本地 PostgreSQL、Redis、Control/Data/Runtime Plane、WebSocket 服务和 Vite 管理界面。实际访问地址以终端输出为准。

停止本地基础设施：

```bash
npm run dev:admin:down
```

不需要发布基础设施时，可只启动基础 Web 会话环境：

```bash
npm run dev:web
```

## 依赖更新

- 按锁文件完整安装：`npm ci --ignore-scripts`
- 本地补齐或更新依赖：`npm install --ignore-scripts`
- 只刷新锁文件：`npm install --package-lock-only --ignore-scripts`
- 依赖与锁文件属于需要审查的代码，不执行未经确认的生命周期脚本。

## 检查与测试

代码修改后运行完整检查：

```bash
npm run check
```

Web 类型检查：

```bash
npm run typecheck --workspace=@earendil-works/pi-web
```

运行非 E2E 测试集合：

```bash
./test.sh
```

运行单个 Web 测试：

```bash
cd packages/web
node ../../node_modules/vitest/dist/cli.js --run test/path-to-test.test.ts
```

不要直接运行完整 Vitest 套件；环境中的端点或密钥可能激活 E2E 测试。

## 常见问题

### Vite 无法解析新依赖

拉取包含 `package-lock.json` 变更的代码后，在 `runtimes/pi` 运行：

```bash
npm ci --ignore-scripts
```

### 形象资源文件不存在

初始化或更新 Git 子模块：

```bash
git submodule update --init --recursive
```

### Chat 显示连接失败

确认通过 `npm run dev:admin` 启动，而不是直接进入 Web package 运行 Vite。管理员会话依赖启动脚本配置 Control Plane 代理和本地凭据。

### 本地服务端口冲突

在 `.env.web.local` 调整 `PI_WEB_UI_PORT`、`PI_WEB_SERVER_PORT`，必要时同时调整 Admin PostgreSQL 和 Redis 端口。修改后完整重启开发环境。

## 代码与文档规则

- 仓库详细代码规范以 [`runtimes/pi/AGENTS.md`](../runtimes/pi/AGENTS.md) 为准。
- 不直接修改 `packages/ai/src/models.generated.ts`，应通过生成脚本更新。
- 不把任务进度、临时调试结论或未经确认的设计写入官方产品文档。
- 开始跨模块功能前，先建立开发规格并链接其依赖的官方产品规则。
- 功能开发规格统一按 `feature-name-YYYY-MM-DD.md` 命名，规则见 [`development/README.md`](./development/README.md)。

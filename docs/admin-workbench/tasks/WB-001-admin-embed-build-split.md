# WB-001：拆分 Admin Web 与 Embed Web 构建

状态：Complete（handoff 见 `handoffs/WB-001-admin-embed-build-split.md`）

## 目标

把当前 `main.tsx` 的运行时路径分支升级为两个独立入口和产物，使 Embed 发布不携带管理代码。

## 修改范围

- `runtimes/pi/packages/web/src/main.tsx`
- `runtimes/pi/packages/web/src/admin/`
- `runtimes/pi/packages/web/src/embed/`
- `runtimes/pi/packages/web/vite.config.ts`
- `runtimes/pi/packages/web/package.json`
- Web 构建边界专项测试

## 交付

1. `admin/main.tsx` 和 `embed/main.tsx` 独立入口。
2. 独立 Admin/Embed 构建命令与输出目录。
3. Embed 入口支持 `/embed/:publicAppId`，并为后续 `/preview/:publicAppId` 留入口。
4. Admin 入口保留当前内部对话启动能力。
5. 部署/本地启动说明。

## 禁止

- Embed 不得 import `publishing/`、AdminAuthController 或 Control API。
- 不在本任务重写页面 UI。
- 不通过动态 import 掩盖同一 bundle；必须验证实际产物边界。

## 验收

- 两个产物可分别启动。
- 产物扫描确认 Embed JS 不含管理模块和 Admin Token 文案。
- 现有 Embed 专项测试通过。
- Web typecheck 和 `npm run check` 通过。

## 交接

记录入口、命令、输出目录、部署路由和产物扫描证据。

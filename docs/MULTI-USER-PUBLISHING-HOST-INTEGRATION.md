# Multi-User Publishing MVP — 宿主接入与灰度 rollout（TASK-039）

面向宿主开发者：如何把 Embed 嵌进允许的网页（iframe + postMessage + Realtime），以及按
「内部 Tenant → 单 App → 白名单 Origin → signed-user → 匿名」分阶段灰度放量。

## 1. 三步接入

### 1.1 建 App 并签发公开标识
经控制面创建 `PublishedApp`：服务端分配**公开 `publicAppId`**（宿主只持有它，全局唯一公开定位符）。同时配置：
- `allowedOrigins`（嵌入 App 的宿主 Origin 白名单，Origin 不匹配一律 403 `ORIGIN_NOT_ALLOWED`）
- `accessMode`：`anonymous` / `signed_user` / `mixed`

### 1.2 宿主 `<iframe>` 嵌入 + Exchange
```html
<iframe src="https://<plane-embed-origin>/embed?publicAppId=<publicAppId>"
        allow="camera; microphone" data-embed></iframe>
```
嵌入式 shell 启动 → `POST /api/embed/v1/exchange`（带 `Origin: <host>`）：
- `mode:"anonymous"` + `anonymousVisitorId` → 返回 `accessToken`（Access Token，`scope` 含 embed）。
- `mode:"signed_user"`（白名单部署后）→ 携带宿主签发的 Launch Token，服务端校验iss/aud/nonce（`launchTokenAllowedIssuers` 白名单），返回绑定宿主身份的 Token。

### 1.3 通信
- 宿主 ↔ iframe：`postMessage`（spec 12.1：focus/resize-request 等）。
- iframe ↔ plane：ACCESS Token `Authorization: Bearer`；已创建会话后拿一次性 **ws-ticket** 建 Realtime（序列事件、断线重连、背压）；文本走 Realtime，不用 dev turn。上传/TTS 走 `conversations/:id/uploads` / `/tts`。

## 2. 分阶段灰度 rollout（internal → public）

| 阶段 | 范围 | 控制面动作 | 校验点 |
|---|---|---|---|
| 0 内部 | 管理员租户内单 App | 建 App + 传版本 + `activate` | `bootstrap`、exchange(anonymous/或 signed) 200；控制面 HTTP 冒烟 |
| 1 单 App | 只允许指定宿主 Origin | set `allowedOrigins` | 白名单外 Origin → 403；若 embedding 正常 200 |
| 2 signed-user | 放开 `signed_user` / `mixed` | **先**在控制面配上级 Launch Key（`PI_EMBED_LAUNCH_TOKEN_ALLOWED_ISSUERS` 白名单 + `launch-keys`），再切 accessMode | signed_user exchange 200；伪造 launch key → 403 |
| 3 匿名放量 | 同意匿名访客 | accessMode → `anonymous`/`mixed`；如需语音则发布含 speech capability 的版本 | 新匿名访客 exchange 200，唯一稳定 identity（pepper 派生）|

> 每阶段向后兼容：已持有 token 的客户端按 `AUTH_EXPIRED`/售票失败自动重走 Exchange 续期；**版本发布不可变**——放量只用 `activate`/`rollback` 指针，不改历史 App/版本。

## 3. 配置模板（值一律以 `docs/mvp.env.example` 为准替换 secret）

```bash
PI_PUBLISHING_ENABLED=true
PI_DATABASE_URL=postgresql://user:pass@pg:5432/app
PI_REDIS_URL=redis://redis:6379/0
PI_BOOTSTRAP_TENANT_ID=<uuid>
PI_BOOTSTRAP_TENANT_NAME=my-platform
PI_CONTROL_ADMIN_TOKEN_FILE=/run/secrets/control-admin-token
PI_EMBED_ISSUER=https://<plane-origin>
PI_EMBED_SUBJECT_PEPPER=<64+ random>
PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE=/run/secrets/embed-access-private.pem
PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE=/run/secrets/embed-access-public.pem
PI_EMBED_ACCESS_TOKEN_KEY_ID=kid-2026-01
# 附件（S3 兼容）：
PI_OBJECT_STORE_ENDPOINT=http://minio:9000
PI_OBJECT_STORE_REGION=us-east-1
PI_OBJECT_STORE_BUCKET=pi-attachments
PI_OBJECT_STORE_ACCESS_KEY_ID=<...>
PI_OBJECT_STORE_SECRET_ACCESS_KEY=<...>
```
（匿名-only 部署可省略 Launch Token 变量；PD-19 默认 signed_user 关闭。）

## 4. 宿主安全要点
- 只信任自己 `allowedOrigins` 内的页面能嵌入；`publicAppId` 可公开但**不能**当授权凭据（数据面逐资源授权按 token scope，不是靠 publicAppId 猜）。
- Origin 校验缺省 fail-closed：无 Origin / 非白名单 → 403。
- 不把 visitorId/Token 写日志（服务端已脱敏，宿主侧同理）。
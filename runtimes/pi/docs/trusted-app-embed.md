# 受信任系统嵌入登录

适用于客服工单等已在自己后端完成用户登录的宿主系统。Debussy 的 Agent 发布模式选择「受信任系统」，填写宿主页面 Origin。发布后在同一抽屉中为宿主系统签发 Client ID 和 Client Secret。Secret 只显示一次，应保存在宿主**后端**，不能放进浏览器代码。

## 请求流程

1. 宿主后端确认当前登录用户，调用 Debussy `POST /api/embed/v1/auth/exchange`：

   ```http
   Authorization: Bearer ta_<client_id_uuid>.<client_secret>
   Content-Type: application/json

   {"publicAppId":"pub_<uuid>","origin":"https://ticket.example.com","userId":"123","name":"张三","roles":["customer_service"]}
   ```

   响应 `data.code` 是 60 秒有效的一次性随机凭据。宿主后端只把该 code 交给当前登录用户的页面。Debussy 不相信浏览器直接提交的 `userId`。

2. 宿主页面打开已发布的 `/embed/<publicAppId>` iframe。iframe 的 `load` 事件后，用明确的 Debussy Origin 发送：

   ```js
   iframe.contentWindow.postMessage({
     protocol: "skdy-embed",
     version: 1,
     type: "init",
     payload: { exchangeCode: code },
   }, new URL(iframe.src).origin);
   ```

   code 不放入 iframe URL。每次重新打开或 Debussy 短期访问令牌过期，宿主后端都应重新调用 exchange，不能重发旧 code。宿主页面应校验 iframe 回信的 `event.source` 和 `event.origin`。

3. iframe 校验消息的来源窗口、Origin 和协议格式后调用 `POST /api/embed/v1/auth/consume`。Debussy 用 Redis 原子 `GETDEL` 消费 code，检查发布 Agent、受信任系统状态和 Origin，建立 `external_user` Principal 并返回现有短期 Embed Access Token。iframe 只在内存中保存该 token，不依赖第三方 Cookie。

`userId` 按受信任系统和已发布 Agent 隔离并哈希后映射到 Principal。`name` 和 `roles` 存入身份资料，当前不作为 Debussy 管理权限或 MCP 服务用户权限。MCP 仍按自身连接令牌授权。

每张新访问令牌首次对话时，Debussy 按已认证 Principal 从服务端读取宿主系统名称、`name` 和 `roles`；同一令牌的后续对话复用该资料，并在每轮作为服务端身份上下文附加到 system prompt。Agent 因而可以回答当前工单登录用户的姓名和角色；原始 `userId` 不传给模型。宿主身份资料不可由浏览器聊天消息指定。

## 管理接口

管理员令牌调用 `GET /api/admin/v1/trusted-apps` 列出受信任系统；`POST` 创建；`PATCH` 的 `rotate`、`enable`、`disable` 操作可重新生成密钥或启停。重新生成后的 Secret 同样只显示一次。发布及管理受信任系统都不需要修改 issuer allowlist 或重启 Debussy；部署包含本功能的新代码和数据库迁移时仍需正常更新服务。

宿主后端到 Debussy 使用 HTTPS 或可信内网。每个宿主系统使用独立 Secret。Debussy 禁用系统后不再接受其密钥或尚未消费的 code。匿名和旧签名 Embed 发布继续可用。

宿主页面来源可以使用 HTTP 或 HTTPS，例如 `http://10.113.114.88:8003`。地址必须是完整 Origin（协议、主机、可选端口，不含路径），并分别加入 Agent 发布配置和受信任系统配置。生产环境建议使用 HTTPS。

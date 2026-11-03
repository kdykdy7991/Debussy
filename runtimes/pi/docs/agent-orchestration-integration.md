# 后台 Agent 编排接入

当前对外接入范围已收敛为两个 API，交付接入方使用 [Agent 任务 API 接入说明](./aaas-api-integration.md)。模型/思考/MCP 均由平台内部配置，外部配置页不再作为接入要求；本文其余配置及旧事件流程内容仅作平台运维与实现参考，不向项目方签发配置授权。

首期用于告警研判：工单系统后端提交事件，平台后台执行，工单系统查询并展示报告。接口不依赖 iframe、WebSocket 或用户姓名。

## 管理员准备

1. 创建专用 Agent，配置分析提示词、模型、思考参数及 MCP Tool allowlist，然后发布。
2. 控制台进入「Agent 编排 → 新建接入」，按名称选择已发布 Agent，再选择允许工单端使用的模型，无需手填应用或模型 ID。
3. 如工具需要每用户业务密钥，在「工具授权 → 批量配置」中选择 MCP 服务、工具中的密钥参数和请求凭据名称。选择参数后默认全选支持它的已发布工具，也可取消勾选个别工具，点击「应用到 N 个工具」。例如 32 个工具的 `auth_token` 都映射到 `ticketApiKey`，工单端仍只需传一次 `credentials: {"ticketApiKey":"本次用户密钥"}`。不支持该参数的工具不会绑定；重复应用更新相同工具参数的映射，其他映射保留。展开「逐条查看与调整」可设置个别例外，亦可单独添加。新增发布工具需重新选择授权，不会自动加入。
4. 保存签发的 `oi_<integrationId>.<secret>`，交给工单后端保管。后续读取不会回显，可以停用、启用或轮换。

平台需要启用 publishing 并配置已有的 MCP Secret Master Key，后台服务使用不同的加密命名空间保存工作凭据。迁移由服务启动时执行。尚未配置 Master Key 时不挂载编排 API；控制台会显示真实加载错误。

开发环境更新后端代码后需要重启开发服务；当前启动脚本不自动重载后端。若新建接入的选项显示“接口不存在”，先核对前端代理指向的后端是否已加载新增 catalog 路由。

首期同一租户只允许一个活动编排调度进程，数据库独占锁强制约束。每进程最多同时执行 2 个工作项，同一工作项串行，每个接入最多排队 1000 次派工，默认排队超时 1 小时，执行超时 120 秒。

模型标识与控制台 Agent 编辑器一致。建议使用专用 Agent，工单配置更新会创建它的新 Revision，但只有该接入的生效发布版本指针更新；不会自动切换普通会话页的当前发布版本。

控制台按「分析工作项 / 接入系统」分开管理，支持搜索、状态及接入来源筛选，每 5 秒更新可见页面。工作项详情展示报告与执行记录；取消、重试和重新签发凭据均需确认。分析配置按真实模型能力展示思考选项，冲突时保留草稿并提示重新加载。一次性接入凭据可复制，关闭后不再显示。

选项来自管理员专用的 `GET /api/admin/v1/orchestration/catalog`，只提供同租户有效发布 Agent、可用模型及其能力、工具和可绑定的参数名称，不回传完整工具 Schema、默认值或认证内容。此接口使用管理员认证，工单业务后端仍使用下面的业务接口。

## 执行凭据与配置凭据

- 接入 Token（`oi_`）：标识工单系统，调用 Run 和 events/work-items API，保存在工单后端；不随用户登录切换，不具备配置权限。
- Tool API key：由工单系统为每次请求提供，仅在指定工具实际调用时注入；平台不维护用户名对应关系。
- 配置授权凭据（`oc_`）：管理员独立签发给外部后端，只能交换配置页入口。查看、编辑和发布分别授权；不能执行 Run。
- 配置网页会话（`cfgs_`）：通过单次入口 code 换取，只能访问本接入的配置 API，15 分钟有效，仅放网页内存。

两者不得放入 URL、前端持久存储或告警正文。业务接口仅供后端调用，不开放 CORS。使用 HTTPS 或可信内网传输。

执行接口使用 `Authorization: Bearer <接入 Token>`、`Content-Type: application/json`；配置接口的认证单独说明如下。成功返回 `{data,requestId}`；失败返回 `{error:{code,message,requestId,retryable}}`。

## AaaS 最小 Run 接口

需要“一次提交、一个终态、一个结果”的调用方使用以下两个接口，沿用本页的 Integration Token。现有 events/work-items 接口继续供补充式工单流程使用。

`POST /api/aaas/v1/integrations/<integration_id>/runs`

请求头除 Authorization 和 Content-Type 外，必须提供 `Idempotency-Key: <唯一请求标识>`（1～200 字符）。路径的 integration_id 必须与 Token 对应。

```json
{
  "prompt": "你是告警分析助手。查询工单 TK001 的相关证据，分析原因，并按本项目要求输出结果。",
  "external_ref": {"type": "ticket", "id": "TK001"},
  "credentials": {"authToken": "本次授权的服务或用户工具密钥"}
}
```

`prompt` 必须是非空白字符串，最长 48,000 字符，原样作为本次 Run 的业务系统提示词，替换已发布 Agent 的默认业务提示词。请在其中写明完整任务指令、业务信息及输出要求，不再提交 input/content 对象。`external_ref` 仅作业务关联，可省略，不会自动拼进 prompt；省略时内部使用幂等标识关联。凭据名称与接入映射一致，不要求用户身份。无需传 credential_expires_at，平台内部默认授权 30 分钟，幂等重投不刷新有效期；下游密钥自己的有效期仍由对方决定。无映射工具可省略 credentials。

本次覆盖随 Run 固定保存，不修改配置草稿或发布版本，不影响其他任务和聊天。模型、思考参数、MCP 工具/Skill 及授权仍来自启动时冻结的发布版本；运行时原有工具资源使用说明继续生效。`agent_version` 表示这些基础配置的版本，任务 prompt 是另行冻结的执行覆盖值。旧 input 格式的新请求返回 400，历史已接受任务保持原语义。

返回 202：`{"data":{"run_id":"UUID","status":"queued","duplicate":false},"requestId":"..."}`。幂等重投使用完全相同的请求与键；返回同一 Run 的当前状态，可能已经 completed。不同内容或凭据重用键返回 409。此键与现有 eventId 共用接入内唯一性范围，建议调用方为两类请求使用不同的标识前缀。

`GET /api/aaas/v1/runs/<run_id>` 返回：

```json
{
  "data": {
    "run_id": "UUID",
    "integration_id": "UUID",
    "agent_version": "pav_UUID",
    "configuration_revision": 1,
    "status": "completed",
    "result": "模型的最终原文输出，格式由接入方提示词决定。",
    "error": null,
    "created_at": "ISO 时间",
    "started_at": "ISO 时间或 null",
    "completed_at": "ISO 时间或 null"
  },
  "requestId": "..."
}
```

状态为 queued/running/completed/failed/cancelled；失败时 error 为 `{code}`，超时表现为 failed 加 EXECUTION_TIMEOUT 或 QUEUE_TIMEOUT。`result` 为模型最终输出的字符串，保留原文、Markdown 围栏、换行及首尾空白；平台不追加固定报告提示、不解析 JSON、不校验五字段结构。若提示词要求 JSON，返回的仍是 JSON 文本字符串，由接入方按需解析。成功空输出为 `""`；未成功时为 null。查询仅返回本接入的 AaaS 来源任务，不包含 Conversation、Turn 或凭据。

2026-11-03 输出契约调整：原固定 AnalysisReport 已取消，旧调用方请移除对 `result.summary` 等字段的依赖。历史已存的结构化报告通过迁移保留为 JSON 文本；新执行的最终输出原样存取。业务内容正确性由提示词与模型决定，工具授权和凭据保护继续生效。

每次主动重新分析使用新幂等键，产生新 Run；不接受 workItemId，不提供补充/retry API。AaaS 工作即使通过旧业务或管理员 retry 路径也返回 409 RUN_IMMUTABLE。旧取消入口可停止仍在运行的任务，但不能把已经终态的 AaaS 任务改为 cancelled。Run 只查询首次派工的结果，不借用其他执行的历史报告。

## 外部配置页：保存草稿与发布分离

迁移提示：旧业务 `GET/PUT /api/orchestration/v1/configuration` 使用接入 Token 现在返回 403。原管理员 `GET/PUT /api/admin/v1/orchestration/integrations/<id>/configuration` 保留“保存即生效”，只供内部控制台使用；外部项目必须使用独立配置授权。

### 管理员签发授权

以下接口使用管理员认证，不能把管理员 Token 交给外部项目。本阶段通过 API 配置授权，控制台尚未增加授权管理表单。

`POST /api/admin/v1/orchestration/integrations/<id>/configuration-grants`：

```json
{
  "name": "工单项目配置编辑者",
  "permissions": ["config.view", "config.edit"],
  "editable_fields": ["systemPrompt", "modelId", "parameters", "mcpServerIds"],
  "allowed_origins": ["https://tickets.example.com"]
}
```

返回 `{id, credential}`，`credential` 为一次性回显的 `oc_<授权ID>.<secret>`。交给外部后端保管，不能发送给网页。`GET` 同一路径列出安全授权信息，包括 revision，不回显密钥。`PATCH .../configuration-grants/<授权ID>` 使用 `{"expected_revision":1,"enabled":false}` 撤权，或 `{"expected_revision":1,"rotate":true}` 轮换凭据；也可传完整 `policy` 更新上述策略。任意更新会递增授权 revision，使已发出的 code/session 立即失效。

`config.view` 必需；`config.edit` 和 `config.publish` 独立。可为发布者单独签发 `["config.view","config.publish"]`，不授予编辑权。字段 allowlist 同时约束编辑与发布：发布者不能发布涉及其未获准字段的修改。聊天嵌入权限与以上授权互不推导。

MCP 选择限授权时冻结的已发布服务、版本及工具集合；不允许网页新增服务器、修改地址或连接密钥。管理员更新 policy 时重新捕获当前生效版本的可选集合。工具业务凭据映射仍由管理员维护，选择 MCP 不会自动修改这些映射。

### 外部后端生成入口

外部项目先校验当前操作者在本项目的权限，再由后端选取对应的配置授权：

`POST /api/aaas/v1/configuration/exchange`，认证 `Bearer <oc_配置授权凭据>`：

```json
{"integration_id":"接入UUID","origin":"https://tickets.example.com"}
```

Origin 必须与管理员允许的严格来源一致（协议、域名和端口，不带路径或尾部斜杠）。返回 `{code, expires_in:60, page_path}`，外部网页把“平台地址 + page_path”作为 iframe src；也可打开独立页。页面由平台后端直接提供，例如本机 `http://127.0.0.1:8768/aaas/integrations/<id>/configuration#code=...`，无需加载管理员控制台。

页面立即清除 URL fragment，用 `POST /api/aaas/v1/configuration/consume`、请求体 `{"code":"cfgc_..."}` 消费单次 code，获得 `{access_token,integration_id,expires_in:900}`。后续同源请求使用 `Bearer <cfgs_会话>`；不写入持久存储。code 过期、重复消费或授权撤销返回 401；刷新页面需从外部后端重新获取入口。框架嵌入由 CSP 限制为允许的来源。以上来源校验不能代替外部后端对人的权限校验。

### 配置接口契约

`GET /api/aaas/v1/integrations/<id>/configuration` 返回：

```json
{
  "published_version": "pav_当前版本UUID",
  "published": {"systemPrompt":"当前提示词","modelId":"模型ID","parameters":{},"mcpServerIds":[]},
  "draft": {"revision":0,"base_version":"pav_当前版本UUID","configuration":{"systemPrompt":"当前提示词","modelId":"模型ID","parameters":{},"mcpServerIds":[]}},
  "editable_fields": ["systemPrompt","modelId","parameters"],
  "permissions": {"view":true,"edit":true,"publish":false},
  "options": {"models":[],"mcpServers":[]}
}
```

同时返回 `integration_id` 和 `name`。`options` 提供实际模型能力及安全 MCP 名称/工具名称，不包含服务器地址、完整 Schema 或密钥。尚无草稿时 revision 为 0，读取不会创建草稿。

`PUT /api/aaas/v1/integrations/<id>/draft`，需 edit 权限：

```json
{"expected_draft_revision":0,"changes":{"systemPrompt":"查询告警证据并明确不确定事项。"}}
```

`changes` 只接受允许字段，模型必须在接入白名单内，参数必须符合模型能力。保存仅递增草稿 revision，不创建正式 Version，不切换 Integration。并发旧请求返回 409 `DRAFT_CONFLICT`，页面保留本地修改，禁止自动覆盖。

`POST /api/aaas/v1/integrations/<id>/publish`，需 publish 权限：

```json
{"expected_draft_revision":1,"expected_active_version":"pav_当前版本UUID"}
```

发布复制指定草稿，复用现有发布编译生成不可变 Revision/Version，成功才原子切换 Integration。成功后草稿 revision 再递增，基线更新为新版本。失败不改变生效指针；编译阶段可能留下未生效的不可变版本记录。新 Run 冻结新版本，已有 Run 保持启动版本；普通聊天发布指针不随之切换。

旧草稿 revision 返回 `DRAFT_CONFLICT`，旧生效版本返回 `ACTIVE_VERSION_CONFLICT`。若内部保存已经改变草稿基线，返回 `DRAFT_BASE_CONFLICT`；需显式核对后重建草稿：同一 PUT draft 接口传 `{"expected_draft_revision":1,"expected_active_version":"pav_新版本UUID","reset":true}`，再编辑。重建也检查字段权限，不允许低权限编辑者借此覆盖其他字段。接口成功均返回更新后的完整配置视图。

## 提交首次分析

`POST /api/orchestration/v1/events`：

```json
{
  "eventId": "alarm-123-created-1",
  "alarmId": "alarm-123",
  "input": "设备 A 于 10:00 开始持续连接超时，请分析原因。",
  "credentials": {"ticketApiKey": "本次分析使用的用户密钥"},
  "credentialExpiresAt": "2026-11-02T10:00:00.000Z"
}
```

示例时间需替换为真实有效期：必须在未来 24 小时以内，且不应超过对方密钥实际有效期；平台不会延长下游 key 的寿命。不需要任务凭据的工具可传 `credentials:{}`，仍需指定工作执行授权的有效期。

返回 `202`：

```json
{"data":{"workItemId":"UUID","duplicate":false},"requestId":"..."}
```

eventId 在接入范围内唯一。完全相同请求重投返回原工作项；不同内容、凭据或有效期重用 eventId 返回 `EVENT_CONFLICT`。工单后端应保留原提交请求的重试信息，不在网络重试时重新生成 eventId。

## 查询结论

- `GET /api/orchestration/v1/work-items/<workItemId>`：当前工作状态、配置版本、派工历史、报告及报告覆盖的 `reportEventId`。
- `GET /api/orchestration/v1/work-items?alarmId=alarm-123`：该接入下该告警的最近工作项，最多 100 个。

建议先每隔 2～5 秒查询一次，并对失败查询退避。状态包括 `queued`、`running`、`succeeded`、`failed`、`cancelled`。任务失败与“成功但证据不足”分开处理。

work-items 的 `report` 及各派工的 `report` 同样返回模型原文字符串或 null；`reportEventId` 表示结果覆盖的输入。展示字符串时按文本处理，不要当作未经处理的 HTML 执行。模型输出格式由发布提示词决定，平台不限制报告字段，也不保证原因判断或引用一定正确。

## 补充、重试与全新分析

- 补充日志/人工追问：提交新的 eventId，同时携带原 `workItemId`、相同 alarmId、本次凭据及有效期。输入在已有执行后串行消费；沿用原配置与 Conversation。
- 用新配置独立重新分析：新的 eventId，不传 workItemId；同一 alarmId 可以对应多个工作项。
- 技术重试：`POST /api/orchestration/v1/work-items/<id>/retry`，请求体 `{}`。仅失败工作项可重试，产生新派工并继续原上下文。过期凭据需通过新补充事件提供，旧凭据不会被自动替换。
- 取消：`POST /api/orchestration/v1/work-items/<id>/cancel`，请求体 `{}`。取消后的迟到结果不能覆盖取消事实，工作项不再接受补充。

报告可能对应较早输入；展示时同时考虑工作状态和 reportEventId，不能把旧报告当成已覆盖刚补充的新日志。

## 恢复及边界

服务重启保留排队输入。已有完整提交的 Turn 可恢复报告；未知中断标记 `EXECUTION_INTERRUPTED`，由业务明确决定是否重试。首期选用只读工具；有副作用的接口需对方提供幂等能力，平台不保证外部操作恰好执行一次。

任务凭据加密暂存至过期，过期清理密文，以支持授权有效期内的显式重试。没有用户名映射仍需遵守对方授权：同一 workItemId 会复用已有上下文，不得交给无权阅读之前结果的另一个用户。需要权限隔离时创建新工作项；后续可增加对方签发的不透明权限范围标识。

控制台只提供管理员访问；外部配置页通过独立授权进入。已完成真实 Qwen/MCP 的 Run 联调和真实配置页只读、撤权验证；草稿编辑及发布使用隔离数据库验收，未在真实业务 Agent 上发布测试配置。部署环境仍应由接入方验证自己的身份校验、iframe 来源及后端凭据保管。

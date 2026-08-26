# Agent 平台 MVP 前端任务

状态：实施中  
创建日期：2026-08-26  
主规格：[Agent 平台 MVP](./agent-platform-mvp-2026-08-26.md)

## 1. 当前生产基线

- Agent 生产入口是 `packages/web/src/admin/pages/agents-page.tsx`，不是 `admin/agents/agent-workspace.tsx`。
- 当前 Agent 页面使用真实 Agent API 和模型目录，但仍有创建入口未接通、静态分页、错误的 Prompt 长度限制和缺少未保存离开提示等差距。
- Skill/MCP 目前没有生产管理页面；旧 Agent 表单中的占位组件不是 MVP 实现。
- 管理员 Chat 与 Embed 已复用结构化消息工作区，必须在此基础上展示真实 Tool 事件。

前端实现和测试必须指向当前生产路由；不得只测试未挂载组件或 UI preview。

## 2. Agent 页面收口

- 接通真实创建 Agent 流程；成功后进入新 Agent 详情。
- 列表搜索、排序、删除和空/错状态基于真实 API。
- 删除无行为的静态页码；需要分页时使用服务端 cursor，不需要时不显示分页控件。
- System Prompt 上限与共享 RuntimeSpec 限制一致。
- 模型使用严格选择器；目录加载失败和当前模型下架状态可辨认。
- Reasoning 只展示模型支持的开关与档位，不提交其他生成参数。
- 保存覆盖 saved、dirty、saving、error；失败保留草稿，保存中禁止重复提交。
- 离开未保存页面时提示；放弃修改恢复服务端最新快照。
- 页面只提供“去 Chat 测试”；发布集中在应用模块。
- 不恢复 Revision、Diff、发布应用和最近调试 Tab。

## 3. Skill 管理

### 3.1 列表和详情

- 列表展示名称、来源、状态、当前 Revision、最近校验结果、更新时间和被引用状态。
- 支持搜索、加载、空状态、错误、无权限和 cursor 分页。
- 详情展示描述、内容摘要、资源清单、诊断和引用它的 Agent 数量；不建设历史 Revision 管理 UI。
- 启停和删除使用明确确认；以服务端响应更新状态，不做乐观伪成功。

### 3.2 导入和更新

- 只接受后端批准的 `SKILL.md` 或 ZIP 类型。
- 上传展示文件名、大小、进度和取消。
- 校验错误按文件路径、错误码和可操作说明展示。
- 前端不解压、不执行、不重新解释 Skill 内容；服务端结果是唯一事实源。
- 导入成功后展示真实 Skill 和 Revision，不生成本地临时假数据。

## 4. MCP 管理

### 4.1 列表和编辑

- 列表展示名称、Transport、启停状态、Secret 是否已配置、Tool 数量、最近测试和最近错误。
- 创建/编辑只渲染批准的 Streamable HTTP 字段，不提供自由 headers 编辑器。
- Secret 输入与普通配置分区；已保存 Secret 永不回显，只显示“已配置/未配置”和“替换”。
- 删除、停用和 Secret 替换使用明确确认。

### 4.2 测试连接和同步 Tools

- 连接测试展示 testing、success、failed、timeout；结果完全来自服务端。
- Tool 同步展示 added、removed、changed，并明确“新增 Tool 不会自动授权”。
- Tool 列表展示名称、描述和 schema 摘要；长 schema 折叠，不默认铺原始 JSON。
- 测试和同步支持失败后重试，但禁止并发重复提交。

## 5. Agent 绑定 Skill/MCP

- Agent 编辑页新增“扩展能力”区域。
- Skill 使用服务端搜索选择器；展示名称、Revision、状态和校验结果，不允许手填 ID。
- MCP 使用服务端选择器；选中 Server 后加载其固定 Revision 和 Tools。
- Tool allowlist 逐项选择，新发现 Tool 默认不选。
- 已停用、缺失、跨租户或有阻断诊断的资源不能保存/发布，并展示服务端原因。
- 保存失败保留 Agent 草稿和选择状态。
- 未被用户修改的 Skill/MCP 绑定在保存时完整保留。
- 页面不提供 Skill/MCP Revision 历史或 Diff。

## 6. 应用发布

- 应用版本创建页展示将冻结的 Agent、模型、Reasoning、Skill 名称/Revision、MCP 名称/Revision 和 Tool allowlist。
- 发布前从服务端获取可发布性校验结果，不在浏览器推断。
- 任何阻断项禁止提交并提供跳转到对应 Agent、Skill 或 MCP 的入口。
- 创建版本成功后明确“尚未激活”；激活和回滚继续在应用详情完成。
- 发布摘要不展示 Secret、内部 UUID 或整块原始 RuntimeSpec JSON。

## 7. Chat 与 Tool 事件

- 管理员 Chat 与 Embed 使用同一 Tool item 组件和事件语义。
- 至少展示 Tool 名称、running/succeeded/failed/cancelled、耗时和安全摘要。
- 默认不展开敏感或超长参数/结果；服务端标记已脱敏或截断时必须显示。
- Tool 失败不伪装为 Assistant 正常成功；同时保持后续可用文本消息结构。
- 停止生成时 UI 进入 cancelling，收到 Runtime 确认后进入 cancelled。
- 断线恢复后的 Tool item 与实时接收时结构一致。

## 8. 前端测试与完成标准

- 测试挂载生产路由和生产组件，不以 preview 或未引用组件代替。
- Agent 覆盖创建、真实加载、模型目录异常、下架模型、保存失败、未保存离开和删除冲突。
- Skill 覆盖成功、空、上传失败、校验失败、无权限、停用和被引用删除冲突。
- MCP 覆盖未配置 Secret、连接成功/失败/超时、同步变更、替换 Secret 和 Tool 默认不授权。
- Agent 绑定覆盖资源加载失败、已停用资源、Tool allowlist、保存失败和数据保留。
- 发布覆盖校验阻断、创建未激活、Skill/MCP 摘要和回滚入口。
- Chat 覆盖 Tool running/success/failure/cancel、断线恢复和管理员/Embed DOM 语义一致。
- Secret、Launch Token、Provider Key 不出现在 DOM、URL、storage、日志或错误上报。
- 桌面管理员工作台完成键盘、焦点、长内容和窄桌面宽度验证；发布 Chat/Embed 按产品兼容范围验收。

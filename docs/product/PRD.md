# 产品需求

## 产品目标

管理员能够在统一工作台内完成 Agent、Skill 和 MCP 的配置、验证、发布和线上排障。

## 一级能力

产品固定包含以下一级模块：

1. **Chat**：使用指定 Agent 与 Revision 进行管理员调试。
2. **Agent 设计**：配置 Agent，并保存不可变 Revision。
3. **Skill**：安全导入、校验和管理可被 Agent 使用的 Skill。
4. **MCP**：配置受控 MCP Server、同步 Tools 并管理 Tool 授权。
5. **发布**：将已保存的 Agent 及其固定 Skill/MCP 能力发布到企业内部网站或局域网应用。
6. **Usage**：查看 Token 用量及其 Agent、来源归属。
7. **Session 日志**：检索和排查已发布应用的企业用户会话与 Tool 调用。
8. **设置**：管理租户、访问、保留策略和 Embed 默认配置。

## 核心流程

```text
导入 Skill ─┐
配置 MCP ───┼→ 设计 Agent → 保存 → Chat 调试 → 发布应用 → 发布 Chat / Embed 使用
            │                                      ↓
            └────────────── Tool 授权 ─────→ Usage / Session 日志
```

## 产品要求

- 管理员进入工作台后默认进入 Chat。
- Chat 必须明确展示连接、加载、空内容、发送失败和附件失败状态。
- Agent 草稿保存为 Revision 后才能进入正式发布流程。
- Revision 是内部不可变快照；MVP 不要求提供 Revision 列表、Diff 或恢复 UI。
- Agent 只能绑定同 Tenant、有效且校验通过的 Skill/MCP；MCP 新发现 Tool 默认不授权。
- 发布操作必须明确目标应用、当前版本，并冻结 Agent、Skill Revision、MCP Revision 和 Tool allowlist。
- Skill、MCP 或 Agent 后续更新不得改变旧 Published App Version 和既有 Conversation。
- MCP Secret 不得回显，也不得进入 RuntimeSpec、消息事件、导出或日志。
- Tool 调用失败、取消和超时必须显示真实状态，不能伪造成 Assistant 成功。
- Usage 必须区分管理员调试和线上用户来源，不由前端估算 Token。
- Session 日志只表示线上企业用户会话，并显示其应用和固定版本来源。
- 未连接、无权限、失败和示例数据必须明确标示。
- 敏感凭据不得出现在 URL、浏览器存储、日志或错误文案中。
- 管理员工作台当前以电脑浏览器使用为主；发布给内部成员使用的独立对话页和 Embed Chat 必须支持手机浏览器的响应式布局与触控交互。
- 发布对话页/Embed Chat 与管理员 Chat 使用同一消息体验：思考过程、逐增量正文、工具轨迹、Agent 状态和错误终态不得因入口不同而降级；只允许按权限隐藏不适用的控制模块。

## 验收原则

- 用户能够辨认当前租户、对象、数据范围和连接状态。
- 用户能够沿 Agent、Skill、MCP、发布应用、Usage 和 Session 日志之间的对象关系完成任务。
- 发布动作可验证、可审计、可回滚。
- 用户能够证明发布版本只调用 allowlist 中的 Tool，且旧版本不因 Skill/MCP 更新而漂移。
- 管理员调试数据与企业终端用户数据在语义和权限上保持隔离。
- 终端用户能够在电脑和手机浏览器中完成进入会话、阅读消息、输入、发送、失败重试及适用的附件操作，不因屏幕尺寸或虚拟键盘遮挡核心操作。
- 使用同一组结构化 transcript fixture 时，管理员 Chat 与发布 Chat 的消息区产生等价 DOM；真实模型验收必须观察到多帧正文增量，并在模型提供 reasoning 时观察到思考过程。

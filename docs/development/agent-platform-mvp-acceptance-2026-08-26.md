# Agent 平台 MVP 验收与检查清单

状态：实施中  
创建日期：2026-08-26  
主规格：[Agent 平台 MVP](./agent-platform-mvp-2026-08-26.md)

## 1. 使用规则

- `[x]` 只表示有当前候选提交上的可复核证据，不表示历史分支曾经实现过。
- 协议、占位页面、Mock、未挂载组件和计划文档不算功能完成。
- 每项证据至少记录提交、命令/步骤、结果和遗留风险。
- P0 项全部通过后，产品负责人才能批准内部 MVP。

## 2. 当前基线确认

- [x] Agent 列表和详情生产入口读取真实 Control API。
- [x] Agent 保存生成不可变 Revision，Published App Version 可固定配置。
- [x] 应用支持创建版本、激活、暂停和回滚基础能力。
- [x] 管理员 Chat 与发布 Chat/Embed 共享结构化消息视图基础。
- [x] 发布 Realtime 支持真实正文/思考增量、停止和恢复基础。
- [x] Skill parser/诊断和 RuntimeSpec 的 capability 槽位可复用。
- [x] Skill/MCP 管理 DTO 有历史草案可参考。
- [ ] 当前发布 Runtime 支持非空 Skill/MCP 能力。备注：目前 chat-only 门禁明确拒绝。
- [ ] Skill/MCP 有真实管理 API、持久化和生产 UI。
- [ ] Skill/MCP 已完成同一候选版本的真实 E2E。

## 3. Agent 主链路

- [ ] 创建 Agent 使用真实 API，成功后可立即编辑。
- [ ] 列表不存在无行为分页、创建、发布或成功控件。
- [ ] Prompt 上限与 RuntimeSpec 一致。
- [ ] 模型目录正常、失败和当前模型下架均有测试。
- [ ] Reasoning 仅允许模型支持字段和档位。
- [ ] 保存成功、失败、重复提交、放弃和未保存离开均验证。
- [ ] 删除未引用 Agent 成功；有关联应用时明确拒绝。
- [ ] Agent 页面不包含 Revision/Diff/发布应用/最近调试管理 UI。

## 4. Skill

- [ ] 单个合法 `SKILL.md` 导入成功。
- [ ] 合法 ZIP 与允许资源导入成功。
- [ ] frontmatter、名称、描述和资源诊断与 coding-agent parser 一致。
- [ ] 路径穿越、绝对路径、符号链接、硬链接、超限、压缩炸弹和不允许文件被拒绝。
- [ ] 导入失败不留下半成品记录或孤立 artifact。
- [ ] Skill 更新生成新 Revision，旧 Revision 不变。
- [ ] Agent 只能选择同租户、启用且校验通过的 Skill Revision。
- [ ] 发布版本固定 Skill Revision；Skill 更新/停用后旧版本不漂移。
- [ ] Runtime 真实注入固定 Skill 指令并计入上下文快照。
- [ ] Skill 关闭开关后纯文本 Agent 可发布和对话。

## 5. MCP

- [ ] Streamable HTTP 客户端/SDK 最小原型和依赖安全评审完成。
- [ ] 创建 MCP Server 不接受自由 headers 或 URL 内凭据。
- [ ] Secret 创建、替换和删除成功；任何读取均不回显。
- [ ] 连接测试覆盖成功、鉴权失败、超时、断连和非法响应。
- [ ] Tool discovery 保存名称、描述、schema 和 hash。
- [ ] Tool 同步正确报告 added、removed、changed。
- [ ] 新发现 Tool 默认不进入任何已有 allowlist。
- [ ] Agent 只能绑定同租户、启用且配置完整的 MCP Revision。
- [ ] 发布版本固定 MCP Revision 和 Tool allowlist。
- [ ] Runtime 只能调用 allowlist Tool，未授权调用被拒绝并审计。
- [ ] 超时、取消、断连和超大结果释放全部资源且不污染下一回合。
- [ ] SSRF、重定向绕过、DNS rebinding 候选、私网/metadata 地址和非法端口被拒绝。
- [ ] Secret 不出现在 API、RuntimeSpec、DOM、事件、日志、导出和测试快照。
- [ ] MCP 关闭开关后纯文本 Agent 可发布和对话。

## 6. 发布、Chat 与 Embed

- [ ] 发布前校验 Agent、Skill、MCP、Tool 和 Secret 状态。
- [ ] 创建版本成功后保持未激活，显式激活后才对新会话生效。
- [ ] Agent/Skill/MCP 更新后旧 Published App Version 不漂移。
- [ ] 回滚后新会话使用目标版本，既有 Conversation 保持固定版本。
- [ ] 管理员 Chat 使用 Skill 并完成真实 MCP Tool 调用。
- [ ] 发布 Chat/Embed 使用同一版本完成相同 Tool 调用。
- [ ] Tool running/succeeded/failed/cancelled 在两个入口语义一致。
- [ ] 停止生成同时取消模型和 MCP 调用。
- [ ] 刷新和断线恢复后正文、思考和 Tool item 不丢失、不重复。
- [ ] MCP 故障时文本事件顺序正确，UI 不显示伪造成功。

## 7. 安全、隔离与恢复

- [ ] Tenant A 不能读取、绑定、测试或调用 Tenant B 的 Skill/MCP。
- [ ] 管理员凭据与终端用户 Token 继续使用不同信任链路。
- [ ] Tool 参数/结果、用户文本和 Secret 的日志策略通过脱敏测试。
- [ ] 删除/停用主体不破坏被发布版本引用的不可变快照。
- [ ] 数据库备份包含 Agent、Skill、MCP、绑定、应用版本、会话和审计关系。
- [ ] Secret store 有独立备份/恢复或重新配置流程。
- [ ] 在当前机器和备份介质可用的前提下完成一次恢复演练。
- [ ] 完成应用版本回滚和 Skill/MCP 功能开关降级演练。

## 8. 容量与兼容性

- [ ] 20 个同时进行的文本对话可用。
- [ ] 30 个同时在途轮次自动化门禁通过。
- [ ] 并发 Tool 调用受限且不会耗尽 socket、promise 或 Runtime 槽位。
- [ ] 管理员工作台在最新版稳定版桌面 Chrome/Chromium 通过主链路。
- [ ] 发布 Chat/Embed 在最新版稳定版桌面 Chrome、真实 Android Chrome 和真实 iOS Safari 通过核心流程。
- [ ] 至少验证独立发布页和两个不同 Embed 宿主页。

## 9. 自动化命令

从 `runtimes/pi` 执行：

```bash
npm run check
./test.sh
bash scripts/verify-publishing-mvp.sh
bash scripts/verify-publishing-browser.sh
```

Skill/MCP 实现必须另外提供可独立运行的定向测试命令；测试使用隔离临时目录、测试数据库、fake model 和本地受控 MCP Server，不读取个人 Skill、凭据或真实付费 Provider。

## 10. 最终真实 E2E

```text
1. 导入含一个允许资源的 Skill。
2. 创建带测试 Secret 的 Streamable HTTP MCP Server。
3. 测试连接并同步至少两个 Tools。
4. 创建 Agent，绑定 Skill，只允许其中一个 Tool。
5. 在管理员 Chat 验证 Skill 生效、允许 Tool 成功、未允许 Tool 不可调用。
6. 创建 Published App Version，核对冻结摘要后激活。
7. 从发布页和 Embed 完成真实对话与 Tool 调用。
8. 更新 Skill、MCP 配置和 Tool schema，证明旧版本/旧会话不漂移。
9. 发布新版本并激活，再回滚到旧版本。
10. 模拟 MCP 超时和断连，确认取消、错误、审计和纯文本降级。
11. 执行备份恢复，核对所有版本、绑定、会话和 Secret 重新配置状态。
```

## 11. 签核记录

```text
候选提交：
环境与开关：
数据库迁移：
自动化结果：
真实模型与 MCP Server：
浏览器与设备：
容量结果：
安全与隔离：
备份恢复与回滚：
已知问题：
P1 风险接受（如有）：
结论：通过 / 有条件通过 / 不通过
批准人：
日期：
```

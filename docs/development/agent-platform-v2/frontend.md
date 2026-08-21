# 前端任务单：Agent 平台 V2

状态：可开发

负责人：前端工程师

创建日期：2026-08-21

## 1. 开始前必须掌握

按顺序阅读：

1. [产品主流程](../../product/PRD.md) 与 [稳定技术边界](../../product/TECHNICAL.md)；
2. `runtimes/pi/packages/web/src/admin`：管理端路由、API client、页面状态与样式；
3. `runtimes/pi/packages/web/src/embed`：独立 Embed 构建、鉴权、会话和 postMessage；
4. `runtimes/pi/packages/web/src/admin/apps/app-detail.tsx`：当前 iframe/SDK 示例；
5. `runtimes/pi/packages/protocol` 中控制台 DTO；不得在组件内复制一套相似类型；
6. 总计划中的统计口径，特别是 TTFT 不含 thinking、tokens/s 不含 TTFT、`null` 不等于 0。
7. AI 层的 Provider 能力差异：字段缺省是 Provider 默认，不支持和未配置是两个不同状态。

必须理解管理员凭据与 Embed 终端用户凭据是两条信任链；浏览器不能获得 MCP Secret，也不能直接连接私有 MCP Server。

## 2. 执行步骤

### FE-0：页面骨架与 Fixture

- 基于后端冻结 DTO 建 fixture，不使用散落在组件中的硬编码数字。
- 为会话详情增加“上下文”和“性能”区域；覆盖加载、无旧数据、部分数据、失败和无权限。
- 为 Skill、MCP 增加路由和导航骨架；没有权限时不展示可写操作，同时仍处理服务端 403。
- 在 Agent 编辑页建立“模型生成参数”区域 fixture，只消费模型目录返回的能力和约束，不在组件里硬编码所有模型范围。
- 所有 mock 通过一个可删除的数据适配层进入页面，真实接口接入后删除该层。

### FE-1：会话统计与 Embed SDK

- 上下文展示：已用/总量/剩余、百分比、exact/estimated 标签和各来源分项。
- 性能展示：会话输入/输出 Token、平均 TTFT、平均 tokens/s、完整耗时、样本数；逐轮明细可定位异常。
- 失败/取消回合不得作为 0 混入图表；旧会话明确显示“该会话创建时尚未采集”。
- 将内部 Embed SDK 拆为仓库正式 package，API、包名与控制台代码示例保持一致。
- SDK 支持 mount/destroy、ready/error/conversation-created/resize、origin 校验；Launch Token 不持久化。
- 增加 iframe 和 SDK 的浏览器集成测试，验证多实例、卸载、错误 origin 和 Token 不落盘。

### FE-1B：模型生成参数

- 在控制台 Agent 编辑页仅渲染模型支持的思考开关和 `reasoningEffort` 低/中/高档位。
- Temperature、Top P、Top K、Penalty、Token 上限、Seed、Stop Sequences 等生成参数不进入表单；界面说明它们由服务端代码固定。
- reasoning 设置进入现有 dirty/save Revision/diff/publish 流程；发布确认页只展示可配置的思考设置。
- 管理员 Chat 和 Embed Chat 不增加其他参数控件，也不从 URL、localStorage 或 SDK 接受这些覆盖。
- 对话框现有“思考强度”对应 `reasoningEffort`：初始继承 Agent Revision 默认，用户选择后成为当前会话覆盖；刷新/重连可恢复，但不修改 Agent Revision。

### FE-2：Skill 管理

- Skill 列表：状态、版本、来源、最近校验结果和被哪些 Agent 使用。
- Skill 详情：只读查看内容/资源、诊断、版本历史；按权限提供导入、更新、启停。
- Agent 编辑页从手填 `knowledgeBaseIds` 改为可搜索的 Skill Revision 选择器。
- 发布确认页显示将被冻结的 Skill 名称、版本和 hash；缺失或校验失败时阻止发布并显示服务端原因。
- 上传/导入展示大小、格式、安全校验错误，不在浏览器执行 Skill 内容。

### FE-3：MCP 管理

- MCP 列表：Transport、启停、健康、最后同步、Tool 数量和最近错误。
- 创建/编辑：普通配置与 Secret 输入分开；编辑详情永不回显 Secret，只允许替换。
- 提供“测试连接”和“同步 Tools”，显示进行中、超时、部分失败和明确错误。
- Agent 编辑页支持选择 MCP Revision 和 Tool allowlist，默认不全选新发现 Tool。
- 发布确认页展示固定 Revision 与 Tool 列表；运行中 schema 漂移只报警，不静默扩大能力。

### FE-4：收口

- 删除 `tokenTotal`、`avgResponseMs` 等占位/兜底业务数字。
- 完成键盘操作、焦点、窄屏、长 Tool 名、长错误信息和空列表验证。
- 对危险操作增加明确确认，但不在前端伪造成功；以服务端响应为准更新状态。

## 3. 前端完成标准

- 页面刷新后数据来自服务端，状态不依赖组件内存或 mock。
- exact/estimated、0/null、成功/失败/取消在视觉和计算上均不混淆。
- 未配置、模型默认、不支持、校验失败四种思考状态不混淆。
- 浏览器保存 Revision 和对话请求都只能提交合法的 reasoning 设置；不得提交或透传其他生成参数。
- Secret 不出现在 DOM、URL、localStorage/sessionStorage、前端日志或错误上报中。
- SDK 示例复制后可在最小 HTML 页面运行，实际导出名称与文档一致。
- Skill/MCP 的版本、绑定和发布结果能从 UI 追溯，不能只显示裸 ID。
- 每个新页面至少有成功、空态、错误、权限和交互测试。

## 4. 与后端的联调约定

- DTO 未冻结前只做页面骨架，不自行决定字段含义。
- 后端 fixture 到达后替换本地 fixture，并由同一组期望验证 mock 与真实 API。
- 接口缺字段时提契约问题，不通过前端重新计算 Token 或用 `Date.now()` 猜服务端 TTFT。
- 每个里程碑至少安排一次真实浏览器联调，并把请求 ID、会话 ID 和失败截图/日志交给架构师验收。

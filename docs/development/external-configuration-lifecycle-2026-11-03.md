# 外部配置生命周期与授权入口

状态：已完成。创建日期：2026-11-03。接入契约已回写 [编排接入说明](../../runtimes/pi/docs/agent-orchestration-integration.md)。

后续产品范围已收敛：当前项目只交付下发/查询任务两个 API，模型和思考等由平台内部配置；外部配置页不再作为接入方案。本文保留实现记录，当前接入测试配置授权撤销、8080 页面入口移除。当前对外契约见 [双 API 说明](../../runtimes/pi/docs/aaas-api-integration.md)。

## 已确认范围

复用现有 Integration、Agent Revision、PublishedAppVersion 和编译器；新增外部 Draft、独立配置授权及短期网页会话。Run、Runtime、Dispatcher 不改。内部保存即生效保留，和外部发布均锁定同一 Integration 生效指针。

GET `/api/aaas/v1/integrations/:id/configuration` 查看发布配置、草稿、权限、可编辑字段与安全选项。PUT `.../draft` 必须携带 expected_draft_revision，仅保存允许字段，不生成 Agent Revision、不切换生效版本。POST `.../publish` 同时校验 expected_draft_revision 和 expected_active_version，从该草稿副本创建不可变 Revision/Version，成功后在持锁事务内切换 Integration 指针。失败保持原指针。

草稿基于明确的生效版本；内部保存导致基线过期时发布拒绝，编辑者可使用同一个 PUT draft 接口显式 reset 到当前版本（同样校验草稿及生效版本），再编辑。发布成功后递增草稿 revision、更新基线，防止重复发布旧草稿。

## 授权及字段

不扩展聊天凭据权限，也不复用 Run Token 作配置认证。管理员为 Integration 创建可撤销配置授权（独立 oc_ 凭据，只交外部后端），明确 config.view、config.edit、config.publish 和字段 allowlist。支持多个授权分别交给查看者、编辑者、发布者。编辑/发布要求具备 view；发布仍独立于 edit。只开放 systemPrompt、modelId、parameters、mcpServerIds；模型限现有白名单；MCP 限管理员授权时冻结的已发布服务与工具集合，仅选择，不开放连接密钥、endpoint、执行参数或系统 tool policy。

外部后端用配置凭据 exchange 获取 60 秒单次 code；网页消费 code 后获得 15 分钟配置 session，只放内存。来源为管理员允许的严格 Origin。授权停用/变更立刻撤销旧 code/session，所有修改在 Integration 锁内重新校验权限和字段。配置会话不能调用 Run、旧保存即生效或管理员 API。

新增迁移维护草稿、配置授权、短期 code/session；过期记录在签发时清理。凭据只存 hash。专用配置页由后端提供，使用同源 API，不引入管理员控制台权限；页面分开保存和发布，并展示冲突与生效范围。管理端提供授权 CRUD API，沿用管理员鉴权。

## 复用依据及验收

已检查 OrchestrationService.saveConfiguration、ControlService.saveAgentRevision/createPublishedAppVersion、Trusted Embed 身份交换及 Postgres 事务。直接复用发布底层；聊天 TrustedApp 的 accessMode 与身份交换面向聊天，因此本阶段单独授予配置能力，避免为配置修改既有聊天模式。新增权限、草稿和短期会话是现有模块缺口，不新增外部依赖。

隔离 Postgres 验证 revision CAS、双重发布 CAS、并发发布、失败不切指针、不可变快照、旧内部保存导致外部冲突、新旧 Run 冻结、权限与字段越权、跨 Integration、code 单次消费、过期和撤权。浏览器验证查看/编辑/发布权限、草稿保留、冲突及 URL 不保留 code。检查和基线问题单独记录；不修改真实业务 Agent 发布配置作测试。

## 实施与验收记录（2026-11-03）

- 迁移 `0024_external_configuration.sql` 新增授权、草稿和短期会话。`configuration-service/http/page.ts` 实现独立入口、生命周期及可嵌入页，复用 `OrchestrationService.prepareConfigurationVersion` 和原发布底层；Run、Runtime、Dispatcher 执行逻辑未改动。
- 原业务配置接口已拒绝 Integration use Token，避免绕过独立配置权限；管理员原保存即生效接口保留。此迁移行为已记录在接入说明及 server Breaking Changes。
- 6 个服务端专项文件共 **55 项通过**（编排、AaaS、外部配置生命周期和 MCP runtime tool）；外部配置新增 **12 项**隔离 Postgres 集成测试。另有控制台 API **3 项通过**，合计 **58 项**。数据库测试使用随机 schema，结束后清理，不写真实业务配置。
- 实际配置页脚本在 Chromium 的模拟 API 环境通过：查看/编辑/发布分权、字段禁用、409 保留本地修改、草稿 CAS、双重发布 CAS、保存不发布、640px 布局、提示词 HTML 不执行、code 单次消费及 URL 清除、无持久化 token。
- 当前真实服务 `8768` 已加载迁移和新路由。临时只读授权验证读取真实 Qwen 模型及智慧工单 MCP（36 个工具）、单次 code、立即撤权和旧配置接口 403；结束已停用临时授权。Integration 版本/修订及既有 AaaS Run 查询前后完全一致，浏览器无脚本错误。没有真实业务草稿修改、发布或新增模型调用。
- 本次涉及的 19 个服务端/协议/测试文件 Biome 检查通过，web 类型检查通过；依赖固定、相对导入、shrinkwrap、install lock 和 browser smoke 检查通过。`git diff --check` 通过。
- 全仓 `npm run check` 仍阻塞于既有 **16 errors / 16 warnings / 4 infos**，涉及旧语音、上下文恢复及管理页等。单独全仓 tsgo 仍为既有 **9 项诊断**（citation_snapshot 类型、debug 测试夹具及缺失 realtimeVoice）；无新增外部配置诊断。不宣称全仓检查通过，不顺带修改基线问题。

## 当前限制

授权管理本阶段通过管理员 API，尚无控制台授权表单。网页不保存配置 session，刷新需由接入方后端重新交换入口；接入方负责校验本项目操作者权限。MCP 只能选择授权时冻结的现有服务及工具，不新增服务器或修改业务凭据映射。

发布底层沿用既有独立 Revision/Version 写入事务，编译或外层提交失败可能保留未生效的版本记录；Integration 指针和草稿更新仍一起提交或回滚。真实业务发布未作为验收操作，完整编辑发布闭环已在隔离数据库验证。

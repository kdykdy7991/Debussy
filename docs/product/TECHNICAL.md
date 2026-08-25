# 稳定技术边界

本文只描述产品依赖的稳定系统边界，不记录具体开发步骤。

## 客户端边界

- 管理员工作台使用 React 与 Vite，并以独立管理入口运行。
- Embed Chat 是独立构建入口，不与管理员页面共享访问语义。
- Chat 通过 WebSocket 管理实时会话，通过 HTTP 完成控制面请求和文件上传。
- 管理员与 Embed 可以使用不同鉴权和传输入口，但进入共享消息视图前必须归一为同一结构化 transcript：`text`、`thinking`、tool item 与 streaming/terminal 状态语义一致。

## 服务端边界

- Control Plane 管理租户、Agent、发布应用、版本、Usage 和管理员会话能力。
- Data Plane 提供 Embed bootstrap、凭据交换、企业用户 Conversation 和附件能力。
- Runtime Plane 执行 Agent 会话、工具调用和流式事件。
- Embed Realtime 必须转发 Runtime 的真实增量，不得在执行完成后用全文单帧 `message.delta` 替代真实流式事件；最终持久事件仍是断线恢复的权威事实。
- 发布 Runtime 的思考档位解析顺序固定为：会话覆盖 > Revision 显式参数 > 冻结 capability 的 `defaultEffort`。当冻结能力为 `supported:true`、`toggle:false` 且前述值均缺失时，必须使用冻结 `efforts` 的首个档位，不能静默按“关闭思考”运行；可关闭模型没有默认值时才交由 Provider 默认行为。
- PostgreSQL 保存发布、租户、企业会话和用量等持久数据。
- Redis 承担需要跨实例共享的短期状态与协调能力。

## 核心契约

- Tenant 是管理和数据隔离边界。
- Agent Revision 与 Published App Version 均为不可变版本对象。
- 企业用户 Conversation 固定绑定发布版本。
- Usage 由服务端记录和聚合，必须包含 Tenant、Agent、来源和 Token 字段。
- 文件上传记录必须与会话绑定使用同一服务端存储与身份范围。
- 管理员凭据和终端用户访问凭据使用不同信任链路。

## 详细实现资料

实现细节、迁移、运维和历史设计保留在 `docs/` 其他文档中，但不构成产品规则；发生冲突时，以本目录的官方产品文档为准。

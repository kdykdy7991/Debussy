# WB-006：用户会话控制台

状态：Blocked by WB-002/WB-007/WB-008

## 目标

实现真实企业用户 Conversation 的全局检索、Transcript、Event Log、运行信息、Summary、附件和审计入口。

## 修改范围

- Admin Conversation Control API
- `runtimes/pi/packages/web/src/admin/user-conversations/`
- protocol DTO 和专项测试

## 交付

1. 按 App、Agent、时间、状态、身份、错误和版本筛选。
2. 默认脱敏列表和 cursor 分页。
3. Transcript/Event Log/运行信息/Summary/附件页签。
4. 前后 rollover Conversation 导航。
5. 进入正文、附件和导出入口的审计。

## 禁止

- 不复用面向 Principal 的 Embed Token。
- 不返回原始 externalUserId/visitorId。
- 不一次性加载完整事件历史。
- 未知事件不得导致整个页面崩溃；以安全只读形式显示。

## 验收

- tenant/app/principal 越权统一 404。
- 默认列表不包含消息正文。
- Event Log 按 sequence 增量加载。
- 查看正文和附件产生审计记录。
- UI/API 专项测试和 `npm run check` 通过。

## 交接

记录脱敏规则、分页游标、审计事件和 UI 对未知事件的处理。


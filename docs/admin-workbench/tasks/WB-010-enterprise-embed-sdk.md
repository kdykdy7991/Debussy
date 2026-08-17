# WB-010：企业 Embed SDK

状态：Blocked by WB-001/WB-005

## 目标

在保持 iframe 安全隔离的前提下，为企业网站提供 inline/floating 控制、signed-user 初始化和宿主事件。

## 修改范围

- `runtimes/pi/packages/protocol/src/embed/post-message.ts`
- 新增或现有 Embed SDK 包/入口
- Embed Web postMessage 处理
- 宿主示例和接入文档
- SDK/浏览器专项测试

## 交付

1. `create({ appId, container, launchToken })`。
2. open、close、destroy 和尺寸同步。
3. anonymous/signed-user 初始化。
4. ready、error、conversation-created、logout 事件。
5. event.source、event.origin 和协议版本校验。
6. iframe 与 SDK 接入示例。

## 禁止

- SDK 不接触宿主私钥。
- Launch Token 不放 URL 或 Storage。
- 不在宿主页面执行 Agent Runtime。
- 不接受未签名 externalUserId 建立身份。

## 验收

- 错 Origin、错 source、错协议版本消息被忽略或明确拒绝。
- Launch Token 交换后立即从 SDK 内存释放。
- anonymous 和 signed-user 都走同一 Embed 数据面。
- inline/floating 生命周期清理无残留 listener/iframe。
- 真实宿主 Chromium E2E 单独记录。

## 交接

记录公共 SDK API、postMessage 协议、Token 生命周期、宿主示例和浏览器限制。


# SKDY Agent 架构基线

> 本文是项目后续需求设计的约束基线。新增功能应先确认不会破坏本文的边界；如果确实需要改变核心方向，应先更新本文并说明迁移方案。

## 1. 产品核心

SKDY Agent 的核心是由 Pi runtime 驱动的 Agent、会话和可靠流式协议。Web 对话、语音、数字人和未来的发布能力，都是围绕这个核心提供的产品能力，不应反过来侵入或替代 Agent runtime。

会话记录、Agent 执行过程、模型调用和数据归属仍由 SKDY Agent 服务端管理。外部项目未来只能通过发布后的访问入口使用能力，不直接接触模型密钥或内部 runtime。

## 2. 当前模块边界

```text
skdy-agent/
├── runtimes/pi/
│   ├── packages/server/       # Agent 服务、会话、WebSocket
│   ├── packages/protocol/     # 客户端与服务端的事件协议
│   ├── packages/client/       # Pi 客户端和断线恢复
│   └── packages/web/          # 当前 Pi Web 对话应用
├── packages/avatar/           # 独立数字人能力包（预留）
├── runtimes/pi/packages/web/src/features/avatar/
│                              # Pi Web 的数字人接入层
└── docs/                     # 设计、联调和架构记录
```

### Agent 与会话

- Agent runtime 负责执行 Agent、模型、工具和会话生命周期。
- Server 负责鉴权、会话存储、可靠流式传输和恢复。
- Protocol 负责跨客户端传输稳定的事件和快照。
- Web 通过客户端和协议访问服务，不应复制 Agent 执行逻辑。

### Web 对话

- `packages/web` 当前是 Pi 的官方 Web 应用，不要求现在就支持其他 runtime。
- 页面可以持续使用 Pi 的会话模型和协议。
- 与产品品牌、主题和页面布局有关的代码属于 Web 层。
- 会话控制、连接恢复和流式事件处理属于 Web 的基础设施层，不应散落到展示组件中。

### 数字人

- 数字人是 Web 展示和交互能力，不属于 Agent runtime。
- `packages/avatar` 负责数字人组件、资源适配和标准状态，不直接依赖 Pi 会话对象。
- Web 接入层负责把 Agent 状态映射成数字人状态。
- Rive 只是第一种渲染实现，未来可以替换为其他实现。
- 语音服务和 TTS 负责产生音频；数字人只消费标准化的语音、口型和状态信号。

建议使用的状态抽象：

```text
idle → thinking → tool-calling → speaking → idle
                         └──────→ error
```

后续可以增加 `audioLevel`、`viseme` 和 `emotion`，但不让数字人读取 Pi 内部对象。

## 3. 未来发布模型

发布能力的目标类似 Dify 的“发布应用”，不是支持多个 runtime。

```text
Agent
  └── PublishedApp
        ├── Web 对话配置
        ├── 访问策略
        ├── 会话策略
        └── 可选 AvatarPublication
```

### Web 对话发布

- 发布一个已经配置好的 Agent 应用。
- 生成公开 `appId` 和嵌入入口。
- 外部项目通过 iframe 或后续的 Embed SDK 使用。
- 浏览器只获得短期 session token，不获得模型 API Key。
- 服务端根据 `appId` 找到 Agent 和发布配置。
- 会话记录继续保存在 SKDY Agent 服务端。
- 通过 `tenantId`、`externalUserId` 和 `externalSessionId` 关联外部项目用户。
- 支持草稿、发布、下线、版本和回滚。

### 数字人发布

数字人不是独立 Agent，而是已发布 Web Agent 的可选表现层：

```text
PublishedApp
  └── AvatarPublication
        ├── 数字人资源和版本
        ├── 状态与动画映射
        ├── 显示位置和样式
        └── 语音配置
```

发布形态可以是：

- 纯 Web 对话
- Web 对话 + 数字人
- Web 对话 + 语音 + 数字人

两者共用发布应用、认证、租户和会话体系，但数字人的资源、动画和语音配置独立管理。

## 4. 设计时不可违背的原则

1. 不把数字人逻辑放入 `packages/agent` 或 `packages/server`。
2. 不让数字人直接依赖 Pi 内部会话对象。
3. 不让浏览器接触模型 API Key 或长期服务端凭据。
4. 不把发布逻辑硬编码进 `app.tsx`；发布应有独立的配置和访问层。
5. 不为了未来发布而提前拆成多个 runtime 或多个后端适配器。
6. 不把外部项目的会话数据默认存到外部项目；数据归属仍由 SKDY Agent 管理。
7. 新的 UI 能力优先放在 feature 目录或独立能力包，不继续堆积到单一页面组件。
8. 协议扩展应保持向后兼容，并优先使用状态、事件和快照等稳定抽象。

## 5. 需求评审检查清单

新增功能设计时，先回答：

- 这是 Agent runtime、Web 展示、数字人、语音还是发布层的能力？
- 是否让展示层依赖了 Agent 内部实现？
- 是否改变了会话数据的归属或存储位置？
- 是否需要新的公开凭据或 Origin 校验？
- 是否可以作为已发布 Agent 的配置，而不是新建一套运行时？
- 是否影响 iframe/Embed SDK 的安全边界？
- 是否需要新增协议事件，且能否通过稳定抽象表达？

如果无法明确归属，先更新架构设计，再开始编码。

## 6. 推荐演进顺序

1. 完善 Pi Agent、会话、流式和 Web 对话核心。
2. 完成独立数字人组件和状态映射。
3. 增加 `PublishedApp` 和 iframe 发布能力。
4. 增加主题、品牌、Agent 配置和访问控制。
5. 增加 JS Embed SDK。
6. 最后接入语音驱动、口型同步和更复杂的数字人表现。

当前阶段不需要提前实现发布平台，也不需要拆分多个 runtime；只需保持上述边界，为后续发布保留清晰接口。

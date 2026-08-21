# 交互规范

## 全局规则

- 状态必须同时使用文字和视觉反馈表达，不能只依赖颜色或动画。
- 绿色表示健康或成功，琥珀表示进行中或待处理，红色表示失败或风险。
- 加载、空内容、错误、无权限、离线和长文本溢出必须有明确处理。
- UI 不展示内部 UUID、Token、堆栈或无法指导用户操作的原始错误。
- 动画必须尊重 `prefers-reduced-motion`。
- 同一对象和状态在不同页面使用相同术语。

## Chat 输入与附件

- 消息提交后输入框立即清空；发送失败时，在不覆盖用户新输入的前提下恢复原消息。
- 输入框使用单层视觉容器，不展示当前模型名称。
- 文件上传入口使用加号图标。
- 长文件名必须省略显示，并允许查看完整名称。
- 上传失败必须展示可操作文案；上传记录失效统一显示“上传已失效，请重新上传”。

## Agent 形象状态

当前形象引擎确认支持以下视觉状态。这里仅固化可用状态集合；Chat/UI 的业务事件映射尚未最终确认，因此不写入官方规则。

### 核心生命周期

`sleeping`、`waking`、`idle`、`listening`、`thinking`、`searching`、`working`

### Agent Morphs

`orbit`、`radar`、`progress`

### 产品生命周期

`spawning`、`humming`、`loading`、`dictating`、`writing`、`sending`、`receiving`、`uploading`、`notifying`、`alerting`、`dragging`、`bouncing`、`powering-down`

### 瞬时反应

`excited`、`surprised`、`suspicious`、`angry`、`drowsy`、`happy`、`curious`、`confused`、`bored`、`proud`、`shy`、`sad`、`laughing`、`scared`、`playful`、`celebrate`

业务映射确认后，应在本文件中一次性补充事件来源、状态优先级、持续时间、中断和回退规则。

# V6 任务单：Incremental Text Projector + Segmenter

状态：Ready  
职责：纯文本增量投影和自然片段提交  
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

## 1. 依赖门槛

### Hard prerequisites

- 无代码前置；只依赖 Phase 2 Spec 的文本行为。

### Soft prerequisites

- V5 的类型不影响本任务；可并行。

### Parallel-safe subset

- 本任务全量可与 V5 并行。

### Integration gate

- V7 开始前导出 API、默认参数、commit reason 必须冻结。

### Merge gate

- pure deterministic tests 全绿。
- 无 protocol/server runtime 私有依赖。
- 任意 delta 分割得到与整段输入等价的投影和分段结果。

## 2. 目标

实现两个纯逻辑组件：

1. `IncrementalSpeakableTextProjector`：从增量 Markdown 文本产生只追加的可朗读文本。
2. `IncrementalTextSegmenter`：按强标点、长度、idle timeout 和 turn end 提交 utterance。

不调用 Voice Service，不持有 SpeechJob，不接 Agent runtime。

## 3. 建议位置

```text
runtimes/pi/packages/server/src/voice/live/text-projector.ts
runtimes/pi/packages/server/src/voice/live/text-segmenter.ts
runtimes/pi/packages/server/test/live-text-projector.test.ts
runtimes/pi/packages/server/test/live-text-segmenter.test.ts
```

允许创建独立内部 package 的唯一理由是 server package 无法无环引用；不得发布公共 npm API。

## 4. 禁止修改

- Protocol schema
- PiClient/Web/Voice Service/Avatar
- Live coordinator、HTTP stream、queue
- 用逐 delta regex 代替跨 delta 状态机
- 记录原始文本

## 5. Projector 要求

- 只接受当前 assistant text delta；调用方负责 turn filtering。
- 保存 code fence、inline code、link/image、HTML 和转义状态。
- 跳过 fenced code 原文。
- link 只保留 label，URL 丢弃。
- inline code 保留内容，移除 backtick。
- 标题/list/emphasis/table marker 不朗读。
- HTML tag 不执行、不朗读。
- 输出 append-only；API 返回“本次新增的 projected text”。
- `flush()` 处理合法尾部；未闭合危险结构采用保守丢弃，不泄漏 URL/code。
- `reset()` 清除全部状态，旧 turn 数据不可进入新 turn。

## 6. Segmenter API 与默认值

使用总 Spec 第 10 节接口，默认：

```text
minCharacters=12
targetCharacters=60
maxCharacters=120
idleFlushMs=1000
```

- 强边界：可靠的中英文终止标点、段落。
- 软边界：分号、冒号、逗号、空格。
- max 强制切；idle 使用注入 clock 的 `tick(now)`。
- turn end `flush()`；空白不产生 utterance。
- sequence 从 1 单调递增。
- 计数按 Unicode code point，不按 UTF-16 code unit 截断 surrogate pair。
- commit 后不可变、不可撤回。

## 7. 必测矩阵

- 中文、英文、中英混合、列表、标题、表格、链接、图片、inline/fenced code、HTML。
- Markdown marker/URL/code fence 被拆在任意 delta 位置。
- `3.14`、`v1.2.3`、域名、缩写、引号括号后的句点。
- emoji/代理对/组合字符。
- 短句合并、target soft split、max hard split、idle、turn end。
- 长无标点、全空白、只有代码、未闭合 Markdown。
- 同一输入随机分割 100+ 组，输出与 one-shot feed 等价。
- reset 后无旧状态。

推荐 property-based/fuzz helper，但不得新增重量依赖而不说明。

## 8. 验收命令

```bash
cd runtimes/pi
npm run test --workspace=@earendil-works/pi-server -- live-text
npm run typecheck --workspace=@earendil-works/pi-server
npm run build --workspace=@earendil-works/pi-server
git diff --check
```

## 9. 交接

Handoff 记录状态机、投影规则、分段优先级、Unicode 计数、默认参数、API 示例、随机分割
测试结果和 V7/V8 集成示例。完成后标记 `Review / API frozen`。


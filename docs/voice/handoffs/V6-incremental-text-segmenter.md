# V6 Handoff: Incremental Speakable Text Projector + Segmenter

状态：Review / **API frozen**
任务：[`../tasks/V6-incremental-text-segmenter.md`](../tasks/V6-incremental-text-segmenter.md)
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

V6 完成 Phase 2 实时朗读链路的「文本 → 片段」半段。Projector 把增量 Markdown
assistant delta 投影成只追加的可朗读文本；Segmenter 按 Spec §10 的优先级把投影
文本切成可入队的 utterance。两个组件是纯逻辑，不访问 Voice Service、不持有
SpeechJob、不监听 Agent runtime。

## 1. 产物

| 文件 | 角色 |
| --- | --- |
| `runtimes/pi/packages/server/src/voice/live/text-projector.ts` | `IncrementalSpeakableTextProjector` 工厂与状态机 |
| `runtimes/pi/packages/server/src/voice/live/text-segmenter.ts` | `IncrementalTextSegmenter` 工厂与边界判定 |
| `runtimes/pi/packages/server/test/live-text-projector.test.ts` | 投影器测试矩阵 |
| `runtimes/pi/packages/server/test/live-text-segmenter.test.ts` | 分段器测试矩阵 |

构建后 `dist/voice/live/text-{projector,segmenter}.{js,d.ts}` 同步发布，但本任务不
对外暴露公共 npm export；Coordinator（V8）以相对 import 方式使用。

## 2. 公开 API

### 2.1 Projector

```ts
import {
  createSpeakableTextProjector,
  type IncrementalSpeakableTextProjector,
} from "@earendil-works/pi-server/voice/live/text-projector";

const projector = createSpeakableTextProjector(); // V6-frozen defaults
projector.project(delta); // returns the slice newly projected from this delta
projector.flush();        // closes any unpaired structure; returns ""
projector.reset();        // clears all state for the next turn
```

约束：

- 输出 **append-only**；`project()` 返回本次新增的投影文本。
- `flush()` 永远不泄漏 URL、未闭合代码块内容、未配对强调标记。
- `reset()` 必须在新一轮 prompt 调用前调用；旧 turn 数据不得进入新 turn。
- 不存储原始 delta、URL 或 token，只暴露投影文本本身。

可选配置（V6 frozen 默认值）：

```ts
createSpeakableTextProjector({
  skipFencedCode: true,       // default; 跳过 ``` 围栏代码
  dropImagesWithoutAlt: true, // default; 空 alt 图片静默丢弃
});
```

### 2.2 Segmenter

```ts
import {
  createTextSegmenter,
  DEFAULT_MIN_CHARACTERS,        // 12
  DEFAULT_TARGET_CHARACTERS,     // 60
  DEFAULT_MAX_CHARACTERS,        // 120
  DEFAULT_IDLE_FLUSH_MS,         // 1000
  type CommittedUtterance,
  type CommitReason,
} from "@earendil-works/pi-server/voice/live/text-segmenter";

const segmenter = createTextSegmenter();
segmenter.push(text, now); // 立即返回本次新增的 committed utterances
segmenter.tick(now);       // 只在 idle 窗口到期且 min 已达到时返回
segmenter.flush(now);      // 把非空 buffer 作为 turn_end 提交
segmenter.reset();         // 清空 buffer、sequence 从 1 重新计数
```

`CommittedUtterance` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sequence` | `number` | 从 1 单调递增；不可变 |
| `text` | `string` | 提交后不可修改、不可合并、不可重排 |
| `reason` | `"terminal_punctuation" \| "paragraph" \| "soft_limit" \| "idle_timeout" \| "turn_end"` | 触发提交的边界类型 |

可选配置（V6 frozen 默认值）：

```ts
createTextSegmenter({
  minCharacters: 12,
  targetCharacters: 60,
  maxCharacters: 120,
  idleFlushMs: 1000,
});
```

参数相对关系：`minCharacters <= targetCharacters <= maxCharacters`，`idleFlushMs >= 0`。
越界在构造时抛 `RangeError`，不延迟到 push/tick。

## 3. Projector 状态机

Projector 维护以下跨 delta 状态（全部仅保存在闭包里，不写入外部存储）：

| 状态 | 触发 | 用途 |
| --- | --- | --- |
| `fence` | 遇到 ``` ``` ``` / `~~~` | 标记是否在围栏代码块内，决定丢弃还是保留内容 |
| `inlineBackticks` | 遇到 `` ` `` | 标记 inline code 的 backtick run 长度；寻找相同 run 关闭 |
| `link` | `[label](url)` 找到 `(` 但 URL 未闭合 | 丢弃 URL 直到 `)` |
| `pendingLink` | `[label]` 出现但 `]` 后无 `(`，或 `[`/`!` 在尾端 | 累积 label 直到 `]` 与可能的 `(` 同时确认 |
| `pendingSkipHtmlTag` | 进入 `<script>` / `<style>` / `<noembed>` / `<noframes>` / `<plaintext>` | 静默丢弃到 `</tag>` |
| `pendingListMarker` | `-` / `*` / `+` 出现在行尾 | 待确认 list item 还是 math minus |
| `pendingHrMarker` | `---` / `***` / `___` 出现在行尾 | 待确认 horizontal rule |

处理优先级（自上而下，每个 delta 逐字符判定）：

1. 围栏代码块内字符按行丢弃（或在 `skipFencedCode=false` 时投影）。
2. `pendingSkipHtmlTag` 内的所有字符丢弃直到匹配 `</tag>`。
3. `link.targetOpen` 时所有字符丢弃，直到 `)` 或换行（换行强制丢弃 link）。
4. `pendingLink.closed` 时若下一字符是 `(`，提交 link；否则把累积的 `[label]` 当作
   普通文本输出，然后继续正常解析。
5. `pendingLink` 累积阶段：换行强制丢弃；`]` 触发 close 或 abort；否则累积字符。
6. `inlineBackticks > 0` 时原文输出（替换换行为空格），backtick run 长度匹配关闭。
7. `pendingListMarker` 等待空格、换行或正文；正文到达时输出前导换行再继续解析。
8. `pendingHrMarker` 等待换行；非空白到达时把标记当原文回吐。
9. ``` ` ``` / `~~~` run >= 3 → 围栏代码块开始。
10. ``` ` ``` run 1-2 → inline code 开始。
11. `![alt](url)` → 输出 alt；未匹配则按 `[` 继续。
12. `[label](url)` → 输出 label，丢弃 URL；未匹配则进入 `pendingLink`。
13. 行首 `#`×1-6 → 丢弃标记 + 缩进空格，输出软换行。
14. 行首 `---` / `***` / `___` run >= 3 → horizontal rule。
15. 行首 `-` / `*` / `+` 单字符 + 空白 → list marker；否则回退为原文。
16. 行首 `1.` / `1)` 数字列表。
17. 行首 `>` / `>>` → blockquote marker。
18. 行首 `|` + 仅由 `:`、`-`、`|`、空白组成的行 → table separator。
19. 行内 `|` → 表格分隔符丢弃。
20. HTML `<tag>` / `</tag>` / `<!-- -->` / `<![CDATA[ ]]>` 全部丢弃。
21. `*` / `_` / `~~` 强调 run → 丢弃标记。
22. `\\` 转义 → 丢弃反斜杠。
23. 其余字符原样输出。

`flush()` 把所有未配对结构静默关闭：未闭合的 link target / inline code / fence /
pendingSkipHtmlTag / pendingListMarker / pendingHrMarker 一律清空，绝不泄漏 URL
或代码块内容。`reset()` 等价于在 turn 边界时调用 `flush()` 之后再清零状态。

## 4. Segmenter 状态机

Segmenter 维护 `buffer`（累积的纯文本）、`lastPushAt`（最后一次 `push` 的时间戳）、
`sequence`（提交序号，从 1 起）。

`push(text, now)`：

1. 把 `text` 前缀空白剥离后追加到 `buffer`。
2. 在循环里反复尝试提交，每次循环检查最新 buffer：
   - `trimmedLen < minCharacters` → 等待。
   - 找到强边界（`。！？` 或 ASCII `.?!` 且前是字母类、后是空白/结尾） → terminal_punctuation。
   - 找到段落断点 `\n\n` → paragraph（cut 在第一个 `\n` 处，第二个保留给 buffer 维持节奏）。
   - `codeLen >= maxCharacters` → 强制 `soft_limit`（在 `[target..max]` 内取最末的
     `；;：:，,` 或空白），若无软边界则在 cap 硬切。
   - `codeLen >= targetCharacters` → `soft_limit`。
3. 提交后 buffer 缩短、序号递增；循环直到没有新的边界可触发。

`tick(now)`：

- 接受外部时钟；仅在 `now - lastPushAt >= idleFlushMs` 且 `trimmedLen >= minCharacters`
  时提交 `idle_timeout`。其它边界不在 tick 路径触发。

`flush(now)`：

- 把剩余非空 buffer 提交为 `turn_end`；空白 buffer 不产生 utterance。

`reset()`：

- 清空 buffer、`lastPushAt`、序号从 1 重新计数。

边界字符集合（frozen）：

```text
强标点 CJK : 。 ！ ？
强标点 ASCII : .  ?  !     # 当且仅当 prev 是字母类且 next 是空白/结尾
软标点 : ， : ; ， ; ： ；
段落 : \n\n
```

`Unicode code point` 计数通过 `for…of string` 实现；`Array.from(buffer)` 在每条
commit 路径上只调用一次，buffer 受 maxCharacters 限制，性能不是瓶颈。

## 5. 与 V7/V8 的集成示例

V7 的 `UtteranceQueue` 拿到的是 `CommittedUtterance`；Projector 仍由 V8 的
Coordinator 调用。典型接线：

```ts
import { createSpeakableTextProjector } from "@earendil-works/pi-server/voice/live/text-projector";
import { createTextSegmenter } from "@earendil-works/pi-server/voice/live/text-segmenter";
import { UtteranceQueue } from "../queue.ts"; // V7

class LiveSpeechJobCore {
  private readonly projector = createSpeakableTextProjector();
  private readonly segmenter = createTextSegmenter();
  private readonly queue: UtteranceQueue;

  onAssistantTextDelta(delta: string, now: number) {
    const projected = this.projector.project(delta);
    if (projected) this.feed(projected, now);
  }

  private feed(text: string, now: number) {
    const committed = this.segmenter.push(text, now);
    for (const u of committed) this.queue.enqueue(u);
  }

  onAssistantTurnFinished(now: number) {
    this.projector.flush();
    for (const u of this.segmenter.flush(now)) this.queue.enqueue(u);
    this.queue.closeInput();
  }

  onTick(now: number) {
    for (const u of this.segmenter.tick(now)) this.queue.enqueue(u);
  }

  onCancel() {
    this.projector.reset();
    this.segmenter.reset();
  }
}
```

要点：

- `project()` 在每条 assistant delta 上调用；返回值会拼接到下游 buffer 中。
- `push()` / `tick()` / `flush()` 都返回新增的 `CommittedUtterance`，不要把返回值
  缓存到下次调用再统一入队，否则会丢失 commit 与 tick 之间的实时节奏。
- `tick()` 由 Coordinator 的固定频率（建议 4 Hz，与 §7.4 一致）调用；不做 tick 会
  导致 idle 边界延迟。
- `reset()` 在每次 prompt 前 / abort / steer / disconnect 后调用，保证 turn 数据隔离。
- Coordinator 不要主动记录 `buffer` 原文到日志、SessionSnapshot 或 SessionEventLog；
  详见总规范 §16。

## 6. 边界案例矩阵（已写测试）

### 6.1 Projector

- 中文 / 英文 / 中英混合 plain text。
- 标题（`#`–`######`）、无序列表（`-` / `*` / `+`）、有序列表（`1.` / `1)`）。
- 强调（`*x*` / `**x**` / `_x_` / `__x__` / `~~x~~`）、表格分隔行、表格单元格 `|`。
- 链接 `[label](url)`、图片 `![alt](url)`、空 alt 图片。
- Inline code `` `code` `` 、围栏代码 ``` ```js\n…\n``` ```。
- HTML：`<b>x</b>` 内文保留，`<script>` / `<style>` / `<noembed>` / `<noframes>` /
  `<plaintext>` 内容整体丢弃；HTML 注释 `<!-- `丢弃。
- 围栏 ` ``` ` 在任意位置被 delta 分割、URL 在任意位置被 delta 分割、Markdown
  标记（`[`、`(`、`**`、`#`）在任意位置被 delta 分割。
- 100 次随机 delta 切分（包括跨链接、跨围栏、跨 list 标记）输出一致。

### 6.2 Segmenter

- 强标点：CJK `。！？` 与 ASCII `.?!`（prev 字母类、next 空白/结尾）提交；
  `3.14` / `v1.2.3` / `example.com` / `U.S.A.` 不被误切。
- 段落断点 `\n\n` 在 min 达到时提交。
- 软标点 `；;：:，,` 或空白在 target 达到时提交。
- maxCharacters 强制切分；找不到软边界时硬切。
- idle timeout 仅在 min 已达且 `now - lastPushAt >= idleFlushMs` 时提交。
- turn_end 仅在 buffer 非空且非空白时返回。
- 序列号单调递增；reset 后从 1 重新计数。
- 短句合并（不足 min 时累积；turn_end 提交）。
- 中英混合、emoji、代理对（不会切到 surrogate 边界）。
- 100 次随机 delta 切分累计文本与 one-shot 等价（规范化空白后）。

## 7. 验证命令

```bash
cd runtimes/pi
npm run test --workspace=@earendil-works/pi-server -- live-text   # 49 passed
npm run typecheck --workspace=@earendil-works/pi-server            # clean
npm run build    --workspace=@earendil-works/pi-server            # clean
git diff --check                                                    # clean
```

`live-text` 命中 49 个用例，覆盖 projector 与 segmenter 全部需求矩阵。`typecheck`
与 `build` 均无新增告警。

## 8. 已知风险与决策

- **未跨设备回放**：Projector 不存储原文，segmenter 不持久化任何状态；Coordinator
  若需要断线续传，必须在 V8 自己重新投影并提交，本任务的组件不参与。
- **横向规则（HR）的歧义**：`---` / `***` / `___` 仅在 line-start 完整出现且行内
  没有其他字符时丢弃。`--foo` 这种行首短横线场景视作正文，按字符流保留。这是与
  CommonMark 的差异点，V6 默认偏好语音侧「朗读出来」。如未来需要兼容，可调整
  HR 判定阈值。
- **CJK 强标点后多余空白**：Projector 不会为 CJK 强标点插入软停顿；Segmenter 的
  soft_limit 也不会额外插入空白。Coordinator 若需要 TTS 停顿，应在交给 Voice
  Service 时由其前端处理。
- **链接语法歧义**：mid-word 的 `text[1]` 不会误判为 link（`isInsideWord` 守卫）。
  数学下标 / 上标的 `[n]` 不会被读出 label（无 `[` 边界）。如果未来要把下标纳入
 朗读范围，需要再扩展 Projector 行为；本版本保守处理。

## 9. API frozen 范围

下列 API 在 V6 中冻结；V7/V8 不得修改，必须变更时升级 Phase 2 协议版本：

- `createSpeakableTextProjector` / `IncrementalSpeakableTextProjector` 的三个方法与
  返回值类型。
- `createTextSegmenter` / `IncrementalTextSegmenter` 的四个方法与默认值。
- `CommittedUtterance` 的字段顺序与语义。
- `CommitReason` 的枚举成员。
- `DEFAULT_MIN_CHARACTERS` / `DEFAULT_TARGET_CHARACTERS` / `DEFAULT_MAX_CHARACTERS`
  / `DEFAULT_IDLE_FLUSH_MS` 的数值。

## 10. 下游接入指引

- V7 (`UtteranceQueue`) 只依赖 `CommittedUtterance` 的三个字段；接口与 V6 一致后
  V7 不再修改其消费接口。
- V8 (`LiveSpeechCoordinator`) 在 §5 示例代码处接线；在 prompt 之前
  `projector.reset() + segmenter.reset()`；每条 assistant text delta 后调用
  `projector.project` 再 `segmenter.push`；abort / steer / disconnect 后
  `projector.reset() + segmenter.reset()`。
- V9 (Web UX) 不直接 import 本任务的模块；只通过 V8 的 `LiveSpeechJobEvent` 接收
  进度，不接触 projector / segmenter 内部状态。

冻结接口变更需先与总规范 owner 同步，并升级 Phase 2 协议版本（详见
[`README.md`](../README.md) §5）。
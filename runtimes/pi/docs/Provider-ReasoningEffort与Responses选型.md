# Pi LLM Provider:`reasoning_effort` 传参与 Responses/Completions API 选型

> 状态:笔记,2026-08-21 整理。
> 用途:回答两个反复出现的问题——
> (1) `reasoning_effort` 在 pi 里到底什么时候、放在哪个字段下发;
> (2) 当前 `oneapi` 接入实际走的是 Chat Completions 还是 Responses API。

---

## 1. `reasoning_effort` 是每次 `client.*.create(...)` 都重传,不是 client 初始化一次

入口到下发字段的完整链路(以 `runtimes/pi/packages/ai/src/api/openai-completions.ts` 为例):

```
streamSimple(...)                   ← 每个 turn 调用一次 (openai-completions.ts:612)
 └─ options?.reasoning              ← 用户传入的原始 thinking 级别
 └─ clampThinkingLevel(model, ...)  ← 校验/裁剪到模型支持的级别 (openai-completions.ts:620)
 └─ reasoningEffort = clamped       ← "off" → undefined (:621)
 └─ stream(model, ctx, {reasoningEffort})   (:624-628)
 └─ buildParams(...)                ← 组装 HTTP 请求体 (openai-completions.ts:232 / :676)
 └─ 按 compat.thinkingFormat 分支写入字段   (:743-844)
 └─ client.chat.completions.create(params, requestOptions)   (:243)
```

要点:

1. `reasoning_effort` 放在 **`params`(请求体)里**,**不在 `new OpenAI({...})` 配置里**(`openai-completions.ts:667-673`),所以每次 `create()` 都要重传。
2. **下发条件**(三个 AND):
   - 模型声明支持:`model.reasoning === true`
   - 兼容层支持:`compat.supportsReasoningEffort`(`types.ts:533`)
   - `compat.thinkingFormat` 分支命中(见 §3 字段映射表)
3. **per-turn 证据**:agent loop 每个 turn(用户消息 / 工具调用 / 最终回复)都会再调一次 `streamSimple`,所以 `reasoning_effort` 跟着每轮的 `params` 重新下发,不是"开 client 时设一次就够"。

---

## 2. 代码库分了两套 API:`openai-completions` vs `openai-responses`

`reasoning_effort` 在两条路径上的下发字段**完全不同**。

### 2.1 openai-completions(Chat Completions 协议)

| 维度 | 内容 |
|---|---|
| 文件 | `src/api/openai-completions.ts` |
| 入口 | `streamSimple(:612)` → `stream(:228)` |
| 真 SDK 调用 | `client.chat.completions.create(params, requestOptions)` (`:243`) |
| 字段 | **顶层 `reasoning_effort: "<level>"`**(再叠加 10+ 个 `compat.thinkingFormat` 分支改写) |
| 来源 | `openai-compatible` provider **不走这条**,除非改 provider 实现 |

### 2.2 openai-responses(Responses API 协议)

| 维度 | 内容 |
|---|---|
| 文件 | `src/api/openai-responses.ts` |
| 入口 | `streamSimple(:201)` → `stream(:101)` |
| 真 SDK 调用 | `client.responses.create(params, requestOptions)` (`:150`) |
| 字段 | **`params.reasoning = { effort, summary }` + `params.include = ["reasoning.encrypted_content"]`**(`:312-328`) |
| 注意 | **顶层没有 `reasoning_effort` 字段** |

`buildParams` 里的关键片段(`openai-responses.ts:312-328`):

```ts
if (model.reasoning) {
  if (options?.reasoningEffort || options?.reasoningSummary) {
    const effort = options?.reasoningEffort
      ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
      : "medium";
    params.reasoning = {
      effort: ...,
      summary: options?.reasoningSummary || "auto",
    };
    params.include = ["reasoning.encrypted_content"];
  } else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
    params.reasoning = { effort: (model.thinkingLevelMap?.off ?? "none") as ... };
  }
  if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
}
```

注意 Responses API 默认把 `summary` 设为 `"auto"`,可通过 `OpenAIResponsesOptions.reasoningSummary`(`:93`)覆盖为 `"detailed" | "concise" | null`。同时强制 `include = ["reasoning.encrypted_content"]` 用于跨轮 thinking 缓存复用。

### 2.3 分流入口

注册表(`src/compat.ts:181-183`):

```ts
["openai-responses", openAIResponsesApi()],
["openai-codex-responses", openAICodexResponsesApi()],
["azure-openai-responses", azureOpenAIResponsesApi()],
```

模型在 JSON 数据文件里用 `"api": "openai-responses" | "openai-completions" | ...` 标注。`models.ts:781-782` 通过 `dispatch(model, streams => streams.streamSimple(...))` 按 `model.api` 派发。

例:`providers/data/github-copilot.json` 里 `gpt-5.x` 系列全部走 `"api":"openai-responses"`;`gpt-4.1`、`claude-fable-5`(GitHub Copilot 代理以 chat 协议暴露 Claude)走 `"api":"openai-completions"`。

---

## 3. 字段名映射速查(按 `compat.thinkingFormat`)

| `compat.thinkingFormat` | 下发字段 |
|---|---|
| `"openai"` (默认 Chat Completions) | `reasoning_effort: "<mapped>"` |
| `"openrouter"` | `reasoning: { effort: "<mapped>" }` |
| `"zai"` (z.ai GLM) | `thinking: { type: "enabled", clear_thinking: false }` + `reasoning_effort` |
| `"deepseek"` | `thinking: { type: "enabled" }` + `reasoning_effort` |
| `"qwen"` | `enable_thinking: true` + `reasoning_effort` |
| `"qwen-chat-template"` | `chat_template_kwargs: { enable_thinking, preserve_thinking: true }` + `reasoning_effort` |
| `"chat-template"` | 仅 `chat_template_kwargs`(可配置) |
| `"baseten"` | `chat_template_args` + `reasoning_effort` |
| `"together"` | `reasoning: { enabled: true }` + `reasoning_effort` |
| `"ant-ling"` | `reasoning: { effort: "<mapped>" }` |
| `"string-thinking"` | `thinking: "<字符串>"` |
| **(Responses API,不分流)** | **`reasoning: { effort, summary }` + `include: ["reasoning.encrypted_content"]`** |

来源字段是用户传入的 `options.reasoning`,经过 `clampThinkingLevel` 校验,再过 `model.thinkingLevelMap` 映射(例如 `thinkingLevelMap: { minimal: "low", xhigh: "xhigh" }`),最终写到上面某一格。

---

## 4. 当前 OneAPI 接入实际走的是 **Responses API**

### 4.1 "oneapi" 不是内置 provider id

在 `runtimes/pi/packages/ai/src/providers/` 下没有 `oneapi.ts`。目录里所有 provider 文件(`all.ts:113` 注册)里也没有 `"oneapi"`。

`"provider": "oneapi"` 这个字符串只出现在:

| 位置 | 性质 |
|---|---|
| `docs/note/01-命令行运行与调试.md` | CLI 启动示例 `--provider oneapi` |
| `packages/web/test/{app,session-controller}.test.ts` | 测试 fixture 字符串字面量 |
| `scripts/verify-publishing-model-failures.mjs:9` | `PI_MODEL_PROVIDER ?? "oneapi"` 默认值 |

全是"用法示例"和测试夹具,**没有真的注册一个叫 `oneapi` 的 provider**。

### 4.2 真正接入 OneAPI 用的 provider:`openai-compatible`

`src/providers/openai-compatible.ts` 注释里直接点名 OneAPI:

```ts
/**
 * OpenAI-compatible provider ...
 *
 * - vLLM / LocalAI / LM Studio / Ollama (self-hosted)
 * - LiteLLM / OneAPI / Portkey (gateways)   ← 这里
 * - Azure OpenAI (custom endpoint)
 * - Internal LLM proxies
 */
export function openaiCompatibleProvider(): Provider<"openai-responses"> {
  const baseUrl = getProviderEnvValue("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  // ...
  return createProvider({
    id: "openai-compatible",
    baseUrl,           // ← 你的 OneAPI 网关地址
    api: openAIResponsesApi(),    // ← 走 Responses API
    // ...
  });
}
```

返回类型 `Provider<"openai-responses">` 已写明,**走 `/v1/responses`**,**不是 `/v1/chat/completions`**。

### 4.3 实际下发到 OneAPI 网关的请求体(schema 层)

```json
{
  "model": "Qwen3.6-35B-A3B-NVFP4",
  "stream": true,
  "messages": [...],
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "include": ["reasoning.encrypted_content"]
}
```

**不会有顶层 `reasoning_effort` 字段**。

---

## 5. 风险与验证

### 5.1 OneAPI 对 Responses API 的支持程度

OneAPI 历史上长期**只完整支持 `/v1/chat/completions`**。`openai-compatible` provider 无条件走 `/v1/responses`,所以:

| OneAPI 版本 | 行为 |
|---|---|
| 支持 Responses API(较新 fork / 商业版) | 正常透传 `reasoning` 给上游 |
| 只支持 Chat Completions(常见旧版) | `client.responses.create(...)` 发到 `/v1/responses` → OneAPI 返回 404,或对未知字段默默丢弃,**模型退化为不带 reasoning 的普通回复而不是报错**(网关默认策略) |

### 5.2 验证步骤

1. **抓包看请求路径**(在 OneAPI 网关侧或本地):

   ```bash
   # 当前 openai-compatible 一定发到 POST {OPENAI_BASE_URL}/responses
   # 如果想改 chat completions,见 §6 方案 B
   ```
2. **看响应里有没有 `reasoning` 块**(`output[]` 里 type 为 `reasoning` 的项)。只有 Responses API 才有。
3. **看 thinking 是否真的影响回复质量**:把 `thinkingLevel` 切到 `medium` vs `off`,观察回复长度和耗时差。

### 5.3 出问题的常见信号

- 网关返回 404(路径不对)→ OneAPI 不认 `/v1/responses`,立刻报错。
- 网关返回 200 但 `reasoning_effort` / `thinking` 无效 → 网关吞了字段,模型照常回复但不带 reasoning。
- 网关日志出现 schema 校验错误 → 网关认路径但透传 schema 失败。

---

## 6. 切换方案(备用)

### 方案 A:确认 OneAPI 支持 Responses,继续走 `openai-compatible`

现状不动。如果 OneAPI 是 ≥0.6.x 后期的 fork 或商业版,直接用。

### 方案 B:让 OneAPI 接入走 Chat Completions 协议

把 `openai-compatible.ts` 改成走 `openai-completions`:

```ts
import { openaiCompletionsApi } from "../api/openai-completions.lazy.ts";
// ...
api: openaiCompletionsApi(),
```

副作用:
- 请求路径变成 `POST {OPENAI_BASE_URL}/chat/completions`。
- `reasoning_effort` 变成**顶层字符串字段**(`openai-completions.ts:836-843`),按 `compat.thinkingFormat` 还会被进一步改写。
- 模型目录需要换成 chat 协议下能用的子集(比如 OneAPI 网关透传的模型 ID 和它能下发的 thinking 字段名)。
- 如果上游是 Qwen / DeepSeek / GLM 之类非 OpenAI 原生 provider,可能还会被 `compat.thinkingFormat` 二次改写成 `enable_thinking` / `thinking: { type }` 之类,这取决于对应 provider 在 `compat.ts` 的注册情况。

### 方案 C:加一个本地 provider(完整新 provider)

按 `.pi/skills/add-llm-provider.md` 的 checklist 加一个 `oneapi.ts`,显式声明 `api: "openai-completions"` + 自己的 `compat`(可以指定 `thinkingFormat: "chat-template"` 或类似,直接透传 `reasoning_effort`)。改动较大但行为最可控。

---

## 7. 一句话总结

- **`reasoning_effort` 在 pi 里每次 `client.*.create(...)` 都重传**,由 `streamSimple` 顶部 `clampThinkingLevel` → `buildParams` 写入。
- **代码库分两套 API**:`openai-completions` → `client.chat.completions.create()` + 顶层 `reasoning_effort` 字段(还按 `compat.thinkingFormat` 分流);`openai-responses` → `client.responses.create()` + `params.reasoning: { effort, summary }`(无 `reasoning_effort` 字段)。
- **当前 OneAPI 接入实际是 `openai-compatible` provider,走 `openai-responses` 协议**,所以 `reasoning_effort` 在请求体里叫 `reasoning: { effort, summary }`,不是顶层 `reasoning_effort`。
- **隐患**:旧版 OneAPI 不一定支持 `/v1/responses`,字段可能被静默吞掉,模型退化但不报错。
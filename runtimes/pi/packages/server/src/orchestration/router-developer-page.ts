import { routerOpenApi } from "./router-api-documentation.ts";

interface Schema {
	"x-conditionally-required"?: boolean;
	$ref?: string;
	allOf?: Schema[];
	oneOf?: Schema[];
	type?: string;
	description?: string;
	format?: string;
	pattern?: string;
	nullable?: boolean;
	enum?: unknown[];
	default?: unknown;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	maxItems?: number;
	required?: string[];
	properties?: Record<string, Schema>;
	items?: Schema;
	additionalProperties?: boolean | Schema;
}

interface Example {
	summary: string;
	description?: string;
	value: unknown;
}

interface Media {
	schema: Schema;
	example?: unknown;
	examples?: Record<string, Example>;
}

interface Parameter {
	name: string;
	in: string;
	required: boolean;
	description?: string;
	schema: Schema;
}

interface Operation {
	operationId: string;
	summary: string;
	description: string;
	parameters: Parameter[];
	requestBody?: { required: boolean; content: { "application/json": Media } };
	responses: Record<string, { description: string; content: { "application/json": Media } }>;
}

const schemas: Record<string, Schema> = routerOpenApi.components.schemas;

function escapeHtml(value: unknown): string {
	return String(value).replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
	);
}

function resolve(schema: Schema): Schema {
	const ref = schema.$ref ?? schema.allOf?.[0]?.$ref;
	return ref ? { ...schemas[ref.split("/").at(-1)!], ...schema } : schema;
}

function fields(spec: Schema): string {
	const schema = resolve(spec);
	return [
		...Object.entries(schema.properties ?? {}).map(([name, child]) =>
			field(name, child, schema.required?.includes(name)),
		),
		...(schema.items ? [field("数组元素", schema.items)] : []),
		...(typeof schema.additionalProperties === "object" ? [field("[动态键]", schema.additionalProperties)] : []),
		...(schema.oneOf?.map((child) => field(String(child.properties?.type?.enum?.[0] ?? "可选结构"), child)) ?? []),
	].join("");
}

function field(name: string, spec: Schema, required?: boolean, description?: string): string {
	const schema = resolve(spec);
	const type =
		schema.type === "array"
			? `${resolve(schema.items ?? {}).type ?? "value"}[]`
			: (schema.type ?? (schema.oneOf ? "联合类型" : "JSON"));
	const constraints = [
		schema.enum && `取值 ${schema.enum.map((value) => JSON.stringify(value)).join(" · ")}`,
		schema.default !== undefined && `默认 ${JSON.stringify(schema.default)}`,
		schema.minLength !== undefined && `最短 ${schema.minLength}`,
		schema.maxLength !== undefined && `最长 ${schema.maxLength}`,
		schema.minimum !== undefined && `最小 ${schema.minimum}`,
		schema.maximum !== undefined && `最大 ${schema.maximum}`,
		schema.maxItems !== undefined && `最多 ${schema.maxItems} 项`,
		schema.pattern && `格式 ${schema.pattern}`,
	]
		.filter(Boolean)
		.join("　");
	const heading = `<code>${escapeHtml(name)}</code> <span class="type">${escapeHtml(type)}${schema.format ? ` · ${escapeHtml(schema.format)}` : ""}${schema.nullable ? " · 可为 null" : ""}</span>${required === undefined ? "" : ` <span class="${required ? "required" : "optional"}">${required ? "必填" : schema["x-conditionally-required"] ? "条件必填" : "可选"}</span>`}`;
	const children = fields(schema);
	const notes = description ?? schema.description;
	const details = `${notes ? `<p>${escapeHtml(notes)}</p>` : ""}${constraints ? `<small>${escapeHtml(constraints)}</small>` : ""}`;
	return children
		? `<div class="field"><details><summary>${heading}</summary>${details}<div class="nested">${children}</div></details></div>`
		: `<div class="field">${heading}${details}</div>`;
}

function codeBlock(code: string, label: string): string {
	return `<div class="sample"><div class="sample-header"><span>${escapeHtml(label)}</span><button type="button" class="copy" aria-label="${escapeHtml(`复制${label}`)}">复制</button></div><pre tabindex="0"><code>${escapeHtml(code)}</code></pre></div>`;
}

const json = (data: unknown) => JSON.stringify(data, null, 2);
const examples = (media: Media) =>
	Object.values(
		media.examples ??
			(media.example === undefined
				? {}
				: {
						main: { summary: "JSON", value: media.example },
					}),
	);

const taskPath = "/api/aaas/v1/tasks";
const mcpPath = "/api/aaas/v1/mcp-servers";
const createExamples = routerOpenApi.paths[taskPath].post.requestBody.content["application/json"].examples;
const appendExample =
	routerOpenApi.paths["/api/aaas/v1/tasks/{id}/inputs"].post.requestBody.content["application/json"].examples.model
		.value;

function curl(method: string, path: string, body?: unknown): string {
	const parts = [
		`curl --fail-with-body -sS${method === "POST" ? " -X POST" : ""}`,
		`"$BASE_URL${path}"`,
		'-H "Authorization: Bearer $AAAS_API_KEY"',
	];
	if (path === taskPath || path.endsWith("/inputs") || path.startsWith(mcpPath)) {
		parts.push("-H 'X-Router-Capability-Scope: router'");
	}
	if (path === taskPath || path.endsWith("/inputs")) {
		parts.push('-H "Idempotency-Key: $IDEMPOTENCY_KEY"');
	}
	if (body !== undefined) {
		const payload = typeof body === "string" ? body : `'${json(body).replace(/'/g, "'\\''")}'`;
		parts.push("-H 'Content-Type: application/json'", `--data-binary ${payload}`);
	}
	return parts.join(" \\\n  ");
}

const executionErrors = [
	["QUEUE_TIMEOUT", "等待超时。减轻队列积压，再提交新的输入。"],
	["CREDENTIAL_EXPIRED", "执行期间的平台凭据窗口已过。等前序结束，再为新输入提供有效业务凭据。"],
	["EXECUTION_TIMEOUT", "执行超时。缩小本轮目标，检查上游工具耗时。"],
	["MCP_AUTH_FAILED", "MCP 认证失败。核对工具业务凭据，请管理员检查平台连接凭据。"],
	["MCP_RESULT_BLOCKED", "工具结果未通过平台检查。请管理员排查工具返回内容。"],
	["EXECUTION_NOT_AUTHORIZED", "执行已失去 MCP 调用权限。重新检查 Key 状态和工具授权。"],
	["INVALID_CAPABILITY_SNAPSHOT", "冻结能力失效。请管理员检查已授权的模型、MCP 和 Skill 版本。"],
	["EXECUTION_INTERRUPTED", "执行中断。查看当前 Task 状态后决定是否追加新输入。"],
	["EXECUTION_CLEANUP_UNCONFIRMED", "执行清理未确认。查看 Task 状态，持续占用时联系管理员。"],
	["EXECUTION_FAILED", "模型或执行链路失败。记录 Operation ID 和 requestId，必要时联系管理员。"],
	["PREDECESSOR_FAILED", "取消原因。前序失败后本轮排队执行被取消，Task 仍可接收新输入。"],
	["USER_CANCELED", "取消原因。Task 已永久终止，如需继续请新建 Task。"],
];

function quickStart(): string {
	const create = curl("POST", taskPath, createExamples.model.value);
	const operation = curl("GET", "/api/aaas/v1/operations/$OPERATION_ID");
	const append = curl("POST", `${taskPath}/$TASK_ID/inputs`, appendExample);
	return `<article id="quick-start">
<h1>快速开始</h1>
<p class="intro">用 API Key 创建持续任务，轮询每轮结果，再为任务接入 MCP 工具。</p>
<h2>1. 获取 API Key</h2>
<p>请平台管理员在「接入管理 → API Key」签发并启用 Key，保存直接能力配置（至少包含可用模型）。如果需要 MCP，请同时授权相应的 Server 和工具。将 Key 保存在服务端密钥管理系统中，在请求中使用 <code>Authorization: Bearer &lt;API Key&gt;</code>。</p>
<p>下列命令使用 Bash、curl 和 jq。把示例域名替换为管理员提供的服务地址，按提示输入真实 Key。页面中所有 ID、工单编号、Token 和响应值均为示例。</p>
${codeBlock('BASE_URL="https://agent.example.com"\nread -rsp "Router API Key: " AAAS_API_KEY; echo', "设置服务地址和 Key")}
<h2>2. 创建纯模型 Task</h2>
<p>Task 保存多轮上下文。每条 <code>prompt</code> 或 <code>input</code> 受理后产生一个 Operation，同一 Task 内按序执行。创建返回 HTTP 201 和两个 ID。设置 <code>mcp_servers: []</code> 可以显式关闭本轮 MCP。</p>
${codeBlock(`IDEMPOTENCY_KEY="create-$(uuidgen)"\ncreated=$(\n  ${create}\n)\nprintf '%s\\n' "$created" | jq .\nTASK_ID=$(jq -er '.data.task_id' <<< "$created")\nOPERATION_ID=$(jq -er '.data.operation_id' <<< "$created")`, "创建并保存 ID")}
<p>若系统没有 <code>uuidgen</code>，可使用业务系统生成的唯一请求 ID。网络超时或 5xx 后，重试同一写入要复用原幂等键和 JSON。相同请求返回相同 ID 和 <code>duplicate: true</code>；同键改正文会返回 409。同一 Key 的创建键与各 Task 的追加键使用独立作用域。</p>
<h2>3. 查询执行结果</h2>
<p>受理后从 HTTP 200 的 <code>data.status</code> 判断执行状态。<code>queued</code> 和 <code>running</code> 时继续轮询；成功从 <code>data.result</code> 读取文本；失败或取消时检查 <code>data.error.code</code> 或 <code>data.cancel_reason</code>。</p>
${codeBlock(
	`poll_operation() {
  local response status
  for ((attempt=0; attempt<60; attempt++)); do
    response=$(
      ${operation}
    ) || { printf '%s\\n' "$response" >&2; return 1; }
    status=$(jq -er '.data.status' <<< "$response") || return 1
    case "$status" in
      queued|running) sleep 2 ;;
      completed) jq -r '.data.result' <<< "$response"; return ;;
      failed|canceled) jq '.data | {status,error,cancel_reason}' <<< "$response" >&2; return 1 ;;
      *) return 1 ;;
    esac
  done
  printf '轮询已暂停，请稍后继续查询 %s\\n' "$OPERATION_ID" >&2
  return 1
}
poll_operation`,
	"轮询 Operation",
)}
<h2>4. 追加输入</h2>
<p>首轮成功后，向同一个 Task 追加新输入，换一个幂等键。HTTP 202 返回新 Operation ID，用它继续轮询。失败会取消已经排队的后续轮次；只要 Task 未永久取消，仍可提交新的输入。</p>
${codeBlock(`IDEMPOTENCY_KEY="input-$(uuidgen)"\nappended=$(\n  ${append}\n)\nif OPERATION_ID=$(jq -er '.data.operation_id' <<< "$appended"); then\n  poll_operation\nfi`, "追加并查询新 Operation")}
<h2>5. 发现并选择 MCP</h2>
<p>先查 <a href="#listApiKeyMcpServers">Server 概要</a>，再用返回的 <code>server_id</code> 查 <a href="#getApiKeyMcpServer">详情</a>。双入口 Key 查询 Router 授权时带 <code>X-Router-Capability-Scope: router</code>，省略会得到旧配置范围。</p>
${codeBlock(
	`${curl("GET", mcpPath)}
read -rp "选择真实 MCP Server ID: " MCP_SERVER_ID
${curl("GET", `${mcpPath}/$MCP_SERVER_ID`)}`,
	"发现 Server 和工具",
)}
<p>查看 <code>tools[].input_schema</code>，在输入中说明要用的工具和业务参数。选中 Server 即授权本轮使用该 Server 的工具，模型根据输入决定是否调用。省略 <code>mcp_servers</code> 时选中所有可用 Server，相应凭据要求也一并生效。</p>
<h3>使用无需业务凭据的 MCP</h3>
<p>选择 <code>credential_requirements.tool_credential</code> 为 <code>false</code> 的 Server。将下列知识库问题改成授权工具能处理的请求。</p>
${codeBlock(
	`IDEMPOTENCY_KEY="knowledge-$(uuidgen)"
payload=$(jq -n --arg id "$MCP_SERVER_ID" --arg prompt '${createExamples.mcpWithoutCredential.value.prompt}' \\
  '{prompt:$prompt,mcp_servers:[$id]}')
created=$(\n  ${curl("POST", taskPath, '"$payload"')}\n)
if OPERATION_ID=$(jq -er '.data.operation_id' <<< "$created"); then
  poll_operation
fi`,
	"创建无需业务凭据的 MCP Task",
)}
<h3>使用需要业务凭据的 MCP</h3>
<p>选择 <code>credential_requirements.tool_credential</code> 为 <code>true</code> 的 Server，查看 <code>required_credentials</code> 确认哪些工具参数由平台注入。从业务系统获取 Token。连接方式 <code>authentication</code> 只描述平台如何连接 Server，业务 Token 按 Server 单独提交，每个 Operation 都要重新提供。请使用真实授权的 Server 和工单编号替换示例。</p>
${codeBlock(
	`read -rp "智慧工单 MCP Server ID: " MCP_SERVER_ID
read -rsp "智慧工单业务 Token: " TOOL_TOKEN; echo
IDEMPOTENCY_KEY="ticket-$(uuidgen)"
payload=$(printf '%s' "$TOOL_TOKEN" | jq -Rs --arg id "$MCP_SERVER_ID" \\
  --arg prompt '${createExamples.mcp.value.prompt}' \\
  '{prompt:$prompt,mcp_servers:[$id],credentials:{servers:{($id):{tool_credential:.}}}}')
created=$(\n  ${curl("POST", taskPath, "@-")} <<< "$payload"\n)
unset TOOL_TOKEN payload
if OPERATION_ID=$(jq -er '.data.operation_id' <<< "$created"); then
  poll_operation
fi`,
	"创建使用业务 Token 的 MCP Task",
)}
<h2>排查常见错误</h2>
<p>HTTP 4xx/5xx 时先检查 <code>error.code</code>。401 检查 Key，403 检查能力范围与配置，400 检查请求字段及凭据要求，429 等待队列腾出后再试。保存 <code>requestId</code> 供平台查询。HTTP 200 查询到执行失败时，按 <a href="#execution-errors">Operation 错误和取消原因</a>处理。</p>
</article>`;
}

function reference(method: string, path: string, operation: Operation): string {
	const media = operation.requestBody?.content["application/json"];
	const success = Object.entries(operation.responses).find(([status]) => status.startsWith("2"))!;
	const response = success[1].content["application/json"];
	const requestPath = path
		.replace("{server_id}", "$MCP_SERVER_ID")
		.replace("{id}", path.includes("/operations/") ? "$OPERATION_ID" : "$TASK_ID");
	const query = path.endsWith("/events") ? "?limit=2" : "";
	const headers = operation.parameters.filter((parameter) => parameter.in === "header");
	const auth = routerOpenApi.components.securitySchemes.ApiKey;
	const parameterGroup = (kind: string) => {
		const entries = operation.parameters.filter((parameter) => parameter.in === kind);
		return entries.length
			? entries.map((p) => field(p.name, p.schema, p.required, p.description)).join("")
			: '<p class="muted">无</p>';
	};
	return `<article class="endpoint" id="${escapeHtml(operation.operationId)}">
<div class="endpoint-body">
<h2>${escapeHtml(operation.summary)}</h2>
<div class="route"><span class="method ${method.toLowerCase()}">${method}</span><code>${escapeHtml(path)}</code></div>
<p>${escapeHtml(operation.description)}</p>
<h3>请求</h3>
<h4>请求头</h4>
${field(auth.name, { type: "string" }, true, auth.description)}
${media ? field("Content-Type", { type: "string", enum: ["application/json"] }, false, "发送 JSON Body 时请设置此头。服务端按 JSON 解析正文，省略请求头时亦按此方式解析。") : ""}
${headers.map((p) => field(p.name, p.schema, p.required, p.description)).join("")}
<h4>路径参数</h4>${parameterGroup("path")}
<h4>Query 参数</h4>${parameterGroup("query")}
<h4>Body 参数</h4>
${media ? `<p>${operation.requestBody?.required ? "必填 JSON 对象" : "可选 JSON 对象，省略按空对象处理"}。请求体最大 96 KiB。</p>${fields(media.schema)}` : '<p class="muted">无</p>'}
<h3>响应 <span class="http-ok">${success[0]}</span></h3><p>${escapeHtml(success[1].description)}</p>
${fields(response.schema)}
<h3>HTTP 错误</h3>
<p>错误信封含 <code>error.code</code>、<code>message</code>、<code>requestId</code> 和 <code>retryable</code>，其中 5xx 的 <code>retryable</code> 为 true。</p>
<div class="errors">${Object.entries(operation.responses)
		.filter(([status]) => !status.startsWith("2"))
		.map(([status, error]) =>
			examples(error.content["application/json"])
				.map(
					(item) =>
						`<div><code>${escapeHtml(status)} ${escapeHtml(item.summary)}</code><p>${escapeHtml(item.description ?? error.description)}</p></div>`,
				)
				.join(""),
		)
		.join("")}</div>
${operation.operationId === "routerGetOperation" ? `<h3 id="execution-errors">执行错误与取消原因</h3><div class="errors">${executionErrors.map(([code, help]) => `<div><code>${code}</code><p>${help}</p></div>`).join("")}</div>` : ""}
</div>
<aside class="endpoint-examples" aria-label="接口示例">
<h3>请求示例</h3>
<p class="muted">沿用快速开始的环境变量。示例 ID 和 Token 需要替换。${operation.requestBody?.required ? "每次新写入请生成新幂等键。" : ""}</p>
${(media ? examples(media) : [{ summary: "cURL", value: undefined }])
	.map((item) => codeBlock(curl(method, requestPath + query, item.value), item.summary))
	.join("")}
<h3>成功响应</h3>
${examples(response)
	.map((item) => codeBlock(json(item.value), `HTTP ${success[0]} · JSON`))
	.join("")}
</aside>
</article>`;
}

const operations = Object.entries(routerOpenApi.paths).flatMap(([path, methods]) =>
	Object.entries<Operation>(methods).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
);

export function routerDeveloperPage(base: string): string {
	const links = (group: typeof operations) =>
		group
			.map(
				({ method, operation }) =>
					`<a href="#${escapeHtml(operation.operationId)}"><span class="method ${method.toLowerCase()}">${method}</span>${escapeHtml(operation.summary)}</a>`,
			)
			.join("");
	return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Router V1 API</title><link rel="stylesheet" href="${base}/router.css">
<script defer src="${base}/router.js"></script></head>
<body>
<header class="top"><a class="brand" href="#quick-start">Agent 平台 <span>AaaS Router V1</span></a>
<nav aria-label="文档导航"><a href="#quick-start">快速开始</a><a href="#api-reference">API 参考</a></nav>
<a class="download" href="${base}/v1/public/openapi.json">OpenAPI JSON</a></header>
<div class="layout">
<nav class="sidebar" aria-label="接口目录">
<a class="quick-link" href="#quick-start">快速开始</a>
<h2>Router 接口</h2>${links(operations.filter(({ path }) => !path.startsWith(mcpPath)))}
<h2>MCP 发现</h2>${links(operations.filter(({ path }) => path.startsWith(mcpPath)))}
</nav>
<main>
${quickStart()}
<section id="api-reference"><h1>API 参考</h1><p class="intro">各接口使用同一 API Key 认证。成功响应使用 <code>{data, requestId}</code>，请求和响应示例中的值仅用于演示。</p>
${operations.map(({ method, path, operation }) => reference(method, path, operation)).join("")}
</section></main></div>
<div role="status" id="copy-status" class="sr-only"></div>
</body></html>`;
}

export const routerDeveloperScript = `document.addEventListener("click", async (event) => {
  const button = event.target.closest(".copy");
  if (!button) return;
  const code = button.closest(".sample").querySelector("pre");
  try {
    await navigator.clipboard.writeText(code.textContent);
    button.textContent = "已复制";
    document.querySelector("#copy-status").textContent = "示例已复制";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = "已选中";
    document.querySelector("#copy-status").textContent = "已选中示例，可按 Ctrl+C 或 Command+C 复制";
  }
  setTimeout(() => { button.textContent = "复制"; }, 1800);
});
function markCurrent() {
  const current = location.hash || "#quick-start";
  document.querySelectorAll("nav a").forEach((link) => {
    if (link.hash === current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}
window.addEventListener("hashchange", markCurrent);
markCurrent();`;

export const routerDeveloperStyles = `
:root{color-scheme:light;--accent:#0057ff;--ink:#111318;--muted:#526074;--line:#e1e6ee;--soft:#f4f8ff;--header:64px;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink)}
*{box-sizing:border-box}
body{margin:0;background:#fff;font-size:15px;line-height:1.65}
a{color:var(--accent);text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.top{position:sticky;top:0;z-index:1;height:var(--header);display:flex;align-items:center;gap:32px;padding:0 28px;background:#fff;border-bottom:1px solid var(--line)}
.top a,.sidebar a{text-decoration:none}
.brand{font-weight:750;color:var(--ink);white-space:nowrap}
.brand span{font-size:13px;margin-left:8px;color:var(--muted)}
.top nav{display:flex;align-items:center;gap:22px}
.top nav a{color:var(--muted);white-space:nowrap}
.top nav a:hover,.top nav [aria-current]{color:var(--accent)}
.download{margin-left:auto;border:1px solid var(--line);padding:5px 12px;border-radius:8px;white-space:nowrap;font-size:13px}
.layout{display:grid;grid-template-columns:255px minmax(0,1fr);max-width:1660px;margin:auto}
.sidebar{position:sticky;top:var(--header);height:calc(100dvh - var(--header));overflow:auto;padding:26px 14px;border-right:1px solid var(--line)}
.sidebar h2{color:var(--muted);font-size:12px;margin:20px 10px 6px;font-weight:650}
.sidebar a{display:flex;gap:8px;align-items:baseline;padding:8px 10px;color:var(--ink);border-radius:8px;font-size:13px}
.sidebar a:hover,.sidebar [aria-current]{background:var(--soft);color:var(--accent)}
.quick-link{font-weight:650}
main{min-width:0;padding:38px clamp(22px,4vw,62px) 80px}
[id]{scroll-margin-top:calc(var(--header) + 20px)}
#quick-start{max-width:800px;padding-bottom:40px}
#api-reference{border-top:1px solid var(--line);padding-top:28px}
h1,h2,h3,h4{line-height:1.38}
h1{margin:0 0 10px;font-size:36px;letter-spacing:-.04em}
h2{margin:28px 0 10px;font-size:23px}
h3{margin:24px 0 10px;font-size:17px}
h4{margin:16px 0 6px;font-size:14px;color:var(--muted)}
p{margin:8px 0 14px}
.intro,.muted{color:var(--muted)}
.intro{font-size:17px}
.endpoint{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:28px;border-top:1px solid var(--line);padding:26px 0;margin-top:27px}
.endpoint h2,.endpoint-examples h3:first-child{margin-top:0}
.route{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}
.method,.http-ok{font:650 11px "JetBrains Mono",Menlo,Consolas,monospace;padding:3px 6px;border-radius:5px;color:#0046cc;background:#e8f1ff}
.method.get,.http-ok{color:#176046;background:#e7f5ee}
code,pre{font-family:"JetBrains Mono","IBM Plex Mono",Menlo,Consolas,monospace}
p code,.route code,.errors code{color:#223759;background:#f1f4f9;padding:2px 4px;border-radius:4px;overflow-wrap:anywhere}
.field{padding:9px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.field p{margin:5px 0 0}
.field small,.type,.optional{color:var(--muted)}
.type,.required,.optional{font-size:12px;padding:2px 5px}
.required{color:#9c341a;background:#fff0ea;border-radius:4px}
.nested{margin:8px 0 0 8px;padding-left:12px;border-left:2px solid #d7e5ff}
summary{cursor:pointer}
.errors{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.errors div{padding:8px 11px;background:#fff;overflow-wrap:anywhere}
.errors p{margin:4px 0}
.sample{margin:12px 0 16px;border:1px solid #dbe3ef;border-radius:10px;overflow:hidden;background:#f7f9fc}
.sample-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
.copy{font:inherit;color:#0046cc;background:#fff;border:1px solid #cad7ec;border-radius:7px;padding:3px 10px;cursor:pointer;white-space:nowrap}
.copy:hover,.download:hover{background:#e8f1ff}
pre{margin:0;padding:13px;overflow:auto;color:#172c4b;font-size:12px;line-height:1.65;tab-size:2;white-space:pre-wrap;overflow-wrap:anywhere}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media(max-width:1100px){.layout{grid-template-columns:210px minmax(0,1fr)}.endpoint{display:block}.endpoint-examples{margin-top:20px}}
@media(max-width:680px){:root{--header:96px}.layout{display:block}.top{height:var(--header);display:grid;grid-template-columns:1fr auto;gap:4px;padding:10px 16px}.top nav{grid-row:2;grid-column:1 / -1}.download{grid-row:1;grid-column:2}.sidebar{position:static;height:auto;border:0;border-bottom:1px solid var(--line);padding:12px 16px}.sidebar h2{margin-top:10px}main{padding:24px 16px 48px}h1{font-size:28px}}
`;

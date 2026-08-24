# M1 metrics/context 浏览器联调 evidence log（2026-08-24）

> 共同验收基线 `verify/agent-v2-m0-acceptance` @ `6e15804`（含 `a2af75e` R3 follow-up），
> 在 `feature/agent-v2-m1-frontend` 增量补充 R1（typecheck baseline，`242004c`）后联调。
> 目标：把 8 类场景的真实前端表现 + request ID + conversation ID + 异常证据
> 落盘，让后续 M1 总验收无需再次手动跑。

## 0. 起环境（前置）

```bash
# Worktree A — 后端（M1 features）
cd /home/hello/workspace/skdy-agent-backend
git log --oneline -1    # 应是 M1 tip（带 metrics/context/reasoning 路由）
npm --prefix runtimes/pi run check  # 类型 + 打包门禁

# Worktree B — 前端（M1 R3 + R1 baseline）
cd /home/hello/workspace/skdy-agent-frontend/runtimes/pi
./scripts/start-admin-dev.sh &     # PG/Redis + control + web
# 等脚本 echo "Admin Token: ..." 与 vite ready

# 浏览器打开 http://localhost:5173 (admin) 与 /embed/pub_<uuid> (embed)
# admin dev token 取自 runtimes/pi/.pi/admin-dev/control-admin-token
```

> 端口约定：web=5173，embed=5174，control=http=4001（见 `start-admin-dev.sh`）。

## 1. 场景清单（必跑）

每个场景记录：

- **request ID**（HTTP 响应 `X-Request-Id` 头或 body `data.requestId`）
- **conversation ID**（被测会话的 `pub_…` 或 `conv_…` 公共 ID）
- **devtools network 状态**（200/4xx/5xx、cancelled/aborted、res size）
- **前端行为**（MetricsRow 渲染、EmptyState 文案、retryable 按钮可见性、AbortError 是否吞掉）
- **异常证据**（截图或堆栈片段，可附链接）

### Scenario 1 — 成功

| 字段 | 期望 |
| --- | --- |
| URL | `/admin/conversations/conv_<正常带 turns>` |
| 期望 HTTP | `GET /api/control/v1/conversations/conv_<…>/metrics 200` |
| 前端 | `data.stats.available=true` → `MetricsRow` 4 行渲染；p50/p95 显示数值；明细表非空 |
| 异常路径 | 无 |

### Scenario 2 — 空态

| 字段 | 期望 |
| --- | --- |
| URL | `/admin/conversations/conv_<刚创建无 turn>` |
| 期望 HTTP | `200`，body `stats.available=false, items=[]` |
| 前端 | EmptyState 显示"暂无指标"或"旧会话无指标"分支（**不**进 error） |
| 异常路径 | 无 |

### Scenario 3 — legacy 旧会话

| 字段 | 期望 |
| --- | --- |
| URL | pre-V2 旧会话（`turn/end` 无 `metrics` 字段） |
| 期望 HTTP | `200`，body `stats.available=false` 或聚合结果 |
| 前端 | 不应崩溃；EmptyState "旧会话无指标" 文案（reason=`legacy_session`） |
| 异常路径 | 派生逻辑 `deriveTurnMetrics` 在 turn 数据缺字段时不应抛错 |

### Scenario 4 — 错误（METRICS_UNAVAILABLE）

| 字段 | 期望 |
| --- | --- |
| 触发 | 关掉 M1 feature flag 或打错 endpoint |
| 期望 HTTP | `503`，body `error.code = "METRICS_UNAVAILABLE"` |
| 前端 | `describeError` → title "指标服务暂不可用" + 重试按钮可见（`retryable=true`） |
| 异常路径 | `toDataStateError` 不漂改 `retryable`（保持协议表为权威） |

### Scenario 5 — 无权限（跨租户）

| 字段 | 期望 |
| --- | --- |
| 触发 | admin token 跨租户访问会话 |
| 期望 HTTP | `404`，body `error.code = "CONVERSATION_NOT_FOUND"`（**不**暴露归属） |
| 前端 | 进入 error 状态；不暴露"无权访问"字样（与 404 一致） |

### Scenario 6 — 分页

| 字段 | 期望 |
| --- | --- |
| 操作 | 在已加载页面点"加载下一页" |
| 期望 HTTP | 第二次 `GET /metrics?afterSequence=N&limit=50 200` |
| 前端 | `URL.searchParams.get("afterSequence") === "N"`；`nextAfterSequence` 推进 |
| 异常路径 | `afterSequence=0` 必须 omit 参数（首页） |

### Scenario 7 — 重试

| 字段 | 期望 |
| --- | --- |
| 触发 | scenario 4 错误态后点"重试" |
| 期望 HTTP | 重新 `GET /metrics`（可能仍 503 或恢复 200） |
| 前端 | 按钮可点；不重复触发已取消的 signal |

### Scenario 8 — 快速切换 conversation

| 字段 | 期望 |
| --- | --- |
| 操作 | 在加载 metrics 时点击另一个会话（路由 `conversationId` 变更） |
| 期望 | 前一请求 `devtools network` 显示 `(cancelled)`；新会话请求发出；UI 只显示新会话数据 |
| 异常路径 | `StaleResponseGuard` abort 老 ticket；`commit` 在代际不匹配时早退 |

## 2. Evidence 模板（每场景一行）

```yaml
- scenario: 1
  date: 2026-08-24
  conversation_id: conv_<id>
  request_ids: [req_<…>]
  http_status: 200
  frontend_state: loaded
  evidence_link: <截图或 devtools 导出>
  notes: |
    p50/p95 数值正常；明细表呈现 50 条。
```

## 3. 已知限制与人工标注位

- **`start-admin-dev.sh` 起 admin 服务默认绑 http://localhost**——非 127.0.0.1，hosts 文件需保留。
- **M1 feature flag** 默认关；`packages/server/src/agent-v2/feature-flag.ts` 描述了开启条件；本验收前先 `PI_AGENT_V2_METRICS_CONTEXT=on` 起 server。
- **Avatar @rive-app/canvas** 不影响本场景（avatar 是另一条 build target）。

## 4. 验收 checklist

- [ ] Scenario 1 通过
- [ ] Scenario 2 通过
- [ ] Scenario 3 通过
- [ ] Scenario 4 通过
- [ ] Scenario 5 通过
- [ ] Scenario 6 通过
- [ ] Scenario 7 通过
- [ ] Scenario 8 通过
- [ ] 所有 8 场景的 request ID 落盘
- [ ] 异常堆栈 / 截图归档

## 5. 关联提交

- `a2af75e` — M1 R3 follow-up（已合入 verify/agent-v2-m0-acceptance）
- `51ad21d` — M1 R3
- `d8e8351` — M1 R2
- `3a03540` — M1 R1 骨架
- `242004c` — M1 typecheck baseline（R1，本文件配套）
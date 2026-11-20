# Router Bash 离线运行环境

## 准备

当前脚本支持 Ubuntu 24.04 Linux 上的 Python 3.12.3、Node v22.23.2 和 Pillow 10.2.0。准备机需要预装 Bash、coreutils、findutils、grep、sed、awk、Python、`python3-pil`、Node 与 bwrap。节点须允许 bwrap 建立用户、PID 和网络命名空间。

- Python 由 Ubuntu APT/dpkg 提供，来源是 `python3.12-minimal` 的 `/usr/bin/python3.12` 和 `/usr/lib/python3.12` 标准库。脚本将解释器复制到运行根的 `usr/bin/python3`，另建 `python` 链接。Task 执行的是挂载后的 `/usr/bin/python3`，其标准库和依赖与平台服务自身环境分开。
- Pillow 由准备机上的 Ubuntu 软件包 `python3-pil` 提供（部署方可用 `apt-get install python3-pil=<固定的软件包版本>` 安装）。脚本从准备机的 `/usr/lib/python3/dist-packages` 复制 `PIL` 和版本元数据。Sandbox 的 `PYTHONPATH` 指向同名路径，当前依赖位于该 `dist-packages`。准备脚本未使用 uv 或 pip。
- Node.js 由部署方预装，脚本接收该二进制的绝对路径并复制到运行根的 `usr/bin/node`。脚本也从准备机复制选定的系统命令和必要的动态库。
- 保留同架构 Ubuntu 软件包快照、所用 Node 二进制及脚本生成的 `pi-runtime-manifest`。清单记录关键软件包版本、复制的 Python 分发包目录及 Node SHA-256。准备机软件包快照用于复现传递依赖和共享库。

```bash
# 从仓库根目录运行。runtime 参数须指向新目录。
bash runtimes/pi/scripts/prepare-sandbox-runtime.sh "$PWD/offline-runtime" "$(command -v node)"
# 实际部署选择服务可访问的专用目录，避免放在宿主服务数据目录中。
export PI_SANDBOX_RUNTIME_DIR="$PWD/offline-runtime"
export PI_SANDBOX_WORKSPACE_DIR="/absolute/private/router-workspaces"
```

让 Pi Web 服务进程继承这两个环境变量并应用数据库迁移至 0037。运行根由部署方维护，服务用户可读，Task 统一只读挂载在 `/`。工作区根归服务用户所有且权限为 0700。先验证同一服务身份的 bwrap 能力，再在现有 Key 配置勾选「允许 Bash（Linux Sandbox）」。同一 Key 的 MCP 白名单独立，不能同时授权一个名叫 `bash` 的 MCP 工具。缺少可用隔离环境时，授权 Operation 会失败。

更新 Python 依赖时，在准备机的软件包快照中固定版本及其传递依赖，在脚本的 `python_distributions` 列表里登记模块和对应的 `.dist-info` 或 `.egg-info`，将新增的软件包加入 manifest 的 `dpkg-query` 清单。修改 Pillow、Python 或 Node 版本时同步更新脚本的版本检查。构建新的目录，在隔离环境验证解释器和依赖导入后，切换服务的 `PI_SANDBOX_RUNTIME_DIR`。让旧服务和在用 bwrap 进程结束后再回收旧目录。同一 Task 工作区可随新运行根继续使用。运行期间各 Task 共享离线依赖，网络和公共依赖写入由现有 Sandbox 隔离。

## 管理端

「Sandbox 环境」的运行环境 Tab 在当前服务节点用同一 Bubblewrap 启动方式探测 Bash、Python、Node 和全部可见 Python 分发包。探测使用临时工作区并跳过 Python 用户级包目录。刷新会重新探测，失败时显示当前错误。请求和环境路径仅对已认证管理员可见。

两个只读接口位于 `/api/admin/v1/aaas/keys/sandbox/environment` 和 `/api/admin/v1/aaas/keys/sandbox/statistics`，后者接受 `hours=24|168|720`。两者共用现有管理端鉴权。

趋势图以与总数相同的事件集按北京时间聚合，近 24 小时按小时显示，近 7 天和 30 天按天显示，空时段计为 0。环图合计超时与取消，最近记录保留各自状态。

执行统计使用迁移 0037 之后产生的内部 `sandbox.execution` 事件。每次进入 bwrap 启动的尝试写一条结束记录，包含开始和结束时间、耗时及固定原因码。耗时从调用进程启动到退出或清理确认超时，以单调时钟计算。服务端按结果入库时间筛选 24 小时、7 天或 30 天，计算成功数占全部结果的比率、平均耗时与离散 P95，并返回最近 50 条。进程收到取消信号时归入取消，耗尽命令时限或 Operation 截止时间时归入超时。

运行根或工作区的前置检查失败会沿用 Operation 错误。尚未进入 bwrap 的调用、模型与 MCP 执行、普通工具轨迹、迁移前记录和探测进程均不产生 Sandbox 统计。进程异常退出且来不及写结果时可能缺少一条记录。首版仅统计有结果的调用，页面无实时执行数。详情链接复用 Router Operation 轨迹和原有权限。点击执行轨迹中的 Bash 行可查看命令与输出，分别脱敏并限长至 4,096 字符。

## 复现

具有 Bash 授权的 Router-only Key 可发如下请求。双入口 Key 按现有契约额外发送 `X-Router-Capability-Scope: router`。对响应的 `operation_id` 轮询 `GET /api/aaas/v1/operations/{operation_id}`，并在对应 Operation 轨迹查看内置 Bash 结果。

```bash
curl -fsS "$PI_URL/api/aaas/v1/tasks" \
  -H "Authorization: Bearer $ROUTER_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: offline-python-demo' \
  -d '{"prompt":"用 Bash 工具调用 Python 3 解析 CSV 数值 17,24,36，求和并写入 python-result.txt。打印并回复程序实际输出。","mcp_servers":[]}'

curl -fsS "$PI_URL/api/aaas/v1/tasks" \
  -H "Authorization: Bearer $ROUTER_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: offline-node-demo' \
  -d '{"prompt":"用 Bash 工具运行 Node.js，计算 7*11 + 2*5，把结果写入 node-result.txt。打印并回复程序实际输出。","mcp_servers":[]}'
```

隔离测试与端到端复现可以共用一份运行根。在 `runtimes/pi/packages/server` 下设置隔离测试 PostgreSQL 的管理连接串。真模型测试接受支持工具调用的本机回环 OpenAI 兼容端点，默认模型 ID 为 `Qwen`。

```bash
export PI_ROUTER_TEST_DATABASE_URL="<isolated test database admin URL>"
export PI_SANDBOX_TEST_RUNTIME="/absolute/path/to/offline-runtime"
export PI_SANDBOX_TEST_MODEL_URL="http://127.0.0.1:8000/v1"
node ../../node_modules/vitest/dist/cli.js --run --no-cache \
  test/runtime/sandbox.test.ts test/orchestration/router-runtime.test.ts
```

设置 `PI_SANDBOX_TEST_RUNTIME` 即可运行并发用例，测试模型按固定顺序发出工具调用，Router HTTP、PostgreSQL、Pi、Bubblewrap 和 Python/Node 执行为真实环境。用例同时观察两套 bwrap 进程，检查开始与结束时间重叠、私有文件互不可见、不同 PID / 网络命名空间、同一运行根只读和两者均清理。额外设置 `PI_SANDBOX_TEST_MODEL_URL` 可运行真实 Qwen 的工具选择和执行回归。

## 本轮并发验收

2026-11-19 使用临时运行根 `/tmp/pi-sandbox-observability.AUvYnQ/runtime`。实际运行时为 Bash 5.2.21(1)-release、Python 3.12.3、Node v22.23.2 和 Bubblewrap 0.9.0。Sandbox Python 可见的第三方分发包为 `pillow 10.2.0`，安装位置为 `/usr/lib/python3/dist-packages`。

| Task | Operation | Bash 开始与结束（UTC） | 耗时与结果 |
|---|---|---|---|
| Python `3e23028f-496a-4280-9be0-f211c7af454c` | `989b6890-119b-4b81-b23c-cdb7f4c8819d` | 10:10:21.718–10:10:22.005 | 287 ms，取消 |
| Node `d7279562-a932-4c24-99ed-113768aed05f` | `2705d87f-bdd8-4a47-af3d-234efa40827f` | 10:10:21.841–10:10:22.135 | 294 ms，成功 |

两次执行重叠 164 ms。宿主观测到两套 bwrap 进程（PID `3088463` 和 `3088469`）。PID 命名空间 inode 分别为 `4026534944` 和 `4026535813`，网络命名空间 inode 分别为 `4026534953` 和 `4026535816`。两个 Task 在对方私有文件已存在后验证其不可见，并通过文件 inode 确认读取同一运行根中的两种解释器。写入共享运行根均失败。取消 Python 后其 bwrap 退出，Node 继续执行并正常结束。测试确认两套 bwrap 均退出、两个 Task 均释放 Router 占用，随后清理验收库和工作区。

Node Operation 的三次 Bash 分别记录成功、退出码 7 和超时。加上 Python 的取消，本用例共增加四条 Sandbox 结果。相同回归中，本机 Qwen 自主选择 Bash 的 Python 和 Node 请求分别返回 `77` 和 `87`。

## 本地真模型验收

2026-11-19 在隔离测试库加载 Router，通过公开 HTTP 路由使用 Key 投递两个 Task。两次均由本机 vLLM 的 Qwen 模型选择 `bash`，执行轨迹记录 `linux-bwrap` 及成功的工具结果。验收读取了实际工具 Schema、冻结授权、Operation 返回和工作区文件。以下 ID 来自一次已清理的验收库。

| 请求 | Operation ID | Bash 输出 | 工作区文件 | 状态 |
|---|---|---:|---|---|
| Python 解析并求和 | `81ff3680-753c-432c-8a91-35ee12638763` | `77` | `python-result.txt` 内容为 `77` | `completed` |
| Node 执行 JavaScript 算式 | `3d52c856-87fc-4509-a581-445fa680c680` | `87` | `node-result.txt` 内容为 `87` | `completed` |

Faux Router 集成另验证了授权撤销对新 Operation 生效、已受理快照保持原授权、同 Task 文件连续性，以及 HTTP 取消后释放占用。真实 bwrap 测试覆盖宿主与其他 Task 文件、环境变量、回环网络、共享运行根只读，以及超时、取消和正常退出的子进程收尾。

## 生命周期与边界

每次 Bash 调用启动 bwrap，清空继承环境，隔离网络及 PID，只挂载专用运行根、本 Task 的工作区和私有临时目录。调用预算取 Operation 剩余时间和工具请求时限中的较小值。Bash 退出会回收 PID 命名空间，取消或超时终止本次执行。无法确认退出时沿用 Router 的待清理占用。Operation 管理页可读取内部工具历史中的限长结果。普通命令失败作为工具错误返回给模型，启动失败则使 Operation 失败。工具输出最多传递 32 KiB 或 1,000 行，管理轨迹最多显示 4,096 字符。

Task 工作区跨 Operation 保留，同一服务部署应为能接管该 Task 的 worker 提供一致的工作区路径。目录按租户和 Task 标识派生，运行时无跨宿主文件同步或自动回收。仅在 Task 确认退役且无待清理占用后由部署方清理。该边界未承诺 CPU、内存、进程或 workspace 大小配额。内核与极端宿主故障仍属于部署层保障范围。

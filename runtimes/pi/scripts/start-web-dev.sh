#!/usr/bin/env bash
set -euo pipefail

config_file="${PI_WEB_CONFIG:-.env.web.local}"
if [[ -f "$config_file" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$config_file"
	set +a
fi

if ! node_supported=$(node -p "const [major, minor] = process.versions.node.split(\".\").map(Number); major > 22 || (major === 22 && minor >= 19)"); then
	echo "Unable to determine Node.js version" >&2
	exit 1
fi
if [[ "$node_supported" != "true" ]]; then
	echo "Node.js 22.19 or newer is required" >&2
	exit 1
fi

web_ui_port="${PI_WEB_UI_PORT:-5173}"
server_port="${PI_WEB_SERVER_PORT:-8765}"
origin_args=(--allow-origin "${PI_WEB_ALLOWED_ORIGIN:-http://127.0.0.1:${web_ui_port}}")
if [[ -z "${PI_WEB_ALLOWED_ORIGIN:-}" ]]; then
	origin_args+=(--allow-origin "http://localhost:${web_ui_port}")
fi
export VITE_PI_WS_URL="${VITE_PI_WS_URL:-ws://127.0.0.1:${server_port}/api/pi/v1/ws}"
export PI_EMBED_DEV_PROXY_TARGET="${PI_EMBED_DEV_PROXY_TARGET:-http://127.0.0.1:${server_port}}"
generated_web_token=$(node -p "require(\"node:crypto\").randomBytes(32).toString(\"hex\")")
export PI_WEB_TOKEN="${PI_WEB_TOKEN:-$generated_web_token}"
export VITE_PI_WEB_TOKEN="${VITE_PI_WEB_TOKEN:-$PI_WEB_TOKEN}"

port_open() {
	node -e "const socket=require('node:net').connect($1, '127.0.0.1'); socket.once('connect', () => { socket.end(); process.exit(0); }); socket.once('error', () => process.exit(1));"
}

# 端口预检：上一套 dev 栈如果没退干净（常见于只杀掉外层 npm，留下孤儿 vite），
# 再跑一次 dev:admin 就会变成"新 backend + 旧 vite"的裂脑状态：两次启动各自随机
# 生成了不同的 PI_WEB_TOKEN，浏览器仍用旧 token 握手，WS 被 401 拒绝，页面只显示
# "WebSocket transport failed"。这里宁可整体失败，也不要启动半套。
for occupied_port in "$server_port" "$web_ui_port"; do
	if port_open "$occupied_port"; then
		echo "Port ${occupied_port} is already in use: a previous dev stack (backend or vite) is still running." >&2
		echo "Kill it first, then re-run dev:admin:" >&2
		echo "  pkill -f 'packages/server/src/web/cli.ts'; pkill -f 'vite --host'" >&2
		exit 1
	fi
done

server_pid=""
web_pid=""

# `npm run dev` 中间还隔着一层 npm/sh，只 kill 顶层 pid 会留下孤儿 vite 继续占端口，
# 因此按进程树自底向上收拾子进程。
kill_tree() {
	local target="$1" child
	for child in $(pgrep -P "$target" 2>/dev/null); do
		kill_tree "$child"
	done
	kill "$target" 2>/dev/null || true
}

cleanup() {
	trap - INT TERM EXIT
	if [[ -n "$web_pid" ]]; then kill_tree "$web_pid"; fi
	if [[ -n "$server_pid" ]]; then kill_tree "$server_pid"; fi
	# 优雅关闭最多等 5 秒，超时强杀：后端 drain 会话时可能长时间不退出。
	for _ in $(seq 1 50); do
		still_alive=false
		if [[ -n "$web_pid" ]] && kill -0 "$web_pid" 2>/dev/null; then still_alive=true; fi
		if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then still_alive=true; fi
		if [[ "$still_alive" == "false" ]]; then break; fi
		sleep 0.1
	done
	if [[ -n "$web_pid" ]]; then kill -9 "$web_pid" 2>/dev/null || true; fi
	if [[ -n "$server_pid" ]]; then kill -9 "$server_pid" 2>/dev/null || true; fi
	wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

./node_modules/.bin/tsx packages/server/src/web/cli.ts --port "$server_port" "${origin_args[@]}" "$@" &
server_pid=$!

# Do not expose Vite until its API/WebSocket proxy has a live backend.  Starting
# both processes concurrently made browsers that restored the last Embed page
# race the server boot and show a spurious ECONNREFUSED banner.
server_ready=false
for _ in $(seq 1 150); do
	if node -e "const socket=require('node:net').connect(${server_port}, '127.0.0.1'); socket.once('connect', () => { socket.end(); process.exit(0); }); socket.once('error', () => process.exit(1));"; then
		server_ready=true
		break
	fi
	if ! kill -0 "$server_pid" 2>/dev/null; then
		echo "Backend exited before it became ready." >&2
		wait "$server_pid"
		exit 1
	fi
	sleep 0.1
done
if [[ "$server_ready" != "true" ]]; then
	echo "Backend did not start listening on 127.0.0.1:${server_port} within 15 seconds." >&2
	exit 1
fi

npm run dev --workspace=@earendil-works/pi-web -- --host "${PI_WEB_HOST:-127.0.0.1}" --port "$web_ui_port" --strictPort &
web_pid=$!

# POSIX-portable wait: blocks until $server_pid exits, then returns. $web_pid
# becomes a zombie but is reaped by the EXIT trap. Equivalent to `wait -n` on
# GNU bash 4.3+, but works on macOS bash 3.2 (Apple's default) and the BSD
# variants that don't support the -n extension.
wait "$server_pid" "$web_pid"

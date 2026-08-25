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
allowed_origin="${PI_WEB_ALLOWED_ORIGIN:-http://127.0.0.1:${web_ui_port}}"
export VITE_PI_WS_URL="${VITE_PI_WS_URL:-ws://127.0.0.1:${server_port}/api/pi/v1/ws}"
export PI_EMBED_DEV_PROXY_TARGET="${PI_EMBED_DEV_PROXY_TARGET:-http://127.0.0.1:${server_port}}"
generated_web_token=$(node -p "require(\"node:crypto\").randomBytes(32).toString(\"hex\")")
export PI_WEB_TOKEN="${PI_WEB_TOKEN:-$generated_web_token}"
export VITE_PI_WEB_TOKEN="${VITE_PI_WEB_TOKEN:-$PI_WEB_TOKEN}"

server_pid=""
web_pid=""
cleanup() {
	trap - INT TERM EXIT
	if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi
	if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
	wait "$web_pid" "$server_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

./node_modules/.bin/tsx packages/server/src/web/cli.ts --port "$server_port" --allow-origin "$allowed_origin" "$@" &
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

npm run dev --workspace=@earendil-works/pi-web -- --host 127.0.0.1 --port "$web_ui_port" --strictPort &
web_pid=$!

# POSIX-portable wait: blocks until $server_pid exits, then returns. $web_pid
# becomes a zombie but is reaped by the EXIT trap. Equivalent to `wait -n` on
# GNU bash 4.3+, but works on macOS bash 3.2 (Apple's default) and the BSD
# variants that don't support the -n extension.
wait "$server_pid" "$web_pid"

#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

web_port="${PI_BROWSER_ACCEPTANCE_PORT:-5194}"
state_file=$(mktemp)
backend_log=$(mktemp)
web_log=$(mktemp)
backend_pid=""
web_pid=""
cleanup() {
	trap - EXIT INT TERM
	if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi
	if [[ -n "$backend_pid" ]]; then kill "$backend_pid" 2>/dev/null || true; fi
	wait "$web_pid" "$backend_pid" 2>/dev/null || true
	rm -f "$state_file" "$backend_log" "$web_log"
}
trap cleanup EXIT INT TERM

(
	cd packages/server
	PI_BROWSER_ACCEPTANCE_LOAD=1 \
	PI_BROWSER_ACCEPTANCE_ORIGIN="http://127.0.0.1:${web_port}" \
	PI_BROWSER_ACCEPTANCE_STATE_FILE="$state_file" \
		node ../../node_modules/vitest/dist/cli.js --run test/load/capacity-load.test.ts -t "keeps a complete browser acceptance server running"
) >"$backend_log" 2>&1 &
backend_pid=$!

for _ in $(seq 1 100); do
	if [[ -s "$state_file" ]]; then break; fi
	if ! kill -0 "$backend_pid" 2>/dev/null; then
		sed -n '1,160p' "$backend_log" >&2
		exit 1
	fi
	sleep 0.1
done
if [[ ! -s "$state_file" ]]; then
	echo "Browser acceptance backend did not become ready" >&2
	sed -n '1,160p' "$backend_log" >&2
	exit 1
fi

backend_base=$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).httpBase)' "$state_file")
public_app_id=$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).publicAppId)' "$state_file")

PI_EMBED_DEV_PROXY_TARGET="$backend_base" npm run dev --workspace=@earendil-works/pi-web -- \
	--host 127.0.0.1 --port "$web_port" --strictPort >"$web_log" 2>&1 &
web_pid=$!

for _ in $(seq 1 100); do
	if curl --fail --silent "http://127.0.0.1:${web_port}/embed/${public_app_id}" >/dev/null; then break; fi
	if ! kill -0 "$web_pid" 2>/dev/null; then
		sed -n '1,160p' "$web_log" >&2
		exit 1
	fi
	sleep 0.1
done

echo "Browser acceptance environment is ready."
echo "Public App ID: ${public_app_id}"
echo "Embed: http://127.0.0.1:${web_port}/embed/${public_app_id}"
echo "Host A: http://127.0.0.1:${web_port}/embed-demo/host-a.html"
echo "Host B: http://127.0.0.1:${web_port}/embed-demo/host-b.html"
echo "Keep this terminal open. Press Ctrl+C after completing the checklist."

wait -n "$backend_pid" "$web_pid"

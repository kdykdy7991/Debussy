#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

chrome_bin=$(command -v chromium || command -v google-chrome || true)
if [[ -z "$chrome_bin" ]]; then
	echo "Chrome/Chromium is required" >&2
	exit 2
fi

port="${PI_BROWSER_ACCEPTANCE_PORT:-5193}"
base="http://127.0.0.1:${port}"
tmp_root=$(mktemp -d)
vite_pid=""
cleanup() {
	trap - EXIT INT TERM
	if [[ -n "$vite_pid" ]]; then kill "$vite_pid" 2>/dev/null || true; fi
	wait "$vite_pid" 2>/dev/null || true
	rm -rf "$tmp_root"
}
trap cleanup EXIT INT TERM

npm run dev --workspace=@earendil-works/pi-web -- --host 127.0.0.1 --port "$port" --strictPort >"$tmp_root/vite.log" 2>&1 &
vite_pid=$!

ready=false
for _ in $(seq 1 50); do
	if curl --fail --silent "$base/embed-demo/host-a.html" >/dev/null; then
		ready=true
		break
	fi
	sleep 0.1
done
if [[ "$ready" != "true" ]]; then
	echo "Vite did not start" >&2
	sed -n '1,120p' "$tmp_root/vite.log" >&2
	exit 1
fi

public_app_id="pub_00000000-0000-7000-8000-000000000000"
urls=(
	"$base/embed-demo/host-a.html"
	"$base/embed-demo/host-b.html"
	"$base/embed/$public_app_id"
)
expected=("宿主演示 A" "宿主演示 B" "root")

for index in "${!urls[@]}"; do
	out="$tmp_root/page-$index.html"
	set +e
	timeout 30 "$chrome_bin" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
		--user-data-dir="$tmp_root/chrome-profile-$index" --virtual-time-budget=3000 \
		--dump-dom "${urls[$index]}" >"$out" 2>"$tmp_root/chrome-$index.log"
	chrome_status=$?
	set -e
	if [[ "$chrome_status" -ne 0 && ! -s "$out" ]]; then
		echo "Chrome failed for ${urls[$index]}" >&2
		sed -n '1,120p' "$tmp_root/chrome-$index.log" >&2
		exit 1
	fi
	if ! rg -q "${expected[$index]}" "$out"; then
		echo "Browser assertion failed for ${urls[$index]}" >&2
		sed -n '1,120p' "$tmp_root/chrome-$index.log" >&2
		exit 1
	fi
	echo "Browser loaded: ${urls[$index]}"
done

echo "Browser iframe shell smoke passed."
echo "Interactive chat/model validation still requires an activated App and an authorised model provider."

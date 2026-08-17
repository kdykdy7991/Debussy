#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

node_supported=$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 22 || (major === 22 && minor >= 19)')
if [[ "$node_supported" != "true" ]]; then
	echo "Node 22.19 or newer is required. Run: source /home/hello/.nvm/nvm.sh && nvm use" >&2
	exit 2
fi

export PI_TEST_DATABASE_URL="${PI_TEST_DATABASE_URL:-postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test}"
export PI_TEST_REDIS_URL="${PI_TEST_REDIS_URL:-redis://127.0.0.1:6380/15}"

echo "Injecting isolated TCP outages; Docker containers are not paused or modified."
cd packages/server
PI_FAULT_LOAD=1 node ../../node_modules/vitest/dist/cli.js --run test/load/fault-injection.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/embed/realtime-limits.test.ts test/embed/tts-queue.test.ts

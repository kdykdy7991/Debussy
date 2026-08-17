#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

required_node=$(tr -d '[:space:]' < .nvmrc)
current_node=$(node --version)
node_supported=$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 22 || (major === 22 && minor >= 19)')
if [[ "$node_supported" != "true" ]]; then
	echo "Node ${required_node} is required; current version is ${current_node}." >&2
	echo "Run: source /home/hello/.nvm/nvm.sh && nvm use" >&2
	exit 2
fi

export PI_TEST_DATABASE_URL="${PI_TEST_DATABASE_URL:-postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test}"
export PI_TEST_REDIS_URL="${PI_TEST_REDIS_URL:-redis://127.0.0.1:6380/15}"

echo "[1/4] Environment: Node ${current_node}, PostgreSQL and Redis probes"
node --input-type=module -e '
import net from "node:net";
const targets = [["PostgreSQL", 5433], ["Redis", 6380]];
for (const [name, port] of targets) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(new Error(`${name} probe timed out`)), 2000);
    socket.once("connect", () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once("error", reject);
  });
  console.log(`  ${name}: ready`);
}
'

echo "[2/4] Static quality gate"
npm run check

echo "[3/4] Publishing, Embed, runtime, metrics and protocol regression"
(
	cd packages/server
	node ../../node_modules/vitest/dist/cli.js --run \
		test/publishing \
		test/embed \
		test/runtime \
		test/protocol \
		test/metrics.test.ts \
		test/logging-redact.test.ts \
		test/web-start.test.ts
)

echo "[4/4] Capacity gate: 30 simultaneously in-flight turns, 3 rounds"
(
	cd packages/server
	PI_CAPACITY_LOAD=1 PI_CAPACITY_TURN_ROUNDS="${PI_CAPACITY_TURN_ROUNDS:-3}" \
		node ../../node_modules/vitest/dist/cli.js --run test/load/capacity-load.test.ts
)

echo "Automated MVP verification passed."
echo "Remaining release evidence: 1,000 Realtime connections for 30 minutes, fault injection, and browser iframe checks."

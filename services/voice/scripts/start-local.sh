#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/../../.." && pwd)"
config_file="${script_dir}/../.env.local"

if [[ ! -f "${config_file}" ]]; then
	printf 'Missing local configuration: %s\n' "${config_file}" >&2
	exit 1
fi

set -a
source "${config_file}"
set +a

cd "${repo_dir}"
exec uv run --package pi-voice-service pi-voice-service

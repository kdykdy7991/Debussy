#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

web_config="${PI_WEB_CONFIG:-.env.web.local}"
if [[ -f "$web_config" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$web_config"
	set +a
fi

state_dir="${PI_ADMIN_DEV_STATE_DIR:-$repo_dir/.pi/admin-dev}"
compose_file="$repo_dir/scripts/admin-dev-compose.yml"
mkdir -p "$state_dir"
chmod 700 "$state_dir"

admin_token_file="$state_dir/control-admin-token"
private_key_file="$state_dir/embed-access-private.pem"
public_key_file="$state_dir/embed-access-public.pem"
pepper_file="$state_dir/embed-subject-pepper"
tenant_id_file="$state_dir/tenant-id"

if [[ ! -s "$admin_token_file" ]]; then
	node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$admin_token_file"
	chmod 600 "$admin_token_file"
fi
if [[ ! -s "$pepper_file" ]]; then
	node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$pepper_file"
	chmod 600 "$pepper_file"
fi
if [[ ! -s "$tenant_id_file" ]]; then
	node -e 'process.stdout.write(require("node:crypto").randomUUID())' > "$tenant_id_file"
	chmod 600 "$tenant_id_file"
fi
if [[ ! -s "$private_key_file" || ! -s "$public_key_file" ]]; then
	command -v openssl >/dev/null 2>&1 || {
		echo "openssl is required to generate local Embed signing keys" >&2
		exit 1
	}
	openssl genpkey -algorithm ED25519 -out "$private_key_file"
	openssl pkey -in "$private_key_file" -pubout -out "$public_key_file"
	chmod 600 "$private_key_file" "$public_key_file"
fi

postgres_port="${PI_ADMIN_DEV_POSTGRES_PORT:-15432}"
redis_port="${PI_ADMIN_DEV_REDIS_PORT:-16379}"
web_server_port="${PI_WEB_SERVER_PORT:-8765}"
web_ui_port="${PI_WEB_UI_PORT:-5173}"
postgres_image="${PI_ADMIN_DEV_POSTGRES_IMAGE:-postgres:17-alpine}"
if [[ -z "${PI_ADMIN_DEV_POSTGRES_IMAGE:-}" ]] && ! docker image inspect "$postgres_image" >/dev/null 2>&1; then
	if docker image inspect skdy_prod-db:latest >/dev/null 2>&1; then
		postgres_image=skdy_prod-db:latest
		echo "Official PostgreSQL image is not cached; using compatible local image skdy_prod-db:latest"
	fi
fi

export PI_ADMIN_DEV_POSTGRES_PORT="$postgres_port"
export PI_ADMIN_DEV_REDIS_PORT="$redis_port"
export PI_ADMIN_DEV_POSTGRES_IMAGE="$postgres_image"
export PI_PUBLISHING_ENABLED=true
export PI_DATABASE_URL="postgresql://pi_admin_dev:pi_admin_dev@127.0.0.1:${postgres_port}/pi_admin_dev"
export PI_REDIS_URL="redis://127.0.0.1:${redis_port}/0"
export PI_BOOTSTRAP_TENANT_ID
PI_BOOTSTRAP_TENANT_ID=$(<"$tenant_id_file")
export PI_BOOTSTRAP_TENANT_NAME="Local Admin"
export PI_CONTROL_ADMIN_TOKEN_FILE="$admin_token_file"
# Embed/preview URLs are browser pages served by Vite, not Control API URLs.
# The backend port remains the proxy target below.
export PI_EMBED_ISSUER="http://127.0.0.1:${web_ui_port}"
export PI_EMBED_SUBJECT_PEPPER
PI_EMBED_SUBJECT_PEPPER=$(<"$pepper_file")
export PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE="$private_key_file"
export PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE="$public_key_file"
export PI_EMBED_ACCESS_TOKEN_KEY_ID="local-admin-dev"

docker compose --project-name pi-admin-dev --file "$compose_file" up --detach --wait

echo
echo "Admin Workbench: http://127.0.0.1:${web_ui_port}/"
echo "Admin Token: $(<"$admin_token_file")"
echo "Local PostgreSQL: 127.0.0.1:${postgres_port}"
echo "Local Redis: 127.0.0.1:${redis_port}"
echo "Stop infrastructure: npm run dev:admin:down"
echo

# Mirror the dev server URL into the workbench's proxy target. Both names are
# accepted by packages/web/vite.config.ts; admin-only mode reads
# PI_ADMIN_DEV_PROXY_TARGET, default mode reads PI_EMBED_DEV_PROXY_TARGET.
export PI_ADMIN_DEV_PROXY_TARGET="http://127.0.0.1:${web_server_port}"
export PI_EMBED_DEV_PROXY_TARGET="${PI_EMBED_DEV_PROXY_TARGET:-$PI_ADMIN_DEV_PROXY_TARGET}"

exec bash scripts/start-web-dev.sh "$@"

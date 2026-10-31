#!/usr/bin/env bash
# Starts the Wi-Fi Verse API on 127.0.0.1:8787 as root. The API token lives in <repo>/.token (mode 600).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOKEN_FILE=$ROOT/.token
PORT=${PORT:-8787}

if [[ ! -f $TOKEN_FILE ]]; then
  (umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$TOKEN_FILE")
fi

echo "API: http://127.0.0.1:$PORT   token file: $TOKEN_FILE"
exec sudo -n env WIFILAB_OWNER="$USER" WIFILAB_TOKEN_FILE="$TOKEN_FILE" \
  "$ROOT/.venv/bin/uvicorn" labd.api:app --app-dir "$ROOT" --host 127.0.0.1 --port "$PORT" --no-access-log

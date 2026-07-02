#!/usr/bin/env bash
set -euo pipefail

# Agent-style REST workflow for daemon control.
# Prerequisites:
# 1) Daemon is running (pnpm start:daemon).
# 2) Daemon page is open in browser: http://localhost:8788/daemon-agent.html
# 3) (Optional) Extension is installed and target page refreshed for cross-origin control.

DAEMON_API_URL="${DAEMON_API_URL:-http://localhost:8788}"
DAEMON_ID="${DAEMON_ID:-daemon-1}"
CLIENT_ID="${CLIENT_ID:-client-1}"
TARGET_URL="${TARGET_URL:-https://www.zhihu.com/signin?next=%2F}"
CHROME_BIN="${CHROME_BIN:-}"

# JSON array string. Example:
# export CHROME_PARAMS='[{"name":"--proxy-server","value":"http://127.0.0.1:8888"},{"name":"--bypass-proxy-list","value":"localhost,127.0.0.1"}]'
CHROME_PARAMS="${CHROME_PARAMS:-[]}"

json_post() {
  local path="$1"
  local body="$2"
  curl -sS -X POST "${DAEMON_API_URL}${path}" \
    -H 'Content-Type: application/json' \
    -d "$body"
  echo
}

echo "== status =="
curl -sS "${DAEMON_API_URL}/api/v1/status"
echo

echo "== launch chrome =="
json_post '/api/v1/chrome/launch' "$(cat <<JSON
{
  \"chrome\": \"${CHROME_BIN}\",
  \"params\": ${CHROME_PARAMS}
}
JSON
)"

echo "== open target page =="
json_post '/api/v1/page/open' "$(cat <<JSON
{
  \"name\": \"zhihu\",
  \"url\": \"${TARGET_URL}\"
}
JSON
)"

echo "== start connect + share =="
json_post '/api/v1/share/start' "$(cat <<JSON
{
  \"daemonId\": \"${DAEMON_ID}\",
  \"clientId\": \"${CLIENT_ID}\"
}
JSON
)"

echo "Now complete screen picker in daemon-agent browser tab if prompted."

echo "== status after share/start =="
curl -sS "${DAEMON_API_URL}/api/v1/status"
echo

echo "== close page =="
json_post '/api/v1/page/close' '{}'

echo "== exit chrome =="
json_post '/api/v1/chrome/exit' '{}'

echo "Workflow completed."

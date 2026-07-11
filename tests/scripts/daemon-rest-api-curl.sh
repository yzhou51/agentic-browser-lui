#!/usr/bin/env bash
set -euo pipefail

# Agent-style REST workflow for daemon control.
# Prerequisites:
# 1) Daemon is running (pnpm start:daemon).
# 2) Daemon page is open in browser: http://localhost:8788/daemon-agent.html

DAEMON_API_URL="${DAEMON_API_URL:-http://localhost:8788}"
DAEMON_ID="${DAEMON_ID:-daemon-1}"
CLIENT_ID="${CLIENT_ID:-client-1}"
SIGNALING_SERVER="${SIGNALING_SERVER:-http://localhost:8095}"
STUN_SERVER_URLS="${STUN_SERVER_URLS:-}"
TURN_SERVER_URLS="${TURN_SERVER_URLS:-}"
TURN_USERNAME="${TURN_USERNAME:-}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-}"
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

echo "== unified session start (launch + open + connect + wait resolve) =="
json_post '/api/v1/session/start' "$(cat <<JSON
{
  \"daemonId\": \"${DAEMON_ID}\",
  \"clientId\": \"${CLIENT_ID}\",
  \"targetUrl\": \"${TARGET_URL}\",
  \"signalingServer\": \"${SIGNALING_SERVER}\",
  \"stunUrls\": \"${STUN_SERVER_URLS}\",
  \"turnUrls\": \"${TURN_SERVER_URLS}\",
  \"turnUsername\": \"${TURN_USERNAME}\",
  \"turnCredential\": \"${TURN_CREDENTIAL}\",
  \"chrome\": \"${CHROME_BIN}\",
  \"chromeParams\": ${CHROME_PARAMS}
}
JSON
)"

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

echo "== action connect (signaling only) =="
json_post '/api/v1/action/connect' "$(cat <<JSON
{
  \"daemonId\": \"${DAEMON_ID}\",
  \"clientId\": \"${CLIENT_ID}\",
  \"signalingServer\": \"${SIGNALING_SERVER}\",
  \"stunUrls\": \"${STUN_SERVER_URLS}\",
  \"turnUrls\": \"${TURN_SERVER_URLS}\",
  \"turnUsername\": \"${TURN_USERNAME}\",
  \"turnCredential\": \"${TURN_CREDENTIAL}\",
  \"targetUrl\": \"${TARGET_URL}\"
}
JSON
)"

echo "== start connect + share =="
json_post '/api/v1/share/start' "$(cat <<JSON
{
  \"daemonId\": \"${DAEMON_ID}\",
  \"clientId\": \"${CLIENT_ID}\",
  \"signalingServer\": \"${SIGNALING_SERVER}\",
  \"stunUrls\": \"${STUN_SERVER_URLS}\",
  \"turnUrls\": \"${TURN_SERVER_URLS}\",
  \"turnUsername\": \"${TURN_USERNAME}\",
  \"turnCredential\": \"${TURN_CREDENTIAL}\"
}
JSON
)"

echo "Now complete screen picker in daemon-agent browser tab if prompted."

echo "== status after share/start =="
curl -sS "${DAEMON_API_URL}/api/v1/status"
echo

echo "== stop sharing =="
json_post '/api/v1/share/stop' '{}'

echo "== restart connect + share =="
json_post '/api/v1/share/start' "$(cat <<JSON
{
  \"daemonId\": \"${DAEMON_ID}\",
  \"clientId\": \"${CLIENT_ID}\",
  \"signalingServer\": \"${SIGNALING_SERVER}\",
  \"stunUrls\": \"${STUN_SERVER_URLS}\",
  \"turnUrls\": \"${TURN_SERVER_URLS}\",
  \"turnUsername\": \"${TURN_USERNAME}\",
  \"turnCredential\": \"${TURN_CREDENTIAL}\"
}
JSON
)"

echo "Now complete screen picker again in daemon-agent browser tab if prompted."

echo "== status after share restart =="
curl -sS "${DAEMON_API_URL}/api/v1/status"
echo

echo "== stop sharing before shutdown =="
json_post '/api/v1/share/stop' '{}'

echo "== close page =="
json_post '/api/v1/page/close' '{}'

echo "== exit chrome =="
json_post '/api/v1/chrome/exit' '{}'

echo "Workflow completed."

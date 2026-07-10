# @agentic-browser/agent

Agent subproject for daemon control actions.

This package serves `public/agent.html`, which calls daemon REST APIs and updates daemon-agent session/share state.

## Run

Before first run, create env file:

- PowerShell: `Copy-Item .env.example .env`
- Edit `.env` values as needed.

From workspace root:

- `pnpm start:agent`

From package folder:

- `pnpm start`

Dev mode (same static server behavior):

- `pnpm dev`
- From workspace root: `pnpm dev:agent`

This starts a local static server for this package and prints an `http://.../agent.html` URL.
Runtime defaults are generated from `.env` into `agent-demo.runtime.json`.

## Agent actions

The page orchestrates daemon APIs using the Agent page `Daemon API URL` field (default `http://localhost:8788`):

- `POST /api/v1/chrome/launch`
- `POST /api/v1/page/open`
- `POST /api/v1/action/connect`
- `POST /api/v1/share/start`
- `POST /api/v1/share/stop`
- `POST /api/v1/page/close`
- `POST /api/v1/chrome/exit`

Sharing lifecycle:

- Use `share/stop` before close/exit to disconnect and stop active media sharing.
- To start sharing again after a stop, call `share/start`.

## Environment Variables

- `SIGNALING_SERVER` (default: `http://localhost:8095`)
- `CLIENT_ID` (default: `client-1`)
- `DAEMON_ID` (default: `daemon-1`)
- `STUN_SERVER_URLS` (comma/newline separated, optional)
- `TURN_SERVER_URLS` (comma/newline separated, optional)
- `TURN_USERNAME` (optional)
- `TURN_CREDENTIAL` (optional)
- `RTC_ICE_SERVERS_JSON` (optional full `iceServers` JSON override/fallback)
- `AGENT_STATIC_HOST` (default: `0.0.0.0`)
- `AGENT_STATIC_PORT` (default: `5175`)

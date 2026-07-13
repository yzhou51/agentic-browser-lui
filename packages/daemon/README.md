# @agentic-browser/daemon

Daemon sub-project for Agentic Browser P2P in pure endpoint mode.

It provides:

- Local CLI browser operations via Puppeteer.
- Runtime config generation for daemon peer page from `.env`.
- Static file hosting for `public/` so daemon page is opened over `http://`.
- Browser daemon peer page (`public/daemon-agent.html`) that connects to OWT signaling server and exchanges data over `Owt.P2P.P2PClient`.
- REST API endpoints for agent-driven daemon control (launch/open/share/close/exit).

There is no daemon signaling API in this mode. The built-in static server only serves local frontend files.

## Run

Before first run, create daemon env file:

- PowerShell: `Copy-Item .env.example .env`
- Edit `.env` values as needed.

From workspace root:

- `pnpm start:daemon`

From package folder:

- `pnpm start`

On startup daemon writes runtime config file:

- `public/daemon-agent.config.json`

And starts a local static server bound to all interfaces by default (listen host `0.0.0.0`, default port `8788`), then prints an `http://.../daemon-agent.html?...` URL for opening the daemon peer page.

The same static server also exposes browser modules from `src/daemon/` under `/daemon-src/*` for `public/daemon-agent.js` imports.

## Alternative Dev Mode

- `pnpm dev:daemon` from workspace root
- `pnpm dev` from workspace root (runs daemon, client, and agent together)

## Environment Variables

`src/config.js` loads values from `.env` automatically.

- `SIGNALING_SERVER` (default: `${SIGNALING_SERVER}`)
- `DAEMON_ID` (default: `daemon-1`)
- `CLIENT_ID` (default: `client-1`)
- `DAEMON_STATIC_HOST` (default: `0.0.0.0`)
- `DAEMON_STATIC_PORT` (default: `8788`)
- `DAEMON_LOG_LEVEL` (default: `info`, options: `debug`, `info`, `warn`, `error`, `silent`)
- `DAEMON_LOG_FILE` (default: `/var/log/agent-browser-daemon.log`)
- `DAEMON_CLIENT_MESSAGE_TIMEOUT_SECONDS` (default: `120`)
- `DAEMON_TIMEOUT_SNAPSHOT_DIR` (default: `log/snapshots` under daemon package)
- `BROWSER_HEADLESS` (default: `false`)
- `PUPPETEER_BROWSER_CHANNEL` (default: `chrome`)
- `PUPPETEER_EXECUTABLE_PATH` (optional)

Daemon launches Chrome through Puppeteer and controls a dedicated target page directly.

When no peer message is received from the current client within timeout window (tool mode), daemon captures a full-page PNG snapshot of the current target page, saves it to snapshot directory, and marks session stage/status as `finish` / `timeout`.

## REST API (Agent Workflow)

Base URL defaults to `http://localhost:8788`.

- `GET /api/v1/status`
  - Returns daemon runtime state, browser status, and daemon-agent bridge status.
- `GET /api/v1/agent/ready`
  - Returns whether daemon-agent bridge is online.
  - Use `?bootstrap=true` to auto-launch/open daemon-agent and wait for bridge readiness.
- `POST /api/v1/chrome/launch`
  - Launches headful Chrome through Puppeteer.
  - Body example:

    ```json
    {
      "chrome": "/usr/bin/google-chrome",
      "params": [
        { "name": "--proxy-server", "value": "http://127.0.0.1:8888" },
        { "name": "--other" },
        { "name": "--bypass-proxy-list", "value": "localhost,127.0.0.1" }
      ]
    }
    ```

- `POST /api/v1/session/start`
  - Unified session-start endpoint:
    - Launch Chrome if not running.
    - Open/re-open daemon-agent page and target page.
    - Connect daemon-agent to signaling server.
    - Wait for client connection and `resolve` message, or accept an early `finish` as terminal completion.
    - Continue command replay over data channel after resolve.
    - Arm timeout snapshot flow for this session.
  - Body example:

    ```json
    {
      "daemonId": "daemon-1",
      "clientId": "client-1",
      "targetUrl": "https://www.zhihu.com/signin?next=%2F",
      "timeout": 120,
      "sessionId": "session-001",
      "signalingServer": "http://localhost:8095",
      "stunUrls": "stun:example.com:3478",
      "turnUrls": "turn:example.com:3478?transport=udp,turn:example.com:3478?transport=tcp",
      "turnUsername": "username",
      "turnCredential": "password",
      "chrome": "",
      "chromeParams": "[{\"name\":\"--proxy-server\",\"value\":\"http://127.0.0.1:8888\"}]"
    }
    ```

- `POST /api/v1/page/open`
  - Enqueues target open on daemon-agent page.
  - Body example:

    ```json
    {
      "name": "zhihu",
      "url": "https://www.zhihu.com/signin?next=%2F"
    }
    ```

- `GET /api/v1/page/snapshot`
  - Captures the current target page and returns `image/png` directly.
  - If target page is already closed, daemon returns the most recently saved timeout snapshot when available.
  - Optional query params:
    - `fullPage=true` to capture full scrollable page.
    - `clipX`, `clipY`, `clipWidth`, `clipHeight` to capture a specific region.

- `POST /api/v1/page/snapshot`
  - Same as GET, with options in JSON body.
  - Body example:

    ```json
    {
      "fullPage": true
    }
    ```

- `POST /api/v1/action/connect`
  - Primary Take Action flow: enqueue daemon-agent session update, signaling connect-only, and client notification.
  - Body example:

    ```json
    {
      "daemonId": "daemon-1",
      "clientId": "client-1",
      "signalingServer": "${SIGNALING_SERVER}",
      "stunUrls": "stun:example.com:3478",
      "turnUrls": "turn:example.com:3478?transport=udp,turn:example.com:3478?transport=tcp",
      "turnUsername": "username",
      "turnCredential": "password",
      "targetUrl": "https://www.zhihu.com/signin?next=%2F"
    }
    ```

- `POST /api/v1/share/start`
  - Legacy convenience flow: enqueues daemon-agent connect + immediate share.
  - Body example:

    ```json
    {
      "daemonId": "daemon-1",
      "clientId": "client-1"
    }
    ```

- `POST /api/v1/share/stop`
  - Stops active sharing by enqueueing a daemon-agent disconnect.
  - After stop completes, call `POST /api/v1/share/start` again to trigger a fresh share.
- `POST /api/v1/page/close`
  - Enqueues target close on daemon-agent page.
- `POST /api/v1/chrome/exit`
  - Exits Puppeteer-launched Chrome.

Bridge endpoints used internally by daemon-agent page:

- `GET /api/v1/agent/commands?after=<id>`
- `POST /api/v1/agent/events`

Important:

- `page/open`, `page/close`, `action/connect`, `share/start`, and `share/stop` require daemon-agent page to be open and polling bridge commands.
- This keeps screen-share and bridge-triggered control in the daemon-agent browser context.

Example curl sequence for the full agent flow is in `tests/scripts/daemon-rest-api-curl.sh`.

## P2P Data Flow

- Daemon peer page and client both connect to external `owt-server-p2p` signaling server.
- Daemon peer page sets `p2p.allowedRemoteIds = [clientId]`.
- Commands and results are exchanged over OWT data channel (`p2p.send` and `messagereceived`).

## Daemon Page Behavior

- The page receives bridge commands from daemon REST (`/api/v1/agent/commands`) and executes them.
- Target open/close and command replay route to Puppeteer target control.

## Frontend Refactor

- `public/daemon-agent.js` focuses on orchestration, OWT setup, and command/result logging.
- Direct local command support in Node lives in `src/daemon/browserController.js` and `src/daemon/commandProcessor.js`.

## Local CLI

From this package folder:

- `node src/index.js state`
- `node src/index.js launch`
- `node src/index.js open --url https://example.com`
- `node src/index.js close-page`
- `node src/index.js exit-chrome`
- `node src/index.js session-start --daemon-id daemon-1 --client-id client-1 --target-url https://example.com`

Tool-mode CLI (awe-daemon):

- `node src/index.js --daemon-id daemon-1 --client-id client-1 --target-url https://example.com`

When started in tool mode, daemon records and updates `activeSession.stage` and `activeSession.status` in `GET /api/v1/status`.

Stages:

- `start`
- `lauch_chrome`
- `open_daemon_agent_page`
- `open_target_page`
- `connect_to_signalServer`
- `wait_client_resolve`
- `user_interaction`
- `finish`

Tool-mode optional params:

- `--timeout <seconds>`
- `--session-id <id>`
- `--signaling-server <url>`
- `--stun-urls <csv>`
- `--turn-urls <csv>`
- `--turn-username <value>`
- `--turn-credential <value>`
- `--chrome <path>`
- `--chrome-params <json-string-array>`
- `--json-compact` (print single-line JSON output for machine parsing)

Exit behavior in tool mode:

- On timeout: capture snapshot and return timeout status.
- On `finish` message from client: capture snapshot and return success status.
- A client `finish` can complete the session even if `resolve` was not received yet.
- In both cases, tool-mode exits after emitting the final JSON result.

Tool-mode result payload includes:

- `snapshots`: ordered list of captured snapshots for the session, each with `type`, `timestamp`, and `path`.

Exit code notes for automation:

- Direct `node src/index.js ...` returns process exit code (`0` on success, `124` on timeout, `1` on error).
- When started through `pnpm --filter ... start -- ...`, pnpm wraps non-zero exit code and reports command failure, while JSON result is still printed.

## Notes

- Daemon peer page uses vendored OWT SDK at `public/vendor/owt.js`.
- Daemon peer page uses vendored Socket.IO at `public/vendor/socket.io.min.js` so `sc.websocket.js` can rely on a local global `io`.
- If Puppeteer Chromium download is blocked during install, set `PUPPETEER_SKIP_DOWNLOAD=true` and rely on local Chrome.

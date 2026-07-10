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
- `BROWSER_HEADLESS` (default: `false`)
- `PUPPETEER_BROWSER_CHANNEL` (default: `chrome`)
- `PUPPETEER_EXECUTABLE_PATH` (optional)

Daemon launches Chrome through Puppeteer and controls a dedicated target page directly.

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

- `POST /api/v1/page/open`
  - Enqueues target open on daemon-agent page.
  - Body example:

    ```json
    {
      "name": "zhihu",
      "url": "https://www.zhihu.com/signin?next=%2F"
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

## Notes

- Daemon peer page uses vendored OWT SDK at `public/vendor/owt.js`.
- Daemon peer page uses vendored Socket.IO at `public/vendor/socket.io.min.js` so `sc.websocket.js` can rely on a local global `io`.
- If Puppeteer Chromium download is blocked during install, set `PUPPETEER_SKIP_DOWNLOAD=true` and rely on local Chrome.

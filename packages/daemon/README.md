# @agentic-browser/daemon

Daemon sub-project for Agentic Browser P2P in pure endpoint mode.

It provides:

- Local CLI browser operations via Puppeteer.
- Runtime config generation for the daemon control page from `.env`.
- Static file hosting for `public/` so daemon page is opened over `http://`.
- Browser daemon control page (`public/daemon.html`) that connects to OWT signaling server and exchanges data over `Owt.P2P.P2PClient`.
- CLI/tool-mode session control (launch Chrome, open target, connect, share, terminate).

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

- `public/daemon.config.json`

And starts a local static server bound to all interfaces by default (listen host `0.0.0.0`, default port `8788`), then prints an `http://.../daemon.html?...` URL for opening the daemon control page.

The same static server also exposes browser modules from `src/daemon/` under `/daemon-src/*` for `public/daemon.js` imports.

## Alternative Dev Mode

- `pnpm dev:daemon` from workspace root
- `pnpm dev` from workspace root (runs daemon and client together)

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
- `DAEMON_CHROME_REMOTE_DEBUGGING_PORT` (optional)

Daemon launches Chrome through Puppeteer in detached-friendly mode and controls a dedicated target page directly.
If a remote-debugging port is configured and a Chrome instance is already running on that port, daemon attaches to it instead of launching a new browser process.

Daemon now uses two runtime modes:

- `remote-devtools` mode:
  - In tool mode, activated only when `--remote-debugging-port` is passed and attach succeeds.
  - On daemon exit, Chrome and target page are preserved.
  - Automated resolve uses direct `getDisplayMedia` auto-select path (extension `tabCapture` is skipped).
- `putter` mode:
  - Activated when `--remote-debugging-port` is not passed in tool mode, or when remote-devtools attach fails (fallback).
  - On daemon exit, daemon closes target page and Chrome.

For automatic share to work reliably when attaching to an existing Chrome, that Chrome should be started with the same capture-related flags and profile assumptions used by daemon launch:

- `--remote-debugging-port=<DAEMON_CHROME_REMOTE_DEBUGGING_PORT>`
- `--allow-http-screen-capture`
- `--auto-select-tab-capture-source-by-title=Agentic Browser Target`
- `--auto-select-desktop-capture-source=Agentic Browser Target`
- `--use-fake-ui-for-media-stream` (optional; recommended for test-only automation)
- A writable `--user-data-dir` (same profile daemon is configured to use)

Ubuntu example (launch attached Chrome manually first):

```bash
/usr/bin/google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/daemon-chrome-profile" \
  --allow-http-screen-capture \
  --auto-select-tab-capture-source-by-title="Agentic Browser Target" \
  --auto-select-desktop-capture-source="Agentic Browser Target"
```

Then start daemon tool-mode with matching remote debugging port:

```bash
node src/index.js --daemon-id daemon-1 --client-id client-1 --target-url https://example.com --timeout 120 --json-compact --remote-debugging-port=9222
```

If existing Chrome is missing these flags/policies, daemon can still operate with it, but screen share may require manual picker confirmation instead of fully automated selection.

When no peer message is received from the current client within timeout window (tool mode), daemon captures a full-page PNG snapshot of the current target page, saves it to snapshot directory, and marks session stage/status as `finish` / `timeout`.

## Client Lifecycle Messages

The client sends lifecycle control messages over the OWT P2P data channel. Daemon handles three termination signals:

| Message | Sender trigger | Daemon action |
|---------|---------------|---------------|
| `leave` | Client page closes (browser tab closed, window closed, navigation away) | Session completed with outcome `leave`; signaling disconnected |
| `finish` | User explicitly clicks the finish button in client UI | Session completed with outcome `success`; finish snapshot captured |
| `timeout` | Client-side inactivity timer fires | Session completed with outcome `timeout`; timeout snapshot captured |

### Flow: `leave`

1. Client detects `pagehide` or `beforeunload` browser event.
2. Client sends `{ type: 'leave', payload: { clientId, reason } }` over data channel with up to 500ms delivery window.
3. Daemon-cli page (`daemon.js`) receives message, logs it, sets `intentionalDisconnect = true`, and calls `disconnect()` to leave the signaling server.
4. Node daemon (`index.js` `onAgentEvent`) receives the `peer_message` event, calls `completeSession('leave', ...)`, which clears the client message timeout and notifies any session completion waiters.

### Flow: `finish`

1. User clicks Finish in the client UI.
2. Client sends `{ type: 'finish', payload: { clientId, reason } }` over data channel.
3. Daemon-cli page receives message, sets `intentionalDisconnect = true`, and calls `disconnect()`.
4. Node daemon receives event, captures a finish snapshot, calls `completeSession('success', ...)`, and enqueues a `finish_ack` peer notice back to the client.

### Flow: `timeout`

1. Client-side inactivity timer fires after no meaningful user activity.
2. Client sends `{ type: 'timeout', payload: { clientId, reason } }` over data channel.
3. Daemon-cli page receives message, sets `intentionalDisconnect = true`, and calls `disconnect()`.
4. Node daemon's own independent client message timeout may also fire and capture a snapshot if no other message has been received.

### Intentional Disconnect Flag

When daemon processes any termination message, it immediately sets `intentionalDisconnect = true` before calling the async `disconnect()`. This prevents race conditions where the P2P client's internal reconnect logic could re-establish the signaling connection before the graceful shutdown completes.

## HTTP Endpoints

The daemon is driven by the CLI (see [Local CLI](#local-cli)); there is no external REST control API. The built-in static server exposes only what the daemon browser page needs:

- `GET /` and static assets under `public/` (serves `daemon.html`, `daemon.js`, vendored libs), plus browser modules under `/daemon-src/*` and client SDK under `/client-sdk/*`.
- `GET /daemon.config.json` — runtime config (ids, signaling server, ICE, timeout) the page reads on load.
- `POST /daemon.command` — page-issued local Puppeteer command bridge.
- `GET /api/v1/agent/commands?after=<id>` and `POST /api/v1/agent/events` — internal bridge only: the page polls for commands the daemon enqueues and posts back resolve/finish/leave/heartbeat events. These are not a public control API.

## P2P Data Flow

- Daemon peer page and client both connect to external `owt-server-p2p` signaling server.
- Daemon peer page sets `p2p.allowedRemoteIds = [clientId]`.
- Commands and results are exchanged over OWT data channel (`p2p.send` and `messagereceived`).

## Daemon Page Behavior

- The page receives bridge commands from the daemon (`/api/v1/agent/commands`) and executes them.
- Target open/close and command replay route to Puppeteer target control.

## Frontend Refactor

- `public/daemon.js` focuses on orchestration, OWT setup, and command/result logging.
- Direct local command support in Node lives in `src/daemon/browserController.js` and `src/daemon/commandProcessor.js`.

## Local CLI

From this package folder:

- `node src/index.js state`
- `node src/index.js launch`
- `node src/index.js open --url https://example.com`
- `node src/index.js close-page`
- `node src/index.js exit-chrome`

Tool-mode CLI (awe-daemon):

- `node src/index.js --daemon-id daemon-1 --client-id client-1 --target-url https://example.com`

When started in tool mode, the daemon records and updates `activeSession.stage` and `activeSession.status` in-process and reports the final outcome in the JSON result printed on completion.

### Tool-mode flags

- Required:
  - `--daemon-id <id>`
  - `--client-id <id>`
  - `--target-url <url>`
- Optional:
  - `--timeout <seconds>`
  - `--session-id <id>`
  - `--signaling-server <url>`
  - `--stun-urls <csv>`
  - `--turn-urls <csv>`
  - `--turn-username <value>`
  - `--turn-credential <value>`
  - `--chrome <path>`
  - `--chrome-params <json-array>`
  - `--remote-debugging-port <port>`
  - `--json-compact`

### Tool-mode result schema (for LLM)

Tool mode prints one final JSON object to stdout.

Top-level fields:

- `ok` (`boolean`):
  - `true`: session completed with success (`finish` accepted).
  - `false`: session ended with timeout or error.
- `mode` (`string`): selected runtime mode for this tool invocation.
  - `remote-devtools`: `--remote-debugging-port` was provided and attach succeeded.
  - `putter`: no `--remote-debugging-port` provided, or attach failed and daemon fell back.
- `stage` (`string`): current/final stage value.
- `status` (`string`): current/final status value.
- `message` (`string`): human-readable summary for this result.
- `snapshots` (`array`): captured snapshots, usually timeout/finish evidence.
- `start` (`object`): structured data from session startup workflow.
- `completion` (`object`): final completion metadata (`outcome`, `status`, `stage`, `statusMessage`, `completedAt`).

Interpretation guidance:

- Success condition: `ok=true` and `status=success`.
- Timeout condition: `ok=false` and `status=timeout`.
- Leave condition: `ok=false` and `status=leave` (client disconnected before finish).
- Error condition: `ok=false` and `status=error`.
- Mode-specific shutdown expectation:
  - `mode=remote-devtools`: daemon exits and preserves Chrome/target page.
  - `mode=putter`: daemon exits and closes target page + Chrome.

Stages:

- `start`: session object initialized.
- `lauch_chrome`: launch/attach phase for browser control (spelling kept for compatibility).
- `open_daemon_page`: daemon page open/re-open phase.
- `open_target_page`: target page open/navigation phase.
- `connect_to_signalServer`: daemon signaling connection phase.
- `wait_client_resolve`: waiting for client resolve command.
- `user_interaction`: client command replay/share in progress.
- `finish`: terminal stage (success/timeout/error).

Status values:

- `idle`: initial state before session starts.
- `running`: in-progress state for active stages.
- `success`: finish accepted and session completed successfully.
- `timeout`: no required message in configured timeout window.
- `error`: unrecoverable workflow/runtime error.

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

- On `timeout` (no client message within window): capture snapshot and return timeout status.
- On `finish` message from client: capture snapshot and return success status.
- On `leave` message from client: complete session with `leave` outcome (no snapshot).
- A client `finish` or `leave` can complete the session even if `resolve` was not received yet.
- In all cases, tool-mode exits after emitting the final JSON result.
- On tool-mode terminal exit, daemon process shuts down but does not explicitly close Chrome or target page.

Tool-mode result payload includes:

- `snapshots`: ordered list of captured snapshots for the session, each with `type`, `timestamp`, and `path`.

Exit code notes for automation:

- Direct `node src/index.js ...` returns process exit code (`0` on success, `124` on timeout, `1` on error).
- When started through `pnpm --filter ... start -- ...`, pnpm wraps non-zero exit code and reports command failure, while JSON result is still printed.

## Notes

- Daemon peer page uses vendored OWT SDK at `public/vendor/owt.js`.
- Daemon peer page uses vendored Socket.IO at `public/vendor/socket.io.min.js` so `sc.websocket.js` can rely on a local global `io`.
- If Puppeteer Chromium download is blocked during install, set `PUPPETEER_SKIP_DOWNLOAD=true` and rely on local Chrome.

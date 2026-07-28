# @direct-user-control/daemon

Daemon sub-project for Direct User Control P2P in pure endpoint mode.

It provides:

- Local CLI browser operations via Puppeteer.
- Runtime config generation for the daemon control page from `.env`.
- Static file hosting for `public/` so daemon page is opened over `http://`.
- Browser daemon control page (`public/daemon.html`) that connects to OWT signaling server and exchanges data over `Owt.P2P.P2PClient`.
- CLI/tool-mode session control (launch Chrome, open target, connect, share, terminate).

There is no daemon signaling API in this mode. The built-in static server only serves local frontend files.

## Run

Before first run, create daemon env file:

- bash: `cp .env.example .env`
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

- `SIGNALING_SERVER` (default: `http://localhost:8095`)
- `DAEMON_STATIC_HOST` (default: `0.0.0.0`)
- `DAEMON_STATIC_PORT` (default: `8788`)
- `DAEMON_LOG_LEVEL` (default: `info`, options: `debug`, `info`, `warn`, `error`, `silent`)
- `DAEMON_LOG_FILE` (default: `/var/log/agent-browser-daemon.log`)
- `DAEMON_TIMEOUT_SECONDS` (default: `120`)
- `DAEMON_TIMEOUT_SNAPSHOT_DIR` (default: `log/snapshots` under daemon package)
- `DAEMON_LEAVE_GRACE_MS` (default: `8000`) — grace window after a client `leave` during which a refresh reconnect can cancel termination
- `BROWSER_HEADLESS` (default: `false`)
- `PUPPETEER_BROWSER_CHANNEL` (default: `chrome`)
- `PUPPETEER_EXECUTABLE_PATH` (optional)
- `DAEMON_CHROME_REMOTE_DEBUGGING_PORT` (optional)

Daemon launches Chrome through Puppeteer in detached-friendly mode and controls a dedicated target page directly.
If a remote-debugging port is configured and a Chrome instance is already running on that port, daemon attaches to it instead of launching a new browser process.

Daemon uses two runtime modes:

- `CDP` mode:
  - Activated only when `--remote-debugging-port` is passed and attach succeeds.
  - On daemon exit, Chrome and target page are preserved.
  - Automated resolve uses direct `getDisplayMedia` auto-select path (extension `tabCapture` is skipped).
- `puppeteer` mode:
  - Activated when `--remote-debugging-port` is not passed in tool mode, or when CDP attach fails (fallback).
  - On daemon exit, daemon closes target page and Chrome.

For automatic share to work reliably when attaching to an existing Chrome, that Chrome should be started with the same capture-related flags and profile assumptions used by daemon launch:

- `--remote-debugging-port=<DAEMON_CHROME_REMOTE_DEBUGGING_PORT>`
- `--allow-http-screen-capture`
- `--auto-select-tab-capture-source-by-title="DUC Target"`
- `--auto-select-desktop-capture-source="DUC Target"`
- `--use-fake-ui-for-media-stream` (optional; recommended for test-only automation)
- A writable `--user-data-dir` (same profile daemon is configured to use)

Ubuntu example (launch attached Chrome manually first):

```bash
/usr/bin/google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/daemon-chrome-profile" \
  --allow-http-screen-capture \
  --auto-select-tab-capture-source-by-title="DUC Target" \
  --auto-select-desktop-capture-source="DUC Target" \
  --headless=new \
  --no-sandbox
```

Then start daemon tool-mode with matching remote debugging port:

```bash
node src/index.js --sessionId test --target-url https://example.com --timeout 120 --json-compact --remote-debugging-port=9222
```

If existing Chrome is missing these flags/policies, daemon can still operate with it, but screen share may require manual picker confirmation instead of fully automated selection.

When no peer message is received from the current client within timeout window (tool mode), daemon captures a full-page PNG snapshot of the current target page, saves it to snapshot directory, and marks session stage/status as `finish` / `timeout`.

## Client Lifecycle Messages

The client sends lifecycle control messages over the OWT P2P data channel. Daemon handles three termination signals:

| Message | Sender trigger | Daemon action |
|---------|---------------|---------------|
| `leave` | Client page unloads (refresh, tab/window close, navigation away) — refresh and close are indistinguishable at emit time | Signaling kept alive; stale share dropped; termination deferred behind a grace window that a refresh reconnect cancels |
| `finish` | User explicitly clicks the finish button in client UI | Session completed with outcome `success`; finish snapshot captured |
| `timeout` | Client-side inactivity timer fires | Session completed with outcome `timeout`; timeout snapshot captured |

### Flow: `refresh or close`

A `leave` is emitted for **both** a page refresh and a genuine close — the two are indistinguishable at emit time. Rather than terminate immediately, the daemon keeps the door open for a reconnect and only commits to termination if none arrives.

1. Client detects `pagehide` or `beforeunload` browser event.
2. Client sends `{ type: 'leave', payload: { clientId, reason } }` over the data channel with up to a 500ms delivery window.
3. Daemon page (`daemon.js` `handleClientLeave`) receives the message and, crucially, **keeps the signaling connection alive** (a refreshing client can only re-reach us if we stay connected). It:
   - drops the now-dead screen-share publication (the receiving peer is gone), leaving a fresh one to be published on reconnect;
   - cancels any in-flight calibration and strips its markers from the target page (the departed client will never answer to trigger removal);
   - sets `refreshReconnectPending = true` so the next `resolve` is treated as a refresh reconnect;
   - clears `resolveInProgress` and re-arms `daemon_online` announcements so a reconnecting client resolves promptly.
   - It does **not** send a `command_result` reply — `leave` is a fire-and-forget notification, and replying would route through `p2p.send` to a peer whose data channel is already gone.
4. Node daemon (`index.js` `onAgentEvent`) receives the `peer_message` event and calls `sessionManager.scheduleLeaveTermination(...)`, which **defers** termination behind a grace window (`config.leaveGraceMs`) with outcome `leave` instead of ending the session immediately.

Then one of two things happens:

- **Refresh** — the client reconnects and re-sends `resolve`. The node daemon's `resolve` handler calls `sessionManager.clearPendingLeave('reconnect_resolve')`, cancelling the deferred termination. On the daemon page, `processResolveMessage` sees `refreshReconnectPending`, resets the stale WebRTC peer connection (`p2p.stop(clientId)`), and republishes the share so a fresh data channel (mouse/keyboard/text/calibration) is negotiated and calibration re-runs.
- **Genuine close** — no `resolve` arrives within the grace window, the timer fires, and the session terminates with outcome `leave` (capturing its snapshot), clearing the client message timeout and notifying completion waiters.


### Flow: `finish`

1. User clicks Finish in the client UI.
2. Client sends `{ type: 'finish', payload: { clientId, reason } }` over the data channel.
3. Daemon page (`daemon.js` `handleTerminationMessage`) receives the message and calls `disconnect()` to leave the signaling server.
4. Node daemon (`index.js` `onAgentEvent`) receives the `peer_message` event and calls `sessionManager.handleTerminationMessage(...)` with outcome `success`, which captures a finish snapshot, closes the daemon control page, completes the session, and (since `sendNotice: true`) enqueues a terminal ack notice back to the client.

### Flow: `timeout`

1. Client-side inactivity timer fires after no meaningful user activity.
2. Client sends `{ type: 'timeout', payload: { clientId, reason } }` over the data channel.
3. Daemon page receives the message and calls `disconnect()`.
4. Node daemon handles it with outcome `timeout` (snapshot + terminal ack notice). Independently, the daemon's own client-message timeout can also fire and capture a `timeout` snapshot if no message arrives within the configured window (`DAEMON_TIMEOUT_SECONDS`).

## HTTP Endpoints

The daemon is driven by the CLI (see [Local CLI](#local-cli)); there is no external REST control API. The built-in static server exposes only what the daemon page needs:

- `GET /` and static assets under `public/` (serves `daemon.html`, `daemon.js`, vendored libs), plus browser modules under `/daemon-src/*` and client SDK under `/client-sdk/*`.
- `GET /daemon.config.json` — runtime config (ids, signaling server, ICE, timeout) the page reads on load.
- `POST /daemon.command` — page-issued local Puppeteer command bridge.
- `GET /api/v1/page/commands?after=<id>`, `POST /api/v1/page/events`, and `POST /api/v1/page/logs` — internal bridge only: the page polls for commands the daemon enqueues and posts back resolve/finish/leave/heartbeat events and logs. These are not a public control API.

## P2P Data Flow

- Daemon peer page and client both connect to external `owt-server-p2p` signaling server.
- Daemon peer page sets `p2p.allowedRemoteIds = [clientId]`.
- Commands and results are exchanged over OWT data channel (`p2p.send` and `messagereceived`).

## Daemon Page Behavior

- The page receives bridge commands from the daemon (`/api/v1/page/commands`) and executes them.
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

Flags accept both `--kebab-case` and `--camelCase` forms (and `--flag value` or `--flag=value`).

- Required:
  - `--daemon-id <id>`
  - `--client-id <id>`
  - `--target-url <url>`
- Optional:
  - `--session-id <id>` (auto-generated if omitted)
  - `--timeout <seconds>` (defaults to `DAEMON_TIMEOUT_SECONDS`)
  - `--remote-debugging-port <port>` (present + attach succeeds → `CDP` mode; otherwise `puppeteer` mode)
  - `--chrome <path>`
  - `--chrome-params <json-array>`
  - `--json-compact`

### Tool-mode result schema (for LLM)

Tool mode prints one final JSON object to stdout.

Top-level fields:

- `ok` (`boolean`):
  - `true`: session completed with success (`finish` accepted).
  - `false`: session ended with timeout or error.
- `mode` (`string`): selected runtime mode for this tool invocation.
  - `CDP`: `--remote-debugging-port` was provided and attach succeeded.
  - `puppeteer`: no `--remote-debugging-port` provided, or attach failed and daemon fell back.
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
  - `mode=CDP`: daemon exits and preserves Chrome/target page.
  - `mode=puppeteer`: daemon exits and closes target page + Chrome.

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

Exit behavior in tool mode:

- On `timeout` (no client message within window): capture snapshot and return timeout status.
- On `finish` message from client: capture snapshot and return success status.
- On `leave` message from client: defer termination for the leave grace window (`DAEMON_LEAVE_GRACE_MS`); if no refresh reconnect (`resolve`) arrives, complete the session with `leave` outcome and capture a leave snapshot.
- A client `finish` or `leave` can complete the session even if `resolve` was not received yet.
- In all cases, tool-mode exits after emitting the final JSON result.
- On terminal exit, browser cleanup is mode-specific: `CDP` preserves Chrome and the target page; `puppeteer` closes the target page and Chrome.

Tool-mode result payload includes:

- `snapshots`: ordered list of captured snapshots for the session, each with `type`, `timestamp`, and `path`.

Exit code notes for automation:

- Direct `node src/index.js ...` returns process exit code (`0` on success, `124` on timeout, `1` on error).
- When started through `pnpm --filter ... start -- ...`, pnpm wraps non-zero exit code and reports command failure, while JSON result is still printed.

## Notes

- Daemon peer page uses vendored OWT SDK at `public/vendor/owt.js`.
- Daemon peer page uses vendored Socket.IO at `public/vendor/socket.io.min.js` so `sc.websocket.js` can rely on a local global `io`.
- If Puppeteer Chromium download is blocked during install, set `PUPPETEER_SKIP_DOWNLOAD=true` and rely on local Chrome.

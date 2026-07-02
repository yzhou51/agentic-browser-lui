# agentic-browser-lui

Node.js pnpm workspace for an agentic browser P2P system with two sub-projects:

- `packages/daemon`: Daemon endpoint tooling, local CLI, daemon-side WebRTC page, and Chrome extension bridge for cross-origin tab control.
- `packages/client`: Client SDK and demo UI that receives daemon video stream and sends operation commands via data channel.

## Project Layout

- `packages/daemon/public`: daemon operator UI (`daemon-agent.html`) and browser entrypoint (`daemon-agent.js`).
- `packages/daemon/src/daemon`: browser-safe daemon modules extracted from the page script and served as `/daemon-src/*`.
- `packages/daemon/extension`: unpacked Chrome extension used for cross-origin replay and user-opened tab binding.
- `packages/client/src/sdk`: reusable client SDK pieces, including the main client wrapper and viewer/pointer helpers used by the demo.
- `packages/client/src/demo`: demo UI wired on top of the SDK exports.

## Prerequisites

- Node.js 20+
- pnpm 9+

## Upstream References

- OWT signaling sample server: [open-webrtc-toolkit/owt-server-p2p](https://github.com/open-webrtc-toolkit/owt-server-p2p)
- OWT JavaScript SDK: [open-webrtc-toolkit/owt-client-javascript](https://github.com/open-webrtc-toolkit/owt-client-javascript)

## Setup

1. Install dependencies:
   - If Chromium download is blocked in your network, set env then install:
     - PowerShell: `$env:PUPPETEER_SKIP_DOWNLOAD='true'; pnpm install`
   - Otherwise:
     - `pnpm install`
2. Prepare daemon runtime env:
   - PowerShell: `Copy-Item packages/daemon/.env.example packages/daemon/.env`
   - Edit `packages/daemon/.env` with your local values.
3. Prepare client runtime env:
   - PowerShell: `Copy-Item packages/client/.env.example packages/client/.env`
   - Edit `packages/client/.env` with your local values.

## Start External OWT Signaling Server

1. In your `owt-server-p2p` repository:
   - `npm install`
   - `node src/index.js`
2. Keep it running (default plain URL is `http://localhost:8095`, secure URL is `https://localhost:8096`).

## Run

1. Start daemon static server and peer page runtime:
   - `pnpm start:daemon`
2. Start client demo static server:
   - `pnpm start:client`
3. Open daemon peer page URL printed by daemon startup (default `http://127.0.0.1:8788/daemon-agent.html?...`).
4. In daemon peer page:
   - Ensure signaling host points to your OWT signaling server (for example `http://localhost:8095`).
   - For cross-origin targets or user-opened tabs, load unpacked Chrome extension from `packages/daemon/extension`.
   - Choose one control flow:
     - Daemon-opened target: use `Open In New Tab`, then click `Check Extension`.
     - User-opened target: open the page yourself, return to daemon-agent, click `Bind Last Active Tab`, and confirm the controlled-tab indicator/status updates.
   - Click `Connect`, then click `Share Screen` and choose the same browser tab/page that will receive remote input.
5. Open client demo URL printed by client startup (default `http://127.0.0.1:5174/index.html`).
6. In client demo:
   - Ensure `Signaling URL` is OWT signaling server (`http://localhost:8095`).
   - Ensure `Daemon API URL` points to daemon static server (`http://localhost:8788`).
   - Click `Connect`.
   - Use Agent workflow buttons to call daemon REST APIs: `Launch Chrome API`, `Open URL API`, `Start Share API`, `Close Page API`, and `Exit Chrome API`.
   - Use viewer mouse and text controls to send commands to daemon.
   - Drag operations are supported through the shared viewer using `mouse_down`, `mouse_move`, and `mouse_up` command replay.

## Alternative Dev Mode

- `pnpm dev:daemon`: runs daemon process.
- `pnpm dev:client`: runs Vite dev server for client demo (default `http://localhost:5173`).
- `pnpm dev`: runs daemon and Vite dev server together.

## Core flow

1. Client and daemon-agent connect to external `owt-server-p2p` signaling service with `Owt.P2P.P2PClient`.
2. Daemon operator clicks Connect in daemon peer page (same as `login` in `peercall.js`).
3. Daemon peer page sets `p2p.allowedRemoteIds = [clientId]`.
4. Daemon peer page publishes screen stream to client.
5. Client renders stream and sends command messages over data channel with `p2p.send`.
6. Daemon peer page receives commands via `messagereceived` and routes them to either:
   - a daemon-opened tab (`window.open` handle), or
   - an extension-managed controlled tab tracked by the Chrome extension.
7. Daemon peer page sends `command_result` back to client via `p2p.send`.

## Refactoring Notes

- Client-side viewer geometry and mouse-command helpers were moved from the demo into `packages/client/src/sdk/viewerUtils.js` and re-exported by `packages/client/src/sdk/index.js`.
- Daemon browser-side extension request handling and target-tab forwarding were extracted into `packages/daemon/src/daemon/extensionBridge.browser.js` and `packages/daemon/src/daemon/targetTabForwarding.browser.js`.
- The daemon static server now exposes those browser modules through `/daemon-src/*` so `public/daemon-agent.js` stays focused on page orchestration and UI state.

## Daemon REST API Overview

Daemon now exposes REST APIs on the static server (default `http://localhost:8788`) for Agent-driven orchestration:

- `POST /api/v1/chrome/launch`
- `POST /api/v1/page/open`
- `POST /api/v1/share/start`
- `POST /api/v1/page/close`
- `POST /api/v1/chrome/exit`
- `GET /api/v1/status`

Internally, daemon-agent page polls `/api/v1/agent/commands` and reports execution via `/api/v1/agent/events`.

Runnable curl workflow example is available at `tests/scripts/daemon-rest-api-curl.sh`.

## Notes

- Signaling logic in daemon peer page and client follows `peercall.js`/`sc.websocket.js` pattern (`authentication`, `owt-message`, reconnect handling).
- OWT SDK in this workspace is loaded from vendored browser files at `packages/client/public/vendor/owt.js` and `packages/daemon/public/vendor/owt.js`.
- Socket.IO is also vendored locally in both daemon and client public assets so signaling does not depend on a CDN-hosted global `io` script.
- Daemon and client both provide local static file servers to host demo pages over `http://`.
- Automatic web page capture without user prompt depends on browser/OS policies; this scaffold includes the full data and signaling path and supports manual screen selection.
- Client mouse coordinates are scaled from rendered video size to source stream resolution before sending `mouse_move` and `mouse_click` commands.
- For extension-managed control, the controlled target takes precedence over any stale daemon-opened tab handle so refactors do not accidentally route commands to the wrong tab.
- Optional smoke test: `pnpm test:signal` uses a root-level Node `socket.io-client` dependency to verify signaling auth and `owt-message` relay.
<!-- eof -->




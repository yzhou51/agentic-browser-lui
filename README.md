# agentic-browser-lui

Node.js pnpm workspace for an agentic browser P2P system with two sub-projects:

- `packages/daemon`: Daemon endpoint tooling, local CLI, and daemon-side WebRTC page.
- `packages/client`: Client SDK and demo UI that receives daemon video stream and sends operation commands via data channel.

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
   - Click `Connect`, then click `Share Screen` and choose the browser/page to share.
5. Open client demo URL printed by client startup (default `http://127.0.0.1:5174/index.html`).
6. In client demo:
   - Ensure `Signaling URL` is OWT signaling server (`http://localhost:8095`).
   - Click `Connect`.
   - Optional explicit controls: `Launch Chrome` and `Open URL`.
   - Use viewer mouse and text controls to send commands to daemon.

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
6. Daemon peer page receives commands via `messagereceived` and sends `command_result` via `p2p.send`.

## Notes

- Signaling logic in daemon peer page and client follows `peercall.js`/`sc.websocket.js` pattern (`authentication`, `owt-message`, reconnect handling).
- OWT SDK in this workspace is loaded from vendored browser files at `packages/client/public/vendor/owt.js` and `packages/daemon/public/vendor/owt.js`.
- Daemon and client both provide local static file servers to host demo pages over `http://`.
- Automatic web page capture without user prompt depends on browser/OS policies; this scaffold includes the full data and signaling path and supports manual screen selection.
- Client mouse coordinates are scaled from rendered video size to source stream resolution before sending `mouse_move` and `mouse_click` commands.
- Optional smoke test: `pnpm test:signal` uses a root-level Node `socket.io-client` dependency to verify signaling auth and `owt-message` relay.
<!-- eof -->




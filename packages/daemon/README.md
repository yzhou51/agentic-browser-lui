# @agentic-browser/daemon

Daemon sub-project for Agentic Browser P2P in pure endpoint mode.

It provides:

- Local CLI browser operations via Puppeteer.
- Runtime config generation for daemon peer page from `.env`.
- Static file hosting for `public/` so daemon page is opened over `http://`.
- Browser daemon peer page (`public/daemon-agent.html`) that connects to OWT signaling server and exchanges data over `Owt.P2P.P2PClient`.
- Browser-safe daemon modules in `src/daemon/` that are served to the page as `/daemon-src/*`.
- Chrome extension bridge in `extension/` for cross-origin input replay and user-opened tab control.

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
- `pnpm dev` from workspace root (runs daemon and client dev servers together)

## Environment Variables

`src/config.js` loads values from `.env` automatically.

- `SIGNALING_SERVER` (default: `http://localhost:8095`)
- `DAEMON_ID` (default: `daemon-1`)
- `CLIENT_ID` (default: `client-1`)
- `DAEMON_STATIC_HOST` (default: `0.0.0.0`)
- `DAEMON_STATIC_PORT` (default: `8788`)
- `BROWSER_HEADLESS` (default: `false`)
- `PUPPETEER_BROWSER_CHANNEL` (default: `chrome`)
- `PUPPETEER_EXECUTABLE_PATH` (optional)

## P2P Data Flow

- Daemon peer page and client both connect to external `owt-server-p2p` signaling server.
- Daemon peer page sets `p2p.allowedRemoteIds = [clientId]`.
- Commands and results are exchanged over OWT data channel (`p2p.send` and `messagereceived`).

## Cross-Origin Page Control (Extension)

For pages that cannot be directly scripted by `daemon-agent` (for example `https://www.zhihu.com/signin?next=%2F`), use the extension bridge:

1. Load unpacked extension from `packages/daemon/extension` in Chrome (`chrome://extensions`).
2. Open daemon peer page.
3. Either:
	- open target page from daemon page, or
	- open target page manually and then click `Bind Last Active Tab` in daemon page.
4. Refresh target page once after extension is installed.
5. Click `Check Extension` in daemon page and confirm status is active.
6. Click `Share Screen` and select the same target tab in browser picker.

The extension listens for `postMessage` commands and replays mouse/keyboard/text input on that cross-origin page. A background service worker also tracks the extension-managed target tab so user-opened pages can be controlled without relying on `window.open`/`window.opener`.

## Daemon Page Behavior

- `Open In New Tab` keeps the traditional daemon-opened target flow.
- `Bind Last Active Tab` switches control to the last active extension-visible browser tab.
- `Check Extension` explicitly verifies that the target page can answer the extension ping.
- The page also polls extension status automatically and shows a controlled-tab indicator.
- When an extension-managed target is active, command routing prefers that controlled tab over any stale direct tab handle.

## Frontend Refactor

- `public/daemon-agent.js` now focuses on orchestration, UI updates, OWT setup, and command/result logging.
- Extension request/ack handling lives in `src/daemon/extensionBridge.browser.js`.
- Target-tab DOM replay and coordinate mapping live in `src/daemon/targetTabForwarding.browser.js`.
- Direct local command support in Node remains in `src/daemon/browserController.js` and `src/daemon/commandProcessor.js`.

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

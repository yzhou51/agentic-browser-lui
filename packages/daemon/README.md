# @agentic-browser/daemon

Daemon sub-project for Agentic Browser P2P in pure endpoint mode.

It provides:

- Local CLI browser operations via Puppeteer.
- Runtime config generation for daemon peer page from `.env`.
- Static file hosting for `public/` so daemon page is opened over `http://`.
- Browser daemon peer page (`public/daemon-agent.html`) that connects to OWT signaling server and exchanges data over `Owt.P2P.P2PClient`.

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

- `public/daemon-agent.runtime.js`

And starts a local static server bound to all interfaces by default (listen host `0.0.0.0`, default port `8788`), then prints an `http://.../daemon-agent.html?...` URL for opening the daemon peer page.

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

## Local CLI

From this package folder:

- `node src/index.js state`
- `node src/index.js launch`
- `node src/index.js open --url https://example.com`
- `node src/index.js close-page`
- `node src/index.js exit-chrome`

## Notes

- Daemon peer page uses vendored OWT SDK at `public/vendor/owt.js`.
- If Puppeteer Chromium download is blocked during install, set `PUPPETEER_SKIP_DOWNLOAD=true` and rely on local Chrome.

# @agentic-browser/client

Client subproject includes:

- SDK: `src/sdk/AgenticBrowserClient.js`
- Demo UI: Vite app in `index.html` and `src/demo/main.js`

## Dev

- Create env file for demo defaults:
  - PowerShell: `Copy-Item .env.example .env`
  - Edit `SIGNALING_SERVER`, `CLIENT_ID`, and `DAEMON_ID` in `.env` if needed.
- `pnpm dev`

From workspace root, equivalent command is `pnpm dev:client`.

## Static demo server

- `pnpm start`

From workspace root, equivalent command is `pnpm start:client`.

This starts a local static server for this package and prints an `http://.../index.html` URL.
Runtime defaults are generated from `.env` into `client-demo.runtime.json`.

Default static server listen host is `0.0.0.0`, default port is `5174`.

Environment values used by static mode:

- `SIGNALING_SERVER` (default: `http://localhost:8095`)
- `CLIENT_ID` (default: `client-1`)
- `DAEMON_ID` (default: `daemon-1`)
- `CLIENT_STATIC_HOST` (default: `0.0.0.0`)
- `CLIENT_STATIC_PORT` (default: `5174`)

## Alternative Dev Mode

- `pnpm dev:client` from workspace root
- `pnpm dev` from workspace root (runs daemon and client dev servers together)

## SDK quick usage

```js
import { AgenticBrowserClient } from './src/sdk/index.js';

const client = new AgenticBrowserClient();
await client.connect({
  signalingHost: 'http://localhost:8095',
  clientId: 'client-1',
  daemonId: 'daemon-1',
});
await client.sendCommand('open_url', { url: 'https://example.com' });
```

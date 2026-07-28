# @agentic-browser/client

Client subproject includes:

- SDK: `src/sdk/DirectUserControlClient.js`
- Viewer helpers: `src/sdk/viewerUtils.js`
- Demo UI: `public/direct-user-control.html`, with logic in `src/client.js`

## Dev

- Create env file for demo defaults:
  - bash: `cp .env.example .env`
  - Edit `SIGNALING_SERVER` and optional STUN/TURN values in `.env` if needed.
- `pnpm dev`

From workspace root, equivalent command is `pnpm dev:client`.

## Static demo server

- `pnpm start`

From workspace root, equivalent command is `pnpm start:client`.

This starts a local client server for this package and prints an `http://.../direct-user-control.html` URL.
Runtime defaults are generated from `.env` into `client.runtime.json`.

Pages:

- `public/direct-user-control.html`: client page with dedicated keyboard-launch button and a Finish action pinned at the opposite bottom corner.

Default client server listen host is `0.0.0.0`, default port is `5174`.

Environment values used by client server:

- `SIGNALING_SERVER` (default: `http://localhost:8095`)
- `STUN_SERVER_URLS` (comma/newline separated, optional)
- `TURN_SERVER_URLS` (comma/newline separated, optional)
- `TURN_USERNAME` (optional)
- `TURN_CREDENTIAL` (optional)
- `RTC_ICE_SERVERS_JSON` (optional full `iceServers` JSON override/fallback)
- `CLIENT_STATIC_HOST` (default: `0.0.0.0`)
- `CLIENT_STATIC_PORT` (default: `5174`)

## Alternative Dev Mode

- `pnpm dev:client` from workspace root
- `pnpm dev` from workspace root (runs daemon and client together)

## SDK quick usage

```js
import { DirectUserControlClient } from './src/sdk/index.js';

const client = new DirectUserControlClient();
await client.connect({
  signalingHost: 'http://localhost:8095',
  localId: 'client-1',
  remoteId: 'daemon-1',
  stunUrls: ['stun:example.com:3478'],
  turnUrls: ['turn:example.com:3478?transport=udp'],
  turnUsername: 'username',
  turnCredential: 'password',
});
await client.sendCommand('open_url', { url: 'https://example.com' });
```

## SDK exports

`src/sdk/index.js` re-exports:

- Client wrapper: `DirectUserControlClient`
- Video geometry: `getRenderedVideoContentRect`, `mapPointerToVideoSpace`
- Mouse buttons: `BUTTON_LEFT`, `BUTTON_MIDDLE`, `BUTTON_RIGHT`, `buttonNameToCode`, `buttonCodeToName`, `getPointerButtonCode`
- Mouse command building/sending: `buildViewerMousePayload`, `createViewerMouseCommandSender`
- Mouse command codec: `encodeMouseCommand`, `decodeMouseCommand`, `encodeMouseCommandString`, `decodeMouseCommandString`, `isMouseCommandString`, `MOUSE_COMMAND_STRING_PREFIX`
- Config: `loadClientRuntimeConfig`, `summarizeIceConfigForLog`, `createPeerIds`
- URL query-string helpers: `hasAnySearchParam`, `readSearchParam`, `readSearchParamAny`, `readSearchPercentParam`

These helpers were extracted from the demo so other client UIs can reuse the same video-space coordinate mapping and mouse command packaging logic.

## Demo behavior

- `src/client.js` consumes the shared SDK viewer helpers instead of owning duplicate geometry logic.
- Drag interactions are sent as `mouse_down`, `mouse_move`, and `mouse_up` commands so the daemon can replay press-and-drag flows on the shared page.
- Client serves vendored browser dependencies locally, including `public/vendor/socket.io.min.js`, to avoid CDN dependencies during signaling setup.
- The client page (`src/client.js`) adds an explicit `Open Keyboard` button for phone text input and a `Finish` action.
- A client page `Refresh` only triggers a reconnect and daemon re-share of the target page — the daemon keeps signaling alive and treats the follow-up `resolve` as a refresh reconnect rather than ending the session.
- STUN/TURN fields default from `.env` and can be generated into `client.runtime.json`.
- Mobile status chip in `public/direct-user-control.html` is hidden by default for customer-facing demos and can be re-enabled for debugging by adding `debug-status` class to `body`.

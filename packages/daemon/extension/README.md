# Agentic Browser Input Bridge Extension

Chrome extension that lets daemon-agent replay remote input on cross-origin pages.

## Why this exists

Without an extension, daemon-agent can only directly access same-origin tab DOM APIs. For pages such as `https://www.zhihu.com/signin?next=%2F`, direct DOM access is blocked by browser security policy.

This extension runs a content script on all pages and now also uses a background service worker to track and bind controllable tabs.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `packages/daemon/extension`.

## Usage with daemon-agent

### Workflow A: daemon-agent opens the target tab

1. Start daemon as usual (`pnpm start:daemon`).
2. Open daemon-agent page.
3. Open target page in a new tab from daemon-agent (for example Zhihu signin page).
4. Refresh target tab once after installing the extension.
5. In daemon-agent, click **Check Extension** and confirm status is active.
6. Click **Share Screen** and select the target tab in the browser picker.
7. Connect remote client and control input from viewer.

### Workflow B: user opens the target tab manually

1. Start daemon as usual (`pnpm start:daemon`).
2. Open the target page manually in a normal browser tab.
3. Refresh that tab once after extension install.
4. Return to daemon-agent page.
5. Click **Bind Last Active Tab**.
6. Confirm extension status shows the bound tab.
7. Click **Share Screen** and select that same tab in the browser picker.

### Automatic status updates

- daemon-agent now polls extension status automatically.
- `Check Extension` still works as an explicit verification step.
- Clicking the extension action while a target tab is focused also marks that tab as the controlled target.

## Notes

- The extension only handles command replay and target-tab tracking. WebRTC stream/signaling still uses existing daemon/client flow.
- Some websites may have anti-automation protections that can ignore synthetic events.
- `window.close()` can fail if the tab is not script-opened.

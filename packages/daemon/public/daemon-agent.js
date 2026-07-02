/* global Owt */

import { createExtensionBridge } from '/daemon-src/extensionBridge.browser.js';
import { createTargetTabCommandForwarder } from '/daemon-src/targetTabForwarding.browser.js';

async function loadRuntimeConfig() {
  try {
    const response = await fetch('/daemon-agent.config.json', { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    const config = await response.json();
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

(async function () {
  console.debug('[daemon-agent] script init');

  const params = new URLSearchParams(window.location.search);
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const uidInput = document.getElementById('uid');
  const remoteInput = document.getElementById('remote');
  const hostInput = document.getElementById('host');
  const shareBtn = document.getElementById('share');
  const targetUrlInput = document.getElementById('targetUrl');
  const openTargetBtn = document.getElementById('openTarget');
  const openTargetTabBtn = document.getElementById('openTargetTab');
  const bindLastActiveTargetBtn = document.getElementById('bindLastActiveTarget');
  const checkExtensionBtn = document.getElementById('checkExtension');
  const extensionStatusEl = document.getElementById('extensionStatus');
  const targetIndicatorEl = document.getElementById('targetIndicator');
  const targetFrame = document.getElementById('targetFrame');
  const runtimeConfig = await loadRuntimeConfig();

  uidInput.value = params.get('uid') || runtimeConfig.daemonId || uidInput.value;
  remoteInput.value = params.get('remote') || runtimeConfig.clientId || remoteInput.value;
  hostInput.value = params.get('host') || runtimeConfig.signalingServer || hostInput.value;

  let p2p = null;
  let screenStream = null;
  let targetTabWindow = null;
  let extensionManagedTarget = null;
  let controlTargetMode = null;

  function setStatus(text) {
    statusEl.textContent = text;
    console.log(text);
  }

  function appendMessage(message) {
    messagesEl.textContent += `${message}\n`;
  }

  function setExtensionStatus(message) {
    if (extensionStatusEl) {
      extensionStatusEl.textContent = `Extension status: ${message}`;
    }
  }

  function setTargetIndicator(message) {
    if (targetIndicatorEl) {
      targetIndicatorEl.innerHTML = `<strong>Controlled tab:</strong> ${message}`;
    }
  }

  function formatTargetDescriptor(target) {
    if (!target) {
      return 'none';
    }

    const title = target.title || 'Untitled tab';
    const url = target.url || 'unknown url';
    return `${title} (${url})`;
  }

  function updateTargetIndicatorFromState({ directTarget = null, controlledTarget = null, lastActiveTarget = null } = {}) {
    extensionManagedTarget = controlledTarget || null;

    if (controlledTarget) {
      setTargetIndicator(`extension-managed: ${formatTargetDescriptor(controlledTarget)}`);
      return;
    }

    if (directTarget) {
      setTargetIndicator(`daemon-opened: ${directTarget}`);
      return;
    }

    if (lastActiveTarget) {
      setTargetIndicator(`available last active: ${formatTargetDescriptor(lastActiveTarget)}`);
      return;
    }

    setTargetIndicator('none');
  }

  function shouldUseDirectTarget() {
    return controlTargetMode === 'direct' && Boolean(targetTabWindow && !targetTabWindow.closed);
  }

  function shouldUseExtensionManagedTarget() {
    return controlTargetMode === 'extension' && Boolean(extensionManagedTarget);
  }

  const extensionBridge = createExtensionBridge({
    windowObject: window,
    onExtensionPing: (data) => {
      setExtensionStatus(`active on ${data.origin || 'unknown origin'}`);
    },
  });

  function getScreenShareUnavailableReason() {
    if (!window.isSecureContext) {
      return 'Screen share requires a secure page context. Open daemon-agent via https:// or http://localhost.';
    }
    if (!navigator.mediaDevices) {
      return 'Screen share is unavailable because navigator.mediaDevices is missing in this browser/context.';
    }
    if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      return 'Screen share is unavailable because this browser does not expose getDisplayMedia.';
    }
    return null;
  }

  function normalizeTargetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) {
      return '/target-demo.html';
    }
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
      return raw;
    }
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }
    return `https://${raw}`;
  }

  const forwardCommandToTargetTab = createTargetTabCommandForwarder({
    getTargetWindow: () => targetTabWindow,
    getFallbackViewport: () => ({
      width: targetFrame.clientWidth,
      height: targetFrame.clientHeight,
    }),
    waitForExtensionAck: extensionBridge.waitForExtensionAck,
    createRequestId: extensionBridge.createRequestId,
    normalizeTargetUrl,
    getTargetUrl: () => targetUrlInput.value,
    logger: console,
  });

  async function openTarget(url) {
    const normalizedUrl = normalizeTargetUrl(url);
    targetUrlInput.value = normalizedUrl;

    if (targetTabWindow && !targetTabWindow.closed) {
      try {
        targetTabWindow.location.href = normalizedUrl;
        targetTabWindow.focus();
        window.setTimeout(() => {
          checkExtensionOnTargetTab().catch(() => {});
        }, 600);
        setStatus(`Target tab navigated to: ${normalizedUrl}`);
        return { ok: true, message: `Target tab navigated: ${normalizedUrl}` };
      } catch (error) {
        console.debug('[daemon-agent] openTarget tab navigation failed, reopening tab', error);
      }
    }

    targetTabWindow = window.open(normalizedUrl, '_blank');
    if (!targetTabWindow) {
      throw new Error('Popup blocked. Allow popups to open the target tab.');
    }
    controlTargetMode = 'direct';
    targetTabWindow.focus();
    updateTargetIndicatorFromState({ directTarget: normalizedUrl });
    window.setTimeout(() => {
      checkExtensionOnTargetTab().catch(() => {});
    }, 800);
    setStatus(`Opened target in new tab: ${normalizedUrl}`);

    return { ok: true, message: `Target page opened in new tab: ${normalizedUrl}` };
  }

  function openTargetInNewTab(url) {
    const normalizedUrl = normalizeTargetUrl(url);
    targetUrlInput.value = normalizedUrl;
    targetTabWindow = window.open(normalizedUrl, '_blank');
    controlTargetMode = 'direct';
    updateTargetIndicatorFromState({ directTarget: normalizedUrl });
    window.setTimeout(() => {
      checkExtensionOnTargetTab().catch(() => {});
    }, 800);
    setStatus(`Opened target in new tab: ${normalizedUrl}`);
  }

  async function checkExtensionOnTargetTab() {
    if (!targetTabWindow || targetTabWindow.closed) {
      setExtensionStatus('target tab is not open');
      return { ok: false, error: 'Target tab is not open.' };
    }

    const requestId = extensionBridge.createRequestId('ext-ping');
    const pingCommand = { type: 'extension_ping', requestId, payload: {} };

    console.log('[daemon-agent] checkExtensionOnTargetTab send', {
      requestId,
      hasTargetTab: true,
    });

    targetTabWindow.postMessage({ type: 'agentic-input', command: pingCommand, ts: Date.now() }, '*');

    const ack = await extensionBridge.waitForExtensionAck(requestId, 1500);
    if (!ack) {
      console.log('[daemon-agent] checkExtensionOnTargetTab timeout', { requestId });
      setExtensionStatus('no response. Install extension and refresh target page');
      return { ok: false, error: 'No extension ack.' };
    }

    console.log('[daemon-agent] checkExtensionOnTargetTab ack', ack);
    controlTargetMode = 'direct';
    setExtensionStatus(`active on ${ack.origin || 'unknown origin'}`);
    return { ok: true, message: `Extension active on ${ack.origin || 'unknown origin'}` };
  }

  async function bindLastActiveExtensionTarget() {
    const response = await extensionBridge.sendExtensionRequest('bind_last_active_target', {}, 2200);
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to bind last active tab through extension.');
    }

    controlTargetMode = 'extension';
    updateTargetIndicatorFromState({ controlledTarget: response.controlledTarget });
    setExtensionStatus(`extension-managed target bound: ${formatTargetDescriptor(response.controlledTarget)}`);
    return response;
  }

  async function getExtensionManagedStatus() {
    return extensionBridge.sendExtensionRequest('get_status', {}, 1500);
  }

  async function checkExtensionManagedTarget() {
    const response = await extensionBridge.sendExtensionRequest('check_controlled_target', {}, 2200);
    if (!response?.ok) {
      throw new Error(response?.error || 'Extension-managed target check failed.');
    }

    controlTargetMode = 'extension';
    updateTargetIndicatorFromState({ controlledTarget: response.controlledTarget });
    setExtensionStatus(
      `extension-managed target active: ${formatTargetDescriptor(response.controlledTarget)}`
    );
    return response;
  }

  async function activateExtensionManagedTarget() {
    const response = await extensionBridge.sendExtensionRequest('activate_controlled_target', {}, 2200);
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to activate extension-managed target.');
    }

    if (response.controlledTarget) {
      controlTargetMode = 'extension';
      updateTargetIndicatorFromState({ controlledTarget: response.controlledTarget });
      setExtensionStatus(`extension-managed target active: ${formatTargetDescriptor(response.controlledTarget)}`);
    }

    return response;
  }

  async function forwardCommandViaExtension(command) {
    const response = await extensionBridge.sendExtensionRequest('dispatch_command', { command }, 2500);
    if (!response?.ok) {
      return {
        ok: false,
        error: response?.error || response?.message || 'Extension-managed target command failed.',
      };
    }

    if (response.controlledTarget) {
      controlTargetMode = 'extension';
      updateTargetIndicatorFromState({ controlledTarget: response.controlledTarget });
      setExtensionStatus(`extension-managed target active: ${formatTargetDescriptor(response.controlledTarget)}`);
    }

    return response;
  }

  async function refreshExtensionStatus() {
    try {
      const status = await getExtensionManagedStatus();
      if (!status?.ok) {
        return;
      }

      if (status.controlledTarget) {
        if (controlTargetMode !== 'direct') {
          controlTargetMode = 'extension';
        }
        updateTargetIndicatorFromState({ controlledTarget: status.controlledTarget });
        setExtensionStatus(`extension-managed target active: ${formatTargetDescriptor(status.controlledTarget)}`);
        return;
      }

      if (status.lastActiveTarget) {
        updateTargetIndicatorFromState({ lastActiveTarget: status.lastActiveTarget });
        setExtensionStatus(`last active tab available: ${formatTargetDescriptor(status.lastActiveTarget)}`);
        return;
      }

      if (!targetTabWindow || targetTabWindow.closed) {
        updateTargetIndicatorFromState({});
        setExtensionStatus('no target selected');
      }
    } catch {
      if (!targetTabWindow || targetTabWindow.closed) {
        updateTargetIndicatorFromState({});
        setExtensionStatus('extension bridge unavailable or not refreshed on daemon page');
      }
    }
  }

  function getSharedTrackLabel(mediaStream) {
    const track = mediaStream?.getVideoTracks?.()[0];
    return String(track?.label || '').trim();
  }

  function looksLikeCorrectSharedTarget(sharedTrackLabel) {
    if (!sharedTrackLabel) {
      return true;
    }

    if (extensionManagedTarget?.title) {
      return sharedTrackLabel.includes(extensionManagedTarget.title);
    }

    if (targetUrlInput.value) {
      return sharedTrackLabel.includes(targetUrlInput.value) || targetUrlInput.value.includes(sharedTrackLabel);
    }

    return true;
  }

  async function forwardCommandToOpenTarget(command) {
    const result = await forwardCommandToTargetTab(command);

    if (command?.type === 'close_page' && result?.ok !== false) {
      targetTabWindow = null;
      if (controlTargetMode === 'direct') {
        controlTargetMode = null;
      }
      updateTargetIndicatorFromState({});
    }

    return result;
  }


  async function handleCommand(command) {
    const { type, payload = {} } = command;
    console.log('[daemon-agent] handleCommand received', {
      type,
      payload,
      requestId: command?.requestId,
    });

    switch (type) {
      case 'open_url':
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand route to target tab', { type });
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'close_page':
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand route to target tab', { type });
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'mouse_move':
        console.debug('[daemon-agent] handleCommand mouse_move', { payload });
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand mouse_move -> target tab');
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'mouse_down':
        console.debug('[daemon-agent] handleCommand mouse_down', { payload });
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand mouse_down -> target tab');
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'mouse_up':
        console.debug('[daemon-agent] handleCommand mouse_up', { payload });
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand mouse_up -> target tab');
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'mouse_click':
        console.debug('[daemon-agent] handleCommand mouse_click', { payload });
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand mouse_click -> target tab');
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'text_input':
        console.debug('[daemon-agent] handleCommand text_input', { payload });
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand text_input -> target tab');
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'key_press':
        console.debug('[daemon-agent] handleCommand key_press', { payload });
        if (shouldUseExtensionManagedTarget()) {
          return forwardCommandViaExtension(command);
        }
        if (shouldUseDirectTarget()) {
          console.debug('[daemon-agent] handleCommand key_press -> target tab');
          return forwardCommandToOpenTarget(command);
        }
        return forwardCommandViaExtension(command);
      case 'extension_ping':
        if (shouldUseExtensionManagedTarget()) {
          return checkExtensionManagedTarget();
        }
        if (shouldUseDirectTarget()) {
          return forwardCommandToOpenTarget(command);
        }
        return checkExtensionManagedTarget();
      case 'launch_chrome':
      case 'exit_chrome':
        return { ok: false, error: `${type} is not used in daemon-agent embedded-target demo.` };
      default:
        return { ok: false, error: `Unsupported command type: ${type}` };
    }
  }

  async function connect() {
    const daemonId = uidInput.value.trim();
    const remoteId = remoteInput.value.trim();
    const signalingHost = hostInput.value.trim();

    console.debug('[daemon-agent] connect() called', { daemonId, remoteId, signalingHost });

    if (!daemonId) {
      throw new Error('Daemon ID is required.');
    }
    if (!remoteId) {
      throw new Error('Client ID is required.');
    }
    if (!signalingHost) {
      throw new Error('Signaling host is required.');
    }

    if (p2p) {
      p2p.disconnect();
      p2p = null;
    }

    const signaling = new window.SignalingChannel();
    p2p = new Owt.P2P.P2PClient({ rtcConfiguration: {} }, signaling);
    p2p.allowedRemoteIds = [remoteId];

    console.debug('[daemon-agent] connecting', {
      daemonId,
      remoteId,
      signalingHost,
      allowedRemoteIds: p2p.allowedRemoteIds,
    });

    p2p.addEventListener('serverdisconnected', () => {
      setStatus('Disconnected from signaling server.');
    });

    p2p.addEventListener('messagereceived', async (e) => {
      console.debug('[daemon-agent] message received', {
        origin: e.origin,
        message: e.message,
      });
      appendMessage(`from ${e.origin}: ${e.message}`);

      try {
        const command = JSON.parse(e.message);
        const body = await handleCommand(command);
        console.log('[daemon-agent] command processed', {
          requestId: command.requestId,
          type: command.type,
          body,
        });
        console.log(
          `[daemon-agent] command summary requestId=${command.requestId || 'n/a'} type=${command.type || 'unknown'} ok=${body?.ok !== false} ` +
          `message=${body?.message || ''} error=${body?.error || ''} bridge=${body?.bridge || ''}`
        );
        await p2p.send(
          e.origin,
          JSON.stringify({
            type: 'command_result',
            requestId: command.requestId,
            ok: body.ok !== false,
            result: body,
          })
        );
      } catch (error) {
        appendMessage(`command error: ${error.message}`);
        try {
          await p2p.send(
            e.origin,
            JSON.stringify({
              type: 'command_result',
              ok: false,
              error: error.message,
            })
          );
        } catch {
          // Ignore secondary send failures.
        }
      }
    });

    await p2p.connect({ host: signalingHost, token: daemonId });
    uidInput.disabled = true;
    setStatus(`Connected as ${daemonId}. Waiting for ${remoteId} messages.`);
  }

  async function shareScreen() {
    console.log('[daemon-agent] shareScreen called');
    if (!p2p) {
      setStatus('Connect first.');
      return;
    }

    const unavailableReason = getScreenShareUnavailableReason();
    if (unavailableReason) {
      setStatus(`Share error: ${unavailableReason}`);
      return;
    }

    if (screenStream && screenStream.mediaStream) {
      screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }

    let mediaStream;
    try {
      if (targetTabWindow && !targetTabWindow.closed && targetTabWindow !== window) {
        try {
          targetTabWindow.focus();
        } catch {
          // Ignore focus failures and keep best-effort tab selection guidance.
        }
        setStatus('Please select the opened target tab in the browser picker to share it.');
      } else if (extensionManagedTarget) {
        try {
          const activated = await activateExtensionManagedTarget();
          setStatus(
            `Please select the extension-managed target tab in the browser picker: ${formatTargetDescriptor(activated.controlledTarget)}`
          );
        } catch (error) {
          setStatus(`Share hint: extension-managed target could not be activated (${error.message}). Select the bound tab manually.`);
        }
      }
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
      });
    } catch (error) {
      setStatus(`Share error: ${error.message}`);
      return;
    }

    const sharedTrackLabel = getSharedTrackLabel(mediaStream);
    if (!looksLikeCorrectSharedTarget(sharedTrackLabel)) {
      setStatus(
        `Share warning: selected stream looks like "${sharedTrackLabel}" but controlled tab is ${formatTargetDescriptor(extensionManagedTarget)}`
      );
    }

    screenStream = new Owt.Base.LocalStream(
      mediaStream,
      new Owt.Base.StreamSourceInfo('screen-cast', 'screen-cast')
    );
    await p2p.publish(remoteInput.value.trim(), screenStream);

    if (targetTabWindow && !targetTabWindow.closed && targetTabWindow !== window) {
      try {
        targetTabWindow.focus();
      } catch {
        // Ignore focus failures.
      }
    } else if (extensionManagedTarget) {
      try {
        await activateExtensionManagedTarget();
      } catch {
        // Ignore activation failures after publish.
      }
    }

    setStatus(
      sharedTrackLabel
        ? `Screen stream published (${sharedTrackLabel}).`
        : 'Screen stream published.'
    );
  }

  const initialScreenShareReason = getScreenShareUnavailableReason();
  if (initialScreenShareReason) {
    shareBtn.title = initialScreenShareReason;
    setStatus(`Share unavailable: ${initialScreenShareReason}`);
  }

  async function disconnect() {
    if (p2p) {
      p2p.disconnect();
      p2p = null;
    }
    uidInput.disabled = false;
    controlTargetMode = null;
    updateTargetIndicatorFromState({});
    setStatus('Disconnected.');
  }

  document.getElementById('connect').addEventListener('click', () => {
    console.debug('[daemon-agent] Connect button clicked');
    setStatus('Connecting...');
    connect().catch((error) => setStatus(`Connect error: ${error.message}`));
  });

  openTargetBtn.addEventListener('click', () => {
    openTarget(targetUrlInput.value).catch((error) => setStatus(`Open target error: ${error.message}`));
  });

  openTargetTabBtn.addEventListener('click', () => {
    try {
      openTargetInNewTab(targetUrlInput.value);
    } catch (error) {
      setStatus(`Open target tab error: ${error.message}`);
    }
  });

  bindLastActiveTargetBtn.addEventListener('click', () => {
    bindLastActiveExtensionTarget().catch((error) => {
      setExtensionStatus(`bind failed: ${error.message}`);
    });
  });

  checkExtensionBtn.addEventListener('click', () => {
    (async () => {
      if (targetTabWindow && !targetTabWindow.closed) {
        try {
          await checkExtensionOnTargetTab();
          return;
        } catch (error) {
          console.log('[daemon-agent] direct target extension check failed, trying extension-managed target', {
            error: error.message,
          });
        }
      }

      await bindLastActiveExtensionTarget();
      await checkExtensionManagedTarget();
    })().catch((error) => {
      setExtensionStatus(`check failed: ${error.message}`);
    });
  });

  shareBtn.addEventListener('click', () => {
    console.log('[daemon-agent] Share button clicked');
    shareScreen().catch((error) => setStatus(`Share error: ${error.message}`));
  });

  document.getElementById('disconnect').addEventListener('click', () => {
    disconnect().catch((error) => setStatus(`Disconnect error: ${error.message}`));
  });

  setExtensionStatus('not checked');
  setTargetIndicator('none');
  window.setInterval(() => {
    refreshExtensionStatus().catch(() => {});
  }, 2000);
  refreshExtensionStatus().catch(() => {});
})();

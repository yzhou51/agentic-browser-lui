import {
  AgenticBrowserClient,
  createViewerMouseCommandSender,
} from '../sdk/index.js';

async function loadRuntimeConfig() {
  try {
    const response = await fetch('/client-demo.runtime.json', { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    const config = await response.json();
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

async function init() {
  const runtimeConfig = await loadRuntimeConfig();
  const client = new AgenticBrowserClient();
  const actionChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('agentic-browser-action')
    : null;
  let activePointerId = null;
  let isMousePressed = false;
  let connected = false;
  let pendingAction = null;
  let pendingActionConfirmedByDaemon = false;

  const el = {
    clientId: document.getElementById('clientId'),
    signalingUrl: document.getElementById('signalingUrl'),
    status: document.getElementById('status'),
    connectBtn: document.getElementById('connectBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    resolveBtn: document.getElementById('resolveBtn'),
    actionRequestMessage: document.getElementById('actionRequestMessage'),
    remoteVideo: document.getElementById('remoteVideo'),
    textCapture: document.getElementById('textCapture'),
    textInput: document.getElementById('textInput'),
    sendTextBtn: document.getElementById('sendTextBtn'),
    logs: document.getElementById('logs'),
  };

  const envSignalingServer = runtimeConfig.signalingServer || import.meta.env?.SIGNALING_SERVER || window.location.origin;
  const envClientId = runtimeConfig.clientId || import.meta.env?.CLIENT_ID;

  if (envSignalingServer) {
    el.signalingUrl.value = envSignalingServer;
  }
  if (envClientId) {
    el.clientId.value = envClientId;
  }

  function getActiveDaemonId() {
    const fromRequest = String(pendingAction?.daemonId || '').trim();
    if (fromRequest) {
      return fromRequest;
    }
    return '';
  }

  function log(message) {
    el.logs.textContent += `${message}\n`;
  }

  function logJson(label, value) {
    log(`${label}: ${JSON.stringify(value)}`);
  }

  function setStatus(state, message) {
    el.status.dataset.state = state;
    el.status.textContent = message;
  }

  function updateActionRequestView() {
    if (!pendingAction) {
      el.actionRequestMessage.textContent = 'No pending action request.';
      el.resolveBtn.disabled = true;
      return;
    }

    const targetText = pendingAction.targetUrl ? ` target ${pendingAction.targetUrl}` : ' target page';
    if (pendingActionConfirmedByDaemon) {
      el.actionRequestMessage.textContent =
        `Agent requests action for daemon "${pendingAction.daemonId || 'unknown'}" and${targetText}. ` +
        'Connect, then click Resolve.';
    } else {
      el.actionRequestMessage.textContent =
        `Take Action received for daemon "${pendingAction.daemonId || 'unknown'}" and${targetText}. ` +
        'Waiting for daemon action_request confirmation...';
    }
    el.resolveBtn.disabled = !(connected && pendingActionConfirmedByDaemon);
  }

  function setPendingAction(action, options = {}) {
    pendingAction = action;
    pendingActionConfirmedByDaemon = Boolean(options.confirmedByDaemon);
    const requestedDaemonId = String(action?.daemonId || '').trim();
    if (requestedDaemonId) {
      client.setDaemonId(requestedDaemonId);
    }
    if (action?.signalingServer) {
      el.signalingUrl.value = action.signalingServer;
    }
    updateActionRequestView();
  }

  async function sendTextInput(text) {
    if (!text) {
      return;
    }

    console.log('[client] sendTextInput', { text, textLength: text.length });
    const requestId = await client.sendCommand('text_input', { text });
    log(`text_input sent (${requestId}): ${JSON.stringify(text)}`);
  }

  async function sendKeyPress(key) {
    console.log('[client] sendKeyPress', { key });
    const requestId = await client.sendCommand('key_press', { key });
    log(`key_press sent (${requestId}): ${key}`);
  }

  const sendMouseCommand = createViewerMouseCommandSender({
    sendCommand: (type, payload) => client.sendCommand(type, payload),
    videoElement: el.remoteVideo,
    getIsDragging: () => isMousePressed,
    onPointerMapped: (mapped) => {
      console.debug('[client] pointer mapped', mapped);
    },
    onBeforeSend: ({ type, payload }) => {
      console.log('[client] sendMouseCommand', { type, payload });
    },
    onAfterSend: ({ type, mapped, requestId }) => {
      log(`${type} sent (${requestId}) at (${mapped.x}, ${mapped.y}) in ${mapped.sourceWidth}x${mapped.sourceHeight}.`);
    },
  });

  client.onRemoteStream = (stream) => {
    if (stream?.mediaStream) {
      el.remoteVideo.srcObject = stream.mediaStream;
      el.remoteVideo.play().catch(() => { });
      setStatus('active', 'Connected and receiving remote stream.');
      log('Remote stream attached.');
    }
  };

  client.onDisconnect = () => {
    connected = false;
    updateActionRequestView();
    setStatus('idle', 'Disconnected from signaling. Connect again before Resolve.');
    log('Disconnected from signaling server.');
  };

  client.onReconnectAttempt = ({ daemonId, error }) => {
    const targetDaemonId = String(daemonId || getActiveDaemonId() || 'unknown').trim() || 'unknown';
    setStatus('connecting', `Stale signaling session detected for daemon "${targetDaemonId}". Reconnecting...`);
    log(`Stale signaling session detected for daemon "${targetDaemonId}". Reconnecting...`);
    if (error) {
      log(`Reconnect trigger reason: ${error}`);
    }
  };

  client.onMessage = ({ origin, message }) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'action_request') {
        const actionPayload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
        setPendingAction({
          requestId: parsed.requestId || '',
          daemonId: actionPayload.daemonId || origin,
          clientId: actionPayload.clientId || el.clientId.value,
          signalingServer: actionPayload.signalingServer || el.signalingUrl.value,
          targetUrl: actionPayload.targetUrl || '',
        }, { confirmedByDaemon: true });
        setStatus('connected', `Action request received from daemon "${origin}". Connect and click Resolve.`);
        log(`Action request received from "${origin}".`);
        return;
      }
      if (parsed.type === 'resolve_result') {
        const ok = parsed.ok !== false;
        setStatus(ok ? 'active' : 'error', ok ? 'Resolve processed. Daemon is starting screen share.' : `Resolve failed: ${parsed.error || 'unknown error'}`);
        log(`Resolve result: ${ok ? 'ok' : 'failed'} ${parsed.error ? `(${parsed.error})` : ''}`);
        return;
      }
      if (parsed.type === 'command_result') {
        setStatus('active', `Connected to daemon "${origin}". Last command result received.`);
        console.log('[client] command_result received', parsed);
        log(
          `Result "${parsed.requestId || 'n/a'}" from "${origin}": ${parsed.ok ? 'ok' : 'failed'} ` +
          `${parsed.error ? `(${parsed.error})` : ''}`
        );
        if (parsed.result) {
          logJson(`Result body ${parsed.requestId || 'n/a'}`, parsed.result);
        }
        return;
      }
    } catch {
      // Keep compatibility with plain text messages.
    }
    setStatus('active', `Connected to daemon "${origin}". Message received.`);
    log(`Message from "${origin}": ${message}`);
  };

  el.connectBtn.addEventListener('click', async () => {
    const daemonId = getActiveDaemonId();
    if (!daemonId) {
      setStatus('error', 'No daemon id available yet. Wait for Take Action request from Agent page.');
      log('Connect blocked: daemon id is missing.');
      return;
    }

    setStatus('connecting', `Connecting to daemon "${daemonId}" via "${el.signalingUrl.value}"...`);
    log(`Connecting to signaling server "${el.signalingUrl.value}" for daemon "${daemonId}".`);
    try {
      await client.connect({
        signalingHost: el.signalingUrl.value,
        clientId: el.clientId.value,
        daemonId,
        forceReconnect: true,
      });
      connected = true;
      updateActionRequestView();
      if (pendingActionConfirmedByDaemon) {
        setStatus('connected', `Connected to signaling for daemon "${daemonId}". Click Resolve to start screen share.`);
      } else {
        setStatus('connected', `Connected to signaling for daemon "${daemonId}". Waiting for daemon action_request confirmation.`);
      }
      log('Connected to signaling and daemon peer endpoint.');
    } catch (error) {
      setStatus('error', `Connect failed: ${error.message}`);
      console.error('[client] connect failed', {
        daemonId,
        signalingUrl: el.signalingUrl.value,
        clientId: el.clientId.value,
        error,
      });
      log(`Connect failed: ${error.message}`);
    }
  });

  el.disconnectBtn.addEventListener('click', async () => {
    await client.disconnect();
    connected = false;
    updateActionRequestView();
    setStatus('idle', 'Disconnected. Not connected to daemon.');
    log('Disconnected.');
  });

  el.resolveBtn.addEventListener('click', async () => {
    if (!pendingAction) {
      setStatus('error', 'No pending action request to resolve.');
      return;
    }

    const daemonId = getActiveDaemonId();
    if (!daemonId) {
      setStatus('error', 'Resolve failed: daemon id is missing.');
      return;
    }

    if (!connected) {
      setStatus('error', `Resolve failed: not connected to daemon "${daemonId}".`);
      return;
    }

    try {
      if (!pendingActionConfirmedByDaemon) {
        setStatus('connecting', `Connected but daemon confirmation is pending. Sending Resolve fallback to daemon "${daemonId}"...`);
        log('Resolve fallback: action_request confirmation has not arrived; sending resolve directly after short grace delay.');
        await new Promise((resolve) => {
          window.setTimeout(resolve, 1200);
        });
      }

      client.setDaemonId(daemonId);
      const resolveMessage = {
        type: 'resolve',
        requestId: `resolve-${Date.now()}`,
        payload: {
          actionRequestId: pendingAction.requestId || '',
          clientId: el.clientId.value,
        },
      };

      log(`Resolve clicked. Sending message to daemon "${daemonId}": ${JSON.stringify(resolveMessage)}`);
      console.log('[client] resolve clicked', {
        daemonId,
        resolveMessage,
      });

      await client.sendMessage({
        type: resolveMessage.type,
        requestId: resolveMessage.requestId,
        payload: resolveMessage.payload,
      });
      setStatus('connecting', `Resolve sent to daemon "${daemonId}". Waiting for stream...`);
      log(`Resolve sent to daemon "${daemonId}".`);

      window.setTimeout(() => {
        log('Resolve waiting: no resolve_result yet. Check daemon log for incoming resolve message.');
      }, 5000);
    } catch (error) {
      setStatus('error', `Resolve failed: ${error.message}`);
      log(`Resolve failed: ${error.message}`);
    }
  });

  if (actionChannel) {
    actionChannel.onmessage = (event) => {
      const data = event?.data;
      if (!data || data.type !== 'take_action') {
        return;
      }

      setPendingAction({
        requestId: data.requestId || '',
        daemonId: data.daemonId || '',
        clientId: data.clientId || el.clientId.value,
        signalingServer: data.signalingServer || el.signalingUrl.value,
        targetUrl: data.targetUrl || '',
      }, { confirmedByDaemon: false });
      setStatus('connected', `Take Action request received for daemon "${data.daemonId || 'unknown'}". Waiting for daemon confirmation...`);
      log(`Take Action request received from Agent page. daemonId="${data.daemonId || 'unknown'}"`);
    };
  }

  updateActionRequestView();

  el.sendTextBtn.addEventListener('click', async () => {
    const text = el.textInput.value;
    try {
      await sendTextInput(text);
    } catch (error) {
      log(`text_input failed: ${error.message}`);
    }
  });

  el.textCapture.addEventListener('keydown', async (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const arrowKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
    if (arrowKeys.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();

      try {
        await sendKeyPress(event.key);
      } catch (error) {
        log(`key_press failed: ${error.message}`);
      }
      return;
    }

    if (event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();

      console.debug('[client] text capture backspace', {
        key: event.key,
        inputType: event.inputType,
      });

      try {
        await sendKeyPress('Backspace');
      } catch (error) {
        log(`key_press failed: ${error.message}`);
      }
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      try {
        await sendTextInput('\t');
      } catch (error) {
        log(`text_input failed: ${error.message}`);
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      try {
        await sendTextInput('\n');
      } catch (error) {
        log(`text_input failed: ${error.message}`);
      }
    }
  });

  el.textCapture.addEventListener('beforeinput', async (event) => {
    if (event.inputType !== 'deleteContentBackward') {
      return;
    }

    event.preventDefault();

    try {
      await sendKeyPress('Backspace');
    } catch (error) {
      log(`key_press failed: ${error.message}`);
    }
  });

  el.textCapture.addEventListener('input', async (event) => {
    const text = event.data ?? el.textCapture.value;
    el.textCapture.value = '';

    if (!text) {
      return;
    }

    console.debug('[client] text capture input', {
      data: event.data,
      inputType: event.inputType,
      text,
    });

    try {
      await sendTextInput(text);
    } catch (error) {
      log(`text_input failed: ${error.message}`);
    }
  });

  el.remoteVideo.addEventListener('pointerdown', async (event) => {
    event.preventDefault();
    el.textCapture.value = '';
    el.textCapture.focus();
    el.textCapture.setSelectionRange(0, 0);
    log('Remote viewer clicked. Text capture is active.');

    activePointerId = event.pointerId;
    isMousePressed = true;

    if (typeof el.remoteVideo.setPointerCapture === 'function') {
      try {
        el.remoteVideo.setPointerCapture(event.pointerId);
      } catch {
        // Ignore pointer capture failures and keep best-effort drag support.
      }
    }

    try {
      await sendMouseCommand('mouse_down', event);
    } catch (error) {
      log(`mouse_down failed: ${error.message}`);
    }
  });

  el.remoteVideo.addEventListener('click', async (event) => {
    event.preventDefault();

    try {
      await sendMouseCommand('mouse_click', event);
    } catch (error) {
      log(`mouse_click failed: ${error.message}`);
    }
  });

  el.remoteVideo.addEventListener('pointermove', async (event) => {
    if ((event.timeStamp | 0) % 7 !== 0) {
      return;
    }

    try {
      await sendMouseCommand('mouse_move', event, {
        isDragging: isMousePressed,
      });
    } catch {
      // Keep cursor movement lightweight and silent on temporary send errors.
    }
  });

  async function releasePointer(event, reason) {
    if (!isMousePressed) {
      return;
    }

    if (activePointerId != null && event.pointerId != null && event.pointerId !== activePointerId) {
      return;
    }

    isMousePressed = false;

    if (activePointerId != null && typeof el.remoteVideo.releasePointerCapture === 'function') {
      try {
        el.remoteVideo.releasePointerCapture(activePointerId);
      } catch {
        // Ignore release failures.
      }
    }

    activePointerId = null;

    try {
      await sendMouseCommand('mouse_up', event, { releaseReason: reason, isDragging: false });
    } catch (error) {
      log(`mouse_up failed: ${error.message}`);
    }
  }

  el.remoteVideo.addEventListener('pointerup', async (event) => {
    event.preventDefault();
    await releasePointer(event, 'pointerup');
  });

  el.remoteVideo.addEventListener('pointercancel', async (event) => {
    event.preventDefault();
    await releasePointer(event, 'pointercancel');
  });

  el.remoteVideo.addEventListener('lostpointercapture', async () => {
    if (!isMousePressed) {
      return;
    }

    const syntheticEvent = {
      button: 0,
      pointerId: activePointerId,
      clientX: 0,
      clientY: 0,
      timeStamp: performance.now(),
    };
    await releasePointer(syntheticEvent, 'lostpointercapture');
  });

  el.remoteVideo.addEventListener('focus', () => {
    log('Remote viewer focused. Click the viewer to activate text capture.');
  });

}

init();

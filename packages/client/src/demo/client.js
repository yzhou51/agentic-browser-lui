import {
  AgenticBrowserClient,
  createViewerMouseCommandSender,
  loadClientRuntimeConfig,
  summarizeIceConfigForLog,
} from '../sdk/index.js';
import { formatIceUrls, normalizeRtcIceOptions, parseRtcIceServersJson } from '../sdk/rtcConfig.js';

async function init() {
  const runtimeConfig = await loadClientRuntimeConfig('/client-demo.runtime.json');
  const client = new AgenticBrowserClient();
  let activePointerId = null;
  let isMousePressed = false;
  let connected = false;
  let leaveSent = false;

  const el = {
    clientId: document.getElementById('clientId'),
    remoteId: document.getElementById('remoteId'),
    signalingUrl: document.getElementById('signalingUrl'),
    stunUrls: document.getElementById('stunUrls'),
    turnUrls: document.getElementById('turnUrls'),
    turnUsername: document.getElementById('turnUsername'),
    turnCredential: document.getElementById('turnCredential'),
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
  const envDaemonId = runtimeConfig.daemonId || import.meta.env?.DAEMON_ID;
  const runtimeStunUrls = runtimeConfig.stunUrls ?? runtimeConfig.stuneUrls;
  const runtimeTurnUrls = runtimeConfig.turnUrls;
  const runtimeTurnUsername = runtimeConfig.turnUsername;
  const runtimeTurnCredential = runtimeConfig.turnCredential ?? runtimeConfig.turnPassword;
  const hasExplicitIceFields = Boolean(
    runtimeStunUrls || runtimeTurnUrls || runtimeTurnUsername || runtimeTurnCredential
  );
  const envIceConfig = normalizeRtcIceOptions({
    ...runtimeConfig,
    stunUrls: runtimeStunUrls ?? import.meta.env?.STUN_SERVER_URLS,
    turnUrls: runtimeTurnUrls ?? import.meta.env?.TURN_SERVER_URLS,
    turnUsername: runtimeTurnUsername ?? import.meta.env?.TURN_USERNAME,
    turnCredential: runtimeTurnCredential ?? import.meta.env?.TURN_CREDENTIAL,
    rtcIceServers: hasExplicitIceFields
      ? []
      : (Array.isArray(runtimeConfig.rtcIceServers) && runtimeConfig.rtcIceServers.length
        ? runtimeConfig.rtcIceServers
        : parseRtcIceServersJson(import.meta.env?.RTC_ICE_SERVERS_JSON)),
  });

  if (envSignalingServer) {
    el.signalingUrl.value = envSignalingServer;
  }
  if (envClientId) {
    el.clientId.value = envClientId;
  }
  if (envDaemonId) {
    el.remoteId.value = envDaemonId;
  }
  if (envIceConfig.stunUrls.length) {
    el.stunUrls.value = formatIceUrls(envIceConfig.stunUrls);
  }
  if (envIceConfig.turnUrls.length) {
    el.turnUrls.value = formatIceUrls(envIceConfig.turnUrls);
  }
  if (envIceConfig.turnUsername) {
    el.turnUsername.value = envIceConfig.turnUsername;
  }
  if (envIceConfig.turnCredential) {
    el.turnCredential.value = envIceConfig.turnCredential;
  }

  function getRtcConnectOptions() {
    return normalizeRtcIceOptions({
      stunUrls: el.stunUrls.value,
      turnUrls: el.turnUrls.value,
      turnUsername: el.turnUsername.value,
      turnCredential: el.turnCredential.value,
    });
  }

  function getActiveDaemonId() {
    return String(el.remoteId?.value || '').trim();
  }

  function sendLeaveMessage(reason) {
    if (leaveSent || !connected) {
      return;
    }

    const daemonId = getActiveDaemonId();
    if (!daemonId) {
      return;
    }

    leaveSent = true;
    client.setDaemonId(daemonId);
    const leaveMessage = {
      type: 'leave',
      requestId: `leave-${Date.now()}`,
      payload: {
        clientId: String(el.clientId?.value || '').trim(),
        reason,
      },
    };

    try {
      void client.sendMessage(leaveMessage, daemonId).catch(() => {});
    } catch {
      // Keep close flow best-effort only.
    }
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
    const activeDaemonId = getActiveDaemonId();
    const canResolve = Boolean(connected && activeDaemonId);
    el.actionRequestMessage.textContent = activeDaemonId
      ? `Target daemon is "${activeDaemonId}". Click Connect, then Resolve.`
      : 'Enter Remote ID (daemon id), then click Connect and Resolve.';
    el.resolveBtn.disabled = !canResolve;
  }

  function isControlReady() {
    return Boolean(connected && el.remoteVideo?.srcObject);
  }

  function ensureControlReady(commandType) {
    if (isControlReady()) {
      return true;
    }

    const message = `Skip ${commandType}: daemon stream is not ready yet. Connect and resolve first.`;
    setStatus('connecting', message);
    log(message);
    return false;
  }

  el.remoteId.addEventListener('input', () => {
    const remoteId = String(el.remoteId.value || '').trim();
    if (remoteId) {
      client.setDaemonId(remoteId);
    }
    updateActionRequestView();
  });

  async function sendTextInput(text) {
    if (!text) {
      return;
    }
    if (!ensureControlReady('text_input')) {
      return;
    }

    console.log('[client] sendTextInput', { text, textLength: text.length });
    const requestId = await client.sendCommand('text_input', { text });
    log(`text_input sent (${requestId}): ${JSON.stringify(text)}`);
  }

  async function sendKeyPress(key) {
    if (!ensureControlReady('key_press')) {
      return;
    }
    console.log('[client] sendKeyPress', { key });
    const requestId = await client.sendCommand('key_press', { key });
    log(`key_press sent (${requestId}): ${key}`);
  }

  const sendMouseCommand = createViewerMouseCommandSender({
    sendCommand: async (type, payload) => {
      if (!ensureControlReady(type)) {
        return `skipped-${type}-${Date.now()}`;
      }
      return client.sendCommand(type, payload);
    },
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
    console.log('[client] onRemoteStream', {
      hasStream: Boolean(stream),
      streamId: stream?.id || stream?.mediaStream?.id || null,
      hasMediaStream: Boolean(stream?.mediaStream),
    });

    if (stream?.mediaStream) {
      el.remoteVideo.srcObject = stream.mediaStream;
      el.remoteVideo.play().catch(() => { });
      setStatus('active', 'Connected and receiving remote stream.');
      log('Remote stream attached.');
      return;
    }

    log('Remote stream event received, but mediaStream is missing.');
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
      setStatus('error', 'No daemon id available yet. Enter Remote ID first.');
      log('Connect blocked: daemon id is missing.');
      return;
    }

    setStatus('connecting', `Connecting to daemon "${daemonId}" via "${el.signalingUrl.value}"...`);
    log(`Connecting to signaling server "${el.signalingUrl.value}" for daemon "${daemonId}".`);
    try {
      const rtcOptions = getRtcConnectOptions();
      console.log('[client] p2p connect config', {
        signalingServer: String(el.signalingUrl.value || '').trim(),
        daemonId,
        clientId: String(el.clientId.value || '').trim(),
        ...summarizeIceConfigForLog(rtcOptions),
      });

      await client.connect({
        signalingHost: el.signalingUrl.value,
        clientId: el.clientId.value,
        daemonId,
        forceReconnect: true,
        ...rtcOptions,
      });
      connected = true;
      leaveSent = false;
      updateActionRequestView();
      setStatus('connected', `Connected to signaling for daemon "${daemonId}". Click Resolve to start screen share.`);
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
    leaveSent = false;
    updateActionRequestView();
    setStatus('idle', 'Disconnected. Not connected to daemon.');
    log('Disconnected.');
  });

  window.addEventListener('pagehide', () => {
    sendLeaveMessage('pagehide');
  });

  window.addEventListener('beforeunload', () => {
    sendLeaveMessage('beforeunload');
  });

  el.resolveBtn.addEventListener('click', async () => {
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
      client.setDaemonId(daemonId);
      const resolveMessage = {
        type: 'resolve',
        requestId: `resolve-${Date.now()}`,
        payload: {
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
      setStatus('connecting', `Resolve sent to daemon "${daemonId}". Waiting for response...`);
      log(`Resolve sent to daemon "${daemonId}".`);
    } catch (error) {
      setStatus('error', `Resolve failed: ${error.message}`);
      log(`Resolve failed: ${error.message}`);
    }
  });

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

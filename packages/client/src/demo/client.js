import {
  AgenticBrowserClient,
  createPeerIds,
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
    terminalNotice: document.getElementById('terminalNotice'),
    connectBtn: document.getElementById('connectBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    finishBtn: document.getElementById('finishBtn'),
    resolveBtn: document.getElementById('resolveBtn'),
    actionRequestMessage: document.getElementById('actionRequestMessage'),
    remoteVideo: document.getElementById('remoteVideo'),
    textCapture: document.getElementById('textCapture'),
    textInput: document.getElementById('textInput'),
    sendTextBtn: document.getElementById('sendTextBtn'),
    logs: document.getElementById('logs'),
  };

  const envSignalingServer = runtimeConfig.signalingServer || import.meta.env?.SIGNALING_SERVER || 'http://localhost:8095';
  console.log('[client] Resolved signaling server to:', envSignalingServer, '(from config:', runtimeConfig.signalingServer, ')');
  if (!runtimeConfig.signalingServer && !import.meta.env?.SIGNALING_SERVER) {
    console.warn('[client] Using default signaling server. Consider setting SIGNALING_SERVER env var or /client-demo.runtime.json');
  }
  const searchParams = new URLSearchParams(window.location.search);
  const sessionId = String(searchParams.get('sessionId') || runtimeConfig.sessionId || import.meta.env?.SESSION_ID || '').trim();
  const derivedPeerIds = sessionId ? createPeerIds(sessionId) : null;
  const envClientId = String(searchParams.get('clientId') || derivedPeerIds?.clientId || runtimeConfig.clientId || import.meta.env?.CLIENT_ID || '').trim();
  const envDaemonId = String(searchParams.get('remoteId') || derivedPeerIds?.daemonId || runtimeConfig.daemonId || import.meta.env?.DAEMON_ID || '').trim();
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

  async function sendLeaveMessage(reason) {
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
      console.log('[client] sending leave message', { reason, daemonId });
      await Promise.race([
        client.sendMessage(leaveMessage, daemonId),
        new Promise(resolve => setTimeout(resolve, 500)), // Max wait 500ms
      ]);
      console.log('[client] leave message sent', { reason });
    } catch (error) {
      console.log('[client] leave message failed', { reason, error: error?.message });
    }
  }

  async function sendFinishMessage(reason = 'user_click') {
    const daemonId = getActiveDaemonId();
    if (!daemonId) {
      throw new Error('daemon id is missing.');
    }
    if (!connected) {
      throw new Error('not connected to daemon.');
    }

    client.setDaemonId(daemonId);
    await client.sendMessage(
      {
        type: 'finish',
        requestId: `finish-${Date.now()}`,
        payload: {
          clientId: String(el.clientId?.value || '').trim(),
          reason,
        },
      },
      daemonId
    );
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

  function showTerminalNotice(state, message) {
    if (!el.terminalNotice) {
      return;
    }

    const text = String(message || '').trim();
    if (!text) {
      el.terminalNotice.hidden = true;
      el.terminalNotice.textContent = '';
      el.terminalNotice.dataset.state = 'idle';
      return;
    }

    el.terminalNotice.hidden = false;
    el.terminalNotice.dataset.state = state;
    el.terminalNotice.textContent = text;
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
      console.debug('[client] sendMouseCommand', { 
        type,
        transmitted: {
          x: payload.x,
          y: payload.y,
          b: payload.b,
          sx: payload.sx,
          sy: payload.sy,
        },
        clientLocal: {
          // isDragging, releaseReason kept local, not transmitted
        },
      });
    },
    onAfterSend: ({ type, mapped, requestId }) => {
      log(`${type} sent (${requestId}) at (${mapped.x}, ${mapped.y}) in ${mapped.sourceWidth}x${mapped.sourceHeight}.`);
    },
  });

  client.onRemoteStream = (stream) => {
      console.debug('[client] onRemoteStream', {
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

  // Resolve message retry tracking
  const resolveRetryState = {
    requestId: null,
    retryCount: 0,
    maxRetries: 3,
    retryTimeoutMs: 2000,
    retryTimer: null,
  };

  function clearResolveRetryTimer() {
    if (resolveRetryState.retryTimer) {
      clearTimeout(resolveRetryState.retryTimer);
      resolveRetryState.retryTimer = null;
    }
  }

  async function sendResolveWithRetry(daemonId, resolveMessage) {
    resolveRetryState.requestId = resolveMessage.requestId;
    resolveRetryState.retryCount = 0;

    async function attemptSend() {
      try {
        log(`Resolve send attempt ${resolveRetryState.retryCount + 1}/${resolveRetryState.maxRetries + 1} to daemon "${daemonId}"`);
        await client.sendMessage({
          type: resolveMessage.type,
          requestId: resolveMessage.requestId,
          payload: resolveMessage.payload,
        });

        // Wait for resolve_ack or timeout
        resolveRetryState.retryTimer = setTimeout(() => {
          resolveRetryState.retryTimer = null;
          if (resolveRetryState.retryCount < resolveRetryState.maxRetries) {
            resolveRetryState.retryCount++;
            console.log('[client] resolve_ack timeout, retrying...', {
              attempt: resolveRetryState.retryCount,
              maxRetries: resolveRetryState.maxRetries,
            });
            attemptSend();
          } else {
            setStatus('error', `Resolve failed: no acknowledgment from daemon after ${resolveRetryState.maxRetries + 1} attempts`);
            log(`Resolve failed: no acknowledgment after ${resolveRetryState.maxRetries + 1} attempts`);
          }
        }, resolveRetryState.retryTimeoutMs);
      } catch (error) {
        clearResolveRetryTimer();
        setStatus('error', `Resolve send failed: ${error.message}`);
        log(`Resolve send failed: ${error.message}`);
      }
    }

    await attemptSend();
  }

  client.onMessage = ({ origin, message }) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'resolve_ack') {
        if (parsed.requestId === resolveRetryState.requestId) {
          clearResolveRetryTimer();
          log(`Resolve acknowledged by daemon. Waiting for result...`);
          console.log('[client] resolve_ack received', { requestId: parsed.requestId });
        }
        return;
      }
      if (parsed.type === 'resolve_result') {
        const ok = parsed.ok !== false;
        clearResolveRetryTimer();
        setStatus(ok ? 'active' : 'error', ok ? 'Resolve processed. Daemon is starting screen share.' : `Resolve failed: ${parsed.error || 'unknown error'}`);
        log(`Resolve result: ${ok ? 'ok' : 'failed'} ${parsed.error ? `(${parsed.error})` : ''}`);
        return;
      }
      if (parsed.type === 'timeout_notice' || parsed.type === 'finish_ack') {
        const isFinish = parsed.type === 'finish_ack';
        const noticeMessage = String(parsed.message || parsed.payload?.message || (isFinish
          ? 'Session finished by daemon.'
          : 'Session timed out on daemon.')).trim();

        showTerminalNotice(isFinish ? 'active' : 'error', noticeMessage);
        setStatus(isFinish ? 'active' : 'error', noticeMessage);
        log(`${parsed.type} received: ${noticeMessage}`);

        void client.disconnect().catch(() => {});
        connected = false;
        leaveSent = false;
        updateActionRequestView();
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

  el.finishBtn.addEventListener('click', async () => {
    try {
      await sendFinishMessage('button_click');
      setStatus('connected', `Finish sent to daemon "${getActiveDaemonId()}".`);
      log(`Finish sent to daemon "${getActiveDaemonId()}".`);
    } catch (error) {
      setStatus('error', `Finish failed: ${error.message}`);
      log(`Finish failed: ${error.message}`);
    }
  });

  window.addEventListener('pagehide', async () => {
    await sendLeaveMessage('pagehide');
  });

  window.addEventListener('beforeunload', async () => {
    await sendLeaveMessage('beforeunload');
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

      await sendResolveWithRetry(daemonId, resolveMessage);
      setStatus('connecting', `Resolve sent to daemon "${daemonId}". Waiting for acknowledgment...`);
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

/* global Owt */

import { AgenticBrowserClient } from '/client-sdk/AgenticBrowserClient.js';
import { decodeMouseCommandBinary } from '/client-sdk/mouseCommandBinary.js';

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
  const params = new URLSearchParams(window.location.search);
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const uidInput = document.getElementById('uid');
  const remoteInput = document.getElementById('remote');
  const hostInput = document.getElementById('host');
  const stunUrlsInput = document.getElementById('stunUrls');
  const turnUrlsInput = document.getElementById('turnUrls');
  const turnUsernameInput = document.getElementById('turnUsername');
  const turnCredentialInput = document.getElementById('turnCredential');

  const runtimeConfig = await loadRuntimeConfig();
  const isHeadlessMode = Boolean(runtimeConfig.headless);
  let screenStream = null;
  let controlTargetMode = null;
  let agentCommandCursor = 0;
  let pollingAgentCommands = false;
  let daemonOnlineAnnounceTimer = null;
  let resolveSeen = false;
  let resolveInProgress = false;
  let pendingCalibrationRequestId = null;
  let pendingCalibrationClientId = null;
  let pendingCalibrationAttempt = 0;
  const maxCalibrationAttempts = 2;

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text;
    }
    console.log(text);
  }

  function appendMessage(message) {
    if (!messagesEl) {
      return;
    }
    messagesEl.textContent += `${message}\n`;
  }

  function normalizeIceUrlList(value) {
    if (Array.isArray(value)) {
      return value
        .flatMap((entry) => normalizeIceUrlList(entry))
        .filter(Boolean);
    }

    const text = String(value || '').trim();
    if (!text) {
      return [];
    }

    return text
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function formatIceUrls(value) {
    return normalizeIceUrlList(value).join('\n');
  }

  function readParamAny(names, fallback = '') {
    for (const name of names) {
      const value = params.get(name);
      if (value && String(value).trim()) {
        return String(value).trim();
      }
    }
    return fallback;
  }

  function applyIceConfigFromPayload(payload = {}) {
    const stunSource = payload.stunUrls ?? payload.stuneUrls;
    const turnSource = payload.turnUrls;
    const turnUsername = String(payload.turnUsername ?? payload.turnUser ?? '').trim();
    const turnCredential = String(payload.turnCredential ?? payload.turnPassword ?? '').trim();

    if (stunUrlsInput) {
      stunUrlsInput.value = formatIceUrls(stunSource);
    }
    if (turnUrlsInput) {
      turnUrlsInput.value = formatIceUrls(turnSource);
    }
    if (turnUsernameInput) {
      turnUsernameInput.value = turnUsername;
    }
    if (turnCredentialInput) {
      turnCredentialInput.value = turnCredential;
    }
  }

  async function postAgentEvent(payload) {
    try {
      await fetch('/api/v1/agent/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Keep CLI page operational even if event post fails.
    }
  }

  function estimateBytes(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(text).length;
    }
    return text.length;
  }

  async function submitLocalDaemonCommand(command) {
    const response = await fetch('/daemon-agent.command', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.message || 'Local daemon command failed.');
    }

    return payload;
  }

  async function sendPeerMessage(targetId, message, options) {
    return p2pClient.sendPeerMessage(targetId, message, options);
  }

  async function requestCalibrationFromClient(clientId, attempt, { settleDelayMs = 0 } = {}) {
    if (settleDelayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
    }

    try {
      const injectResult = await submitLocalDaemonCommand({ type: 'inject_calibration_markers', payload: {} });
      const markers = Array.isArray(injectResult?.markers) ? injectResult.markers : [];
      if (!markers.length) {
        appendMessage('Calibration skipped: no markers were injected.');
        return;
      }

      const requestId = `calib-${Date.now()}`;
      pendingCalibrationRequestId = requestId;
      pendingCalibrationClientId = clientId;
      pendingCalibrationAttempt = attempt;

      await sendPeerMessage(
        clientId,
        {
          type: 'calibrate_request',
          requestId,
          payload: { markers },
        },
        { label: 'calibrate_request' }
      );

      appendMessage(`Calibration requested from client "${clientId}" (attempt ${attempt}/${maxCalibrationAttempts}).`);
    } catch (error) {
      appendMessage(`Calibration request failed: ${error.message}`);
      pendingCalibrationRequestId = null;
      pendingCalibrationClientId = null;
      pendingCalibrationAttempt = 0;
      try {
        await submitLocalDaemonCommand({ type: 'remove_calibration_markers', payload: {} });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  async function runCalibration(clientId) {
    if (!isHeadlessMode) {
      return;
    }

    // Give the WebRTC video pipeline time to establish and render at least one real
    // frame after sharing starts (publish() completing does not mean the client has
    // received/decoded any frames yet). Without this delay the calibration round trip
    // can complete before the client's video shows anything, so injected markers are
    // never actually visible in the captured frame.
    await requestCalibrationFromClient(clientId, 1, { settleDelayMs: 800 });
  }

  async function handleCalibrationResult(incomingOrigin, command) {
    const payload = command?.payload || {};
    if (!pendingCalibrationRequestId || command.requestId !== pendingCalibrationRequestId) {
      return;
    }
    const attempt = Math.max(1, Number(pendingCalibrationAttempt || 1));
    const calibrationClientId = String(pendingCalibrationClientId || incomingOrigin || '').trim();
    pendingCalibrationRequestId = null;
    pendingCalibrationClientId = null;
    pendingCalibrationAttempt = 0;

    console.log('[daemon-cli] calibrate_result received', payload);
    let retryConfig = null;

    try {
      if (payload.ok === false || !Array.isArray(payload.correspondences) || payload.correspondences.length < 2) {
        const failureReason = payload.error || 'insufficient marker correspondences';
        if (attempt < maxCalibrationAttempts && calibrationClientId) {
          appendMessage(`Calibration attempt ${attempt}/${maxCalibrationAttempts} failed: ${failureReason}. Retrying...`);
          retryConfig = {
            clientId: calibrationClientId,
            attempt: attempt + 1,
            settleDelayMs: 300,
          };
        } else {
          appendMessage(`Calibration failed after ${attempt} attempt(s): ${failureReason}`);
        }
      } else {
        appendMessage(`Calibration correspondences: ${JSON.stringify(payload.correspondences)}`);

        const result = await submitLocalDaemonCommand({
          type: 'set_calibration',
          payload: {
            correspondences: payload.correspondences,
            sourceWidth: payload.sourceWidth,
            sourceHeight: payload.sourceHeight,
          },
        });

        appendMessage(result?.ok ? 'Calibration applied successfully.' : `Calibration rejected: ${result?.message || ''}`);
      }
    } catch (error) {
      appendMessage(`Calibration apply failed: ${error.message}`);
    } finally {
      try {
        await submitLocalDaemonCommand({ type: 'remove_calibration_markers', payload: {} });
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (retryConfig) {
      await requestCalibrationFromClient(retryConfig.clientId, retryConfig.attempt, {
        settleDelayMs: retryConfig.settleDelayMs,
      });
    }
  }

  function stopDaemonOnlineAnnouncements() {
    if (daemonOnlineAnnounceTimer) {
      window.clearInterval(daemonOnlineAnnounceTimer);
      daemonOnlineAnnounceTimer = null;
    }
  }

  async function announceDaemonOnline(reason = 'interval') {
    if (resolveSeen || !p2pClient.isConnected()) {
      return;
    }

    const daemonId = String(uidInput?.value || '').trim();
    const clientId = String(remoteInput?.value || '').trim();
    const signalingServer = String(hostInput?.value || '').trim();
    if (!daemonId || !clientId || !signalingServer) {
      return;
    }

    const timeoutMs = Number(runtimeConfig?.clientMessageTimeoutMs) || 0;

    await sendPeerMessage(
      clientId,
      {
        type: 'daemon_online',
        requestId: `daemon-online-${Date.now()}`,
        payload: {
          daemonId,
          clientId,
          signalingServer,
          reason,
          timeoutMs,
        },
      },
      { label: 'daemon_online' }
    );

    appendMessage(`daemon_online sent to ${clientId} (${reason})`);
  }

  function startDaemonOnlineAnnouncements() {
    stopDaemonOnlineAnnouncements();
    resolveSeen = false;

    daemonOnlineAnnounceTimer = window.setInterval(() => {
      announceDaemonOnline('interval').catch((error) => {
        appendMessage(`daemon_online send failed (interval): ${error?.message || 'unknown error'}`);
      });
    }, 1000);

    announceDaemonOnline('connected').catch((error) => {
      appendMessage(`daemon_online send failed (connected): ${error?.message || 'unknown error'}`);
    });
  }

  function decodeIncomingMessage(rawMessage) {
    if (rawMessage && typeof rawMessage === 'object') {
      if (Object.prototype.hasOwnProperty.call(rawMessage, 'message')) {
        return decodeIncomingMessage(rawMessage.message);
      }
      if (Object.prototype.hasOwnProperty.call(rawMessage, 'data')) {
        return decodeIncomingMessage(rawMessage.data);
      }

      if (typeof rawMessage.type === 'string') {
        return rawMessage;
      }

      if (ArrayBuffer.isView(rawMessage)) {
        const view = rawMessage;
        const sliced = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        const decoded = decodeMouseCommandBinary(sliced);
        if (!decoded) {
          throw new Error('Failed to decode binary message from typed array');
        }
        const { commandType, ...fields } = decoded;
        return { type: commandType, payload: fields };
      }
    }

    if (typeof rawMessage === 'string') {
      const parsed = JSON.parse(rawMessage);
      if (parsed.__isBinary && typeof parsed.payload === 'string') {
        const base64Data = parsed.payload;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let index = 0; index < binaryString.length; index += 1) {
          bytes[index] = binaryString.charCodeAt(index);
        }
        const decoded = decodeMouseCommandBinary(bytes.buffer);
        if (!decoded) {
          throw new Error('Failed to decode binary message');
        }
        const { commandType, ...fields } = decoded;
        return { type: commandType, payload: fields };
      }
      return parsed;
    }

    if (rawMessage instanceof ArrayBuffer) {
      const decoded = decodeMouseCommandBinary(rawMessage);
      if (!decoded) {
        throw new Error('Failed to decode binary message');
      }
      const { commandType, ...fields } = decoded;
      return { type: commandType, payload: fields };
    }

    return JSON.parse(String(rawMessage || ''));
  }

  async function forwardCommandViaPuppeteer(command) {
    return submitLocalDaemonCommand({
      type: 'dispatch_target_command',
      payload: { command },
    });
  }

  function getScreenShareUnavailableReason() {
    if (!window.isSecureContext) {
      return 'Screen share requires a secure page context. Open daemon page via http://localhost or https://.';
    }
    if (!navigator.mediaDevices) {
      return 'Screen share is unavailable because navigator.mediaDevices is missing.';
    }
    if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      return 'Screen share is unavailable because getDisplayMedia is not available.';
    }
    return null;
  }

  async function connect() {
    const daemonId = String(uidInput?.value || '').trim();
    const clientId = String(remoteInput?.value || '').trim();
    const signalingHost = String(hostInput?.value || '').trim();

    return p2pClient.connect({
      signalingHost,
      clientId: daemonId,
      daemonId: clientId,
      stunUrls: stunUrlsInput?.value || '',
      turnUrls: turnUrlsInput?.value || '',
      turnUsername: turnUsernameInput?.value || '',
      turnCredential: turnCredentialInput?.value || '',
      forceReconnect: true,
    });
  }

  async function ensureConnected() {
    return p2pClient.ensureConnected();
  }

  async function shareScreen({ automated = false } = {}) {
    if (!p2pClient.getClient()) {
      setStatus('Connect first.');
      return;
    }

    const unavailableReason = getScreenShareUnavailableReason();
    if (unavailableReason) {
      setStatus(`Share error: ${unavailableReason}`);
      return;
    }

    await ensureConnected();

    if (screenStream?.mediaStream) {
      screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }

    const mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });

    const capturedVideoTrack = mediaStream.getVideoTracks()[0];
    const capturedSettings = capturedVideoTrack?.getSettings?.() || {};
    appendMessage(`getDisplayMedia captured track settings: ${JSON.stringify(capturedSettings)}`);
    if (capturedVideoTrack && 'contentHint' in capturedVideoTrack) {
      // Chrome's WebRTC encoder can persistently downscale the captured resolution under
      // its default CPU/bandwidth adaptation heuristics, which are tuned for motion video
      // (prioritizing frame rate). This was observed to lock the published stream at a much
      // lower resolution (e.g. ~800x392) regardless of the real page/window size. Setting
      // contentHint to 'detail' tells the encoder to prioritize resolution/sharpness instead,
      // which is the correct behavior for screen-sharing text/UI content.
      capturedVideoTrack.contentHint = 'detail';
    }

    screenStream = new Owt.Base.LocalStream(
      mediaStream,
      new Owt.Base.StreamSourceInfo('screen-cast', 'screen-cast')
    );

    const p2p = p2pClient.getClient();
    const publishTargetId = String(remoteInput?.value || '').trim();
    if (!publishTargetId) {
      throw new Error('clientId is required before share publish.');
    }

    await p2p.publish(publishTargetId, screenStream);

    setStatus('Screen stream published.');
    await postAgentEvent({
      kind: 'status',
      status: 'sharing',
      state: {
        automated,
        controlTargetMode,
        capturedResolution: {
          width: capturedSettings.width,
          height: capturedSettings.height,
        },
      },
    });
  }

  async function disconnect() {
    stopDaemonOnlineAnnouncements();
    resolveSeen = false;
    pollingAgentCommands = false;

    if (screenStream?.mediaStream) {
      try {
        screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      } catch {
        // Ignore stop-track errors.
      }
      screenStream = null;
    }

    await p2pClient.disconnect();

    setStatus('Disconnected.');
    await postAgentEvent({
      kind: 'status',
      status: 'disconnected',
    });
  }

  function handleTerminationMessage(type, payload) {
    const clientId = payload?.clientId || 'unknown';
    const reason = payload?.reason || 'unspecified';
    appendMessage(`${type} received from client ${clientId} (${reason})`);
    void disconnect();
    return { ok: true, message: `${type} received` };
  }

  async function handleCommand(command) {
    const { type, payload = {} } = command;

    switch (type) {
      case 'open_url':
      case 'close_page':
      case 'mouse_move':
      case 'mouse_down':
      case 'mouse_up':
      case 'mouse_click':
      case 'text_input':
      case 'key_press':
      case 'extension_ping':
        return forwardCommandViaPuppeteer(command);
      case 'leave':
      case 'finish':
      case 'timeout':
        return handleTerminationMessage(type, payload);
      default:
        return { ok: false, error: `Unsupported command type: ${type}` };
    }
  }

  async function processResolveMessage(incomingOrigin, command) {
    if (resolveInProgress) {
      return;
    }

    resolveInProgress = true;
    try {
      resolveSeen = true;
      stopDaemonOnlineAnnouncements();

      await sendPeerMessage(
        incomingOrigin,
        {
          type: 'resolve_ack',
          requestId: command.requestId,
        },
        { label: 'resolve_ack' }
      );

      controlTargetMode = 'puppeteer';
      await ensureConnected();

      try {
        await submitLocalDaemonCommand({ type: 'prepare_share_target', payload: {} });
      } catch {
        // Continue even if target preparation fails.
      }

      await shareScreen({ automated: true });
      if (!screenStream) {
        throw new Error('share failed or was cancelled by user.');
      }

      await sendPeerMessage(
        incomingOrigin,
        {
          type: 'resolve_result',
          requestId: command.requestId,
          ok: true,
          result: {
            message: 'resolve accepted; sharing started',
          },
        },
        { label: 'resolve_result success' }
      );

      postAgentEvent({
        kind: 'peer_command_result',
        requestId: command.requestId,
        type: 'resolve',
        ok: true,
        message: 'resolve accepted; sharing started',
        error: '',
        bridge: 'p2p',
      }).catch(() => {});

      void runCalibration(incomingOrigin);
    } catch (resolveError) {
      await sendPeerMessage(
        incomingOrigin,
        {
          type: 'resolve_result',
          requestId: command.requestId,
          ok: false,
          error: resolveError.message,
        },
        { label: 'resolve_result failure' }
      );

      postAgentEvent({
        kind: 'peer_command_result',
        requestId: command.requestId,
        type: 'resolve',
        ok: false,
        message: '',
        error: resolveError.message,
        bridge: 'p2p',
      }).catch(() => {});
    } finally {
      resolveInProgress = false;
    }
  }

  async function processCommandMessage(incomingOrigin, command) {
    const normalizedType = String(command?.type || '').trim().toLowerCase();

    if (normalizedType === 'resolve') {
      await processResolveMessage(incomingOrigin, command);
      return;
    }

    if (normalizedType === 'calibrate_result') {
      await handleCalibrationResult(incomingOrigin, command);
      return;
    }

    const body = await handleCommand(command);
    if (normalizedType !== 'mouse_move') {
      postAgentEvent({
        kind: 'peer_command_result',
        requestId: command.requestId,
        type: command.type,
        ok: body?.ok !== false,
        message: body?.message || '',
        error: body?.error || '',
        bridge: body?.bridge || '',
      }).catch(() => {});

      await sendPeerMessage(
        incomingOrigin,
        {
          type: 'command_result',
          requestId: command.requestId,
          ok: body.ok !== false,
          result: body,
        },
        { label: 'command_result' }
      );
    }
  }

  const p2pClient = new AgenticBrowserClient();

  p2pClient.onDisconnect = () => {
    const daemonId = String(uidInput?.value || '').trim();
    const clientId = String(remoteInput?.value || '').trim();
    const signalingServer = String(hostInput?.value || '').trim();
    setStatus('Disconnected from signaling server.');
    appendMessage(`signaling disconnected daemon=${daemonId} client=${clientId} host=${signalingServer}`);
  };

  // Serializes processing of incoming peer commands in strict arrival order. The transport's
  // 'messagereceived' dispatch does not wait for an async onMessage handler to finish before
  // firing the next one, so back-to-back commands (e.g. mouse_down immediately followed by
  // mouse_up/mouse_click) would otherwise run concurrently. Each command's processing involves
  // a variable-latency Puppeteer/CDP round trip (resolveTargetCoordinates viewport lookup, cache
  // hit vs miss), so without serialization a later command could finish before an earlier one,
  // reordering the effective button-down/up sequence and causing Puppeteer's
  // "'left' is already pressed."/"'left' is not pressed." errors. Chaining onto a single tail
  // promise guarantees command N+1 only starts once command N has fully settled.
  let inboundMessageQueue = Promise.resolve();

  async function handleIncomingPeerMessage(event) {
      const incomingOrigin = String(event?.origin || event?.from || remoteInput?.value || '').trim();
      const incomingMessage = event?.message ?? event?.data;

      appendMessage(`from ${incomingOrigin || 'unknown'}: ${estimateBytes(incomingMessage)} bytes`);
      postAgentEvent({
        kind: 'peer_message',
        origin: incomingOrigin,
        message: incomingMessage,
      }).catch(() => {});

      try {
        const command = decodeIncomingMessage(incomingMessage);
        await processCommandMessage(incomingOrigin, command);
      } catch (error) {
        postAgentEvent({
          kind: 'peer_command_result',
          ok: false,
          error: error.message,
        }).catch(() => {});
        try {
          await sendPeerMessage(
            incomingOrigin,
            {
              type: 'command_result',
              ok: false,
              error: error.message,
            },
            { label: 'command_result error fallback' }
          );
        } catch {
          // Ignore fallback send errors.
        }
      }
  }

  p2pClient.onMessage = (event) => {
    inboundMessageQueue = inboundMessageQueue
      .then(() => handleIncomingPeerMessage(event))
      .catch((error) => {
        appendMessage(`[queue] unhandled error processing peer message: ${error?.message || error}`);
      });
    return inboundMessageQueue;
  };

  p2pClient.onSignalingConnected = async ({ host }) => {
    const daemonId = String(uidInput?.value || '').trim();
    const clientId = String(remoteInput?.value || '').trim();
    const signalingServer = String(host || hostInput?.value || '').trim();
    const allowedRemoteIds = p2pClient.getAllowedRemoteIds();
    setStatus(`Connected as ${daemonId}. Waiting for ${clientId} messages.`);
    appendMessage(`connected to signaling: daemon=${daemonId} client=${clientId} host=${signalingServer}`);
    await postAgentEvent({
      kind: 'status',
      status: 'connected',
      state: {
        daemonId,
        clientId,
        signalingServer,
        allowedRemoteIds,
      },
    });
    startDaemonOnlineAnnouncements();
  };

  p2pClient.onReconnectAttempt = () => {
    appendMessage('ensureConnected: stale signaling session detected, reconnecting.');
  };

  p2pClient.onRetrySend = ({ label, errorMessage }) => {
    appendMessage(`[data-channel] retrying ${label}: ${errorMessage}`);
  };

  async function executeAgentCommand(command) {
    const type = String(command?.type || '');
    const payload = command?.payload || {};

    switch (type) {
      case 'set_session': {
        if (typeof payload.daemonId === 'string' && payload.daemonId.trim()) {
          uidInput.value = payload.daemonId.trim();
        }
        if (typeof payload.clientId === 'string' && payload.clientId.trim()) {
          remoteInput.value = payload.clientId.trim();
        }
        if (typeof payload.signalingServer === 'string' && payload.signalingServer.trim()) {
          hostInput.value = payload.signalingServer.trim();
        }
        applyIceConfigFromPayload(payload);
        return { ok: true, message: 'session updated' };
      }
      case 'open_target': {
        const selectedTargetUrl = payload.url || '/target-demo.html';
        const result = await submitLocalDaemonCommand({
          type: 'open_target_page',
          payload: {
            url: selectedTargetUrl,
          },
        });
        return result;
      }
      case 'close_target': {
        return submitLocalDaemonCommand({ type: 'close_target_page', payload: {} });
      }
      case 'connect_only': {
        if (typeof payload.daemonId === 'string' && payload.daemonId.trim()) {
          uidInput.value = payload.daemonId.trim();
        }
        if (typeof payload.clientId === 'string' && payload.clientId.trim()) {
          remoteInput.value = payload.clientId.trim();
        }
        if (typeof payload.signalingServer === 'string' && payload.signalingServer.trim()) {
          hostInput.value = payload.signalingServer.trim();
        }
        applyIceConfigFromPayload(payload);

        resolveSeen = false;
        await connect();

        return { ok: true, message: 'connected to signaling and waiting for resolve' };
      }
      case 'connect_share': {
        if (typeof payload.daemonId === 'string' && payload.daemonId.trim()) {
          uidInput.value = payload.daemonId.trim();
        }
        if (typeof payload.clientId === 'string' && payload.clientId.trim()) {
          remoteInput.value = payload.clientId.trim();
        }
        if (typeof payload.signalingServer === 'string' && payload.signalingServer.trim()) {
          hostInput.value = payload.signalingServer.trim();
        }
        applyIceConfigFromPayload(payload);

        await ensureConnected();
        await shareScreen({ automated: Boolean(payload.automated) });
        if (!screenStream) {
          return { ok: false, error: 'share failed or was cancelled by user.' };
        }
        return { ok: true, message: 'connect and share completed' };
      }
      case 'disconnect': {
        await disconnect();
        return { ok: true, message: 'disconnected' };
      }
      case 'send_peer_notice': {
        if (typeof payload.clientId === 'string' && payload.clientId.trim()) {
          remoteInput.value = payload.clientId.trim();
        }

        await ensureConnected();
        const targetId = String(payload.targetId || remoteInput.value || '').trim();
        if (!targetId) {
          return { ok: false, error: 'target client id is required for send_peer_notice' };
        }

        const noticeType = String(payload.type || 'notice').trim();
        const requestId = String(payload.requestId || `${noticeType}-${Date.now()}`).trim();
        const message = String(payload.message || '').trim();
        const noticePayload = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};

        await sendPeerMessage(
          targetId,
          {
            type: noticeType,
            requestId,
            message,
            payload: noticePayload,
          },
          { label: `peer_notice:${noticeType}` }
        );

        return { ok: true, message: `peer notice sent: ${noticeType}`, bridge: 'p2p' };
      }
      default:
        return { ok: false, error: `Unsupported agent command: ${type}` };
    }
  }

  async function pollAgentCommands() {
    if (pollingAgentCommands) {
      return;
    }

    pollingAgentCommands = true;
    try {
      const response = await fetch(`/api/v1/agent/commands?after=${encodeURIComponent(agentCommandCursor)}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        return;
      }

      const body = await response.json();
      const commands = Array.isArray(body.commands) ? body.commands : [];
      for (const command of commands) {
        try {
          const result = await executeAgentCommand(command);
          await postAgentEvent({
            kind: 'command_result',
            commandId: command.id,
            type: command.type,
            ok: result?.ok !== false,
            message: result?.message || '',
            error: result?.error || '',
          });
        } catch (error) {
          await postAgentEvent({
            kind: 'command_result',
            commandId: command.id,
            type: command.type,
            ok: false,
            error: error.message,
          });
        }
      }

      if (typeof body.cursor === 'number') {
        agentCommandCursor = body.cursor;
      } else if (commands.length) {
        agentCommandCursor = commands[commands.length - 1].id;
      }
    } catch {
      // Ignore polling errors.
    } finally {
      pollingAgentCommands = false;
    }
  }

  uidInput.value = params.get('uid') || runtimeConfig.daemonId || uidInput.value;
  remoteInput.value = params.get('remote') || runtimeConfig.clientId || remoteInput.value;
  hostInput.value = params.get('host') || runtimeConfig.signalingServer || hostInput.value;
  applyIceConfigFromPayload({
    stunUrls: readParamAny(['stunUrls', 'STUN_SERVER_URLS'], runtimeConfig.stunUrls ?? runtimeConfig.stuneUrls),
    turnUrls: readParamAny(['turnUrls', 'TURN_SERVER_URLS'], runtimeConfig.turnUrls),
    turnUsername: readParamAny(['turnUsername', 'turnUserName', 'turnUser', 'TURN_USERNAME'], runtimeConfig.turnUsername),
    turnCredential: readParamAny(['turnCredential', 'turnPassword', 'TURN_CREDENTIAL', 'TURN_PASSWORD'], runtimeConfig.turnCredential ?? runtimeConfig.turnPassword),
  });

  window.setInterval(() => {
    postAgentEvent({
      kind: 'heartbeat',
      state: {
        daemonId: String(uidInput?.value || '').trim(),
        clientId: String(remoteInput?.value || '').trim(),
        signalingServer: String(hostInput?.value || '').trim(),
        connected: p2pClient.isConnected(),
        sharing: Boolean(screenStream),
        controlTargetMode,
      },
    }).catch(() => {});
  }, 3000);

  window.setInterval(() => {
    pollAgentCommands().catch(() => {});
  }, 1000);
  pollAgentCommands().catch(() => {});

  setStatus('Waiting for CLI commands...');
})();

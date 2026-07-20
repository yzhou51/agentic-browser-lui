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
  console.debug('[daemon-agent] script init');

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
  const shareBtn = document.getElementById('share');
  const runtimeConfig = await loadRuntimeConfig();
  let currentTargetUrl = '/target-demo.html';

  function getTargetUrl() {
    return currentTargetUrl;
  }

  function isRemoteDevtoolsMode() {
    const runtimeMode = String(runtimeConfig?.runtimeMode || '').trim().toLowerCase();
    const browserConnectionMode = String(runtimeConfig?.browserConnectionMode || '').trim().toLowerCase();
    return runtimeMode === 'remote-devtools' || browserConnectionMode === 'attached';
  }

  function setTargetUrl(url) {
    const normalized = normalizeTargetUrl(url);
    currentTargetUrl = normalized;
    return normalized;
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

  uidInput.value = params.get('uid') || runtimeConfig.daemonId || uidInput.value;
  remoteInput.value = params.get('remote') || runtimeConfig.clientId || remoteInput.value;
  hostInput.value = params.get('host') || runtimeConfig.signalingServer || hostInput.value;
  applyIceConfigFromPayload({
    stunUrls: readParamAny(['stunUrls', 'STUN_SERVER_URLS'], runtimeConfig.stunUrls ?? runtimeConfig.stuneUrls),
    turnUrls: readParamAny(['turnUrls', 'TURN_SERVER_URLS'], runtimeConfig.turnUrls),
    turnUsername: readParamAny(['turnUsername', 'turnUserName', 'turnUser', 'TURN_USERNAME'], runtimeConfig.turnUsername),
    turnCredential: readParamAny(['turnCredential', 'turnPassword', 'TURN_CREDENTIAL', 'TURN_PASSWORD'], runtimeConfig.turnCredential ?? runtimeConfig.turnPassword),
  });

  let screenStream = null;
  let controlTargetMode = null;
  let agentCommandCursor = 0;
  let pollingAgentCommands = false;
  let daemonOnlineAnnounceTimer = null;
  let resolveSeen = false;
  let resolveInProgress = false;

  function setStatus(text) {
    statusEl.textContent = text;
    console.log(text);
  }

  function appendMessage(message) {
    messagesEl.textContent += `${message}\n`;
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
      // Ignore event-post failures and keep daemon-agent operational.
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

  async function sendPeerMessageWithMetrics(targetId, message, options) {
    return p2pClient.sendPeerMessage(targetId, message, options);
  }

  function stopDaemonOnlineAnnouncements() {
    if (daemonOnlineAnnounceTimer) {
      window.clearInterval(daemonOnlineAnnounceTimer);
      daemonOnlineAnnounceTimer = null;
    }
  }

  async function announceDaemonOnline(reason = 'interval') {
    if (resolveSeen || !p2pClient.isConnected()) {
      console.debug('[daemon-agent] daemon_online skipped', {
        reason,
        resolveSeen,
        connected: p2pClient.isConnected(),
      });
      return;
    }

    const daemonId = uidInput.value.trim();
    const clientId = remoteInput.value.trim();
    const signalingServer = hostInput.value.trim();
    if (!daemonId || !clientId || !signalingServer) {
      console.debug('[daemon-agent] daemon_online skipped due to missing session fields', {
        reason,
        daemonId,
        clientId,
        signalingServer,
      });
      return;
    }

    try {
      await sendPeerMessageWithMetrics(
        clientId,
        {
          type: 'daemon_online',
          requestId: `daemon-online-${Date.now()}`,
          payload: {
            daemonId,
            clientId,
            signalingServer,
            reason,
          },
        },
        { label: 'daemon_online' }
      );
      console.debug('[daemon-agent] daemon_online sent', {
        reason,
        daemonId,
        clientId,
        signalingServer,
      });
      appendMessage(`daemon_online sent to ${clientId} (${reason})`);
    } catch (error) {
      console.warn('[daemon-agent] daemon_online send failed', {
        reason,
        daemonId,
        clientId,
        signalingServer,
        error: error?.message,
      });
      appendMessage(`daemon_online send failed (${reason}): ${error?.message || 'unknown error'}`);
    }
  }

  function startDaemonOnlineAnnouncements() {
    //stopDaemonOnlineAnnouncements();
    resolveSeen = false;

    daemonOnlineAnnounceTimer = window.setInterval(() => {
      announceDaemonOnline('interval').catch(() => {});
    }, 1000);

    announceDaemonOnline('connected').catch(() => {});
  }

  function buildPuppeteerOnlyFailure(command, error) {
    const type = String(command?.type || 'unknown');
    return {
      ok: false,
      bridge: 'puppeteer',
      error: `Puppeteer ${type} failed: ${error?.message || 'unknown error'}`,
    };
  }

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

  // Pipeline stage: decode received raw message into a normalized command object.
  // Binary ArrayBuffer → decoded fields wrapped in { type, payload } envelope.
  // Base64-encoded binary with __isBinary marker → decoded back to ArrayBuffer then to command.
  // JSON string       → parsed as-is (already has { type, requestId, payload } shape).
  // All paths produce the same envelope so all downstream handling is uniform.
  function decodeIncomingMessage(rawMessage) {
    if (rawMessage && typeof rawMessage === 'object') {
      // Some OWT stacks wrap actual payload under message/data.
      if (Object.prototype.hasOwnProperty.call(rawMessage, 'message')) {
        return decodeIncomingMessage(rawMessage.message);
      }
      if (Object.prototype.hasOwnProperty.call(rawMessage, 'data')) {
        return decodeIncomingMessage(rawMessage.data);
      }

      // Some OWT builds deliver already-parsed objects.
      if (typeof rawMessage.type === 'string') {
        return rawMessage;
      }

      // Typed array / DataView payloads should be treated as binary.
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
      // Check for base64-encoded binary marker
      if (parsed.__isBinary && typeof parsed.payload === 'string') {
        const base64Data = parsed.payload;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const arrayBuffer = bytes.buffer;
        const decoded = decodeMouseCommandBinary(arrayBuffer);
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

  function getSharedTrackLabel(mediaStream) {
    const track = mediaStream?.getVideoTracks?.()[0];
    return String(track?.label || '').trim();
  }

  function looksLikeCorrectSharedTarget(sharedTrackLabel) {
    if (!sharedTrackLabel) {
      return true;
    }

    if (controlTargetMode === 'puppeteer') {
      return true;
    }

    const targetUrl = getTargetUrl();
    if (targetUrl) {
      return sharedTrackLabel.includes(targetUrl) || targetUrl.includes(sharedTrackLabel);
    }

    return true;
  }

  async function forwardCommandViaPuppeteer(command) {
    return submitLocalDaemonCommand({
      type: 'dispatch_target_command',
      payload: { command },
    });
  }

  async function processResolveMessage(incomingOrigin, command) {
    if (resolveInProgress) {
      appendMessage(`resolve ignored while previous resolve is still in progress (${command.requestId || 'n/a'})`);
      return;
    }

    resolveInProgress = true;
    try {
      resolveSeen = true;
      stopDaemonOnlineAnnouncements();
      console.log('[daemon-agent] resolve message received', {
        origin: incomingOrigin,
        requestId: command.requestId,
        payload: command.payload || {},
      });
      appendMessage(`resolve received from ${incomingOrigin || 'unknown'} (${command.requestId || 'n/a'})`);

      await sendPeerMessageWithMetrics(
        incomingOrigin,
        {
          type: 'resolve_ack',
          requestId: command.requestId,
        },
        { label: 'resolve_ack' }
      );

      controlTargetMode = 'puppeteer';
      await p2pClient.ensureConnected();

      try {
        window.focus();
        console.debug('[daemon-agent] resolve requested window focus before capture');
      } catch (focusError) {
        console.warn('[daemon-agent] resolve window focus failed', {
          requestId: command.requestId,
          error: focusError.message,
        });
      }

      let preparedTarget = null;
      try {
        preparedTarget = await submitLocalDaemonCommand({ type: 'prepare_share_target', payload: {} });
        console.debug('[daemon-agent] prepared share target before capture', preparedTarget);
        appendMessage(`share target prepared: ${JSON.stringify(preparedTarget)}`);
      } catch (prepareError) {
        console.warn('[daemon-agent] prepare share target failed', {
          requestId: command.requestId,
          error: prepareError.message,
        });
        appendMessage(`prepare share target failed: ${prepareError.message}`);
      }

      await shareScreen({
        automated: true,
        targetHints: {
          targetUrl: String(preparedTarget?.targetPage?.url || ''),
        },
      });
      if (!screenStream) {
        throw new Error('share failed or was cancelled by user.');
      }

      await sendPeerMessageWithMetrics(
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
        bridge: 'signaling',
      }).catch(() => {});
    } catch (resolveError) {
      console.error('[daemon-agent] resolve processing failed', {
        requestId: command.requestId,
        error: resolveError.message,
      });
      appendMessage(`resolve failed: ${resolveError.message}`);

      await sendPeerMessageWithMetrics(
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
        bridge: 'signaling',
      }).catch(() => {});
    } finally {
      resolveInProgress = false;
    }
  }

  const p2pClient = new AgenticBrowserClient();

  p2pClient.onDisconnect = () => {
    const daemonId = uidInput.value.trim();
    const clientId = remoteInput.value.trim();
    const signalingServer = hostInput.value.trim();
    console.log('[daemon-agent] signaling server disconnected', { daemonId, remoteId: clientId, signalingHost: signalingServer });
    setStatus('Disconnected from signaling server.');
    appendMessage('signaling server disconnected');
  };

  // Serializes processing of incoming peer commands in strict arrival order. See the matching
  // comment in daemon-cli.js for the full rationale: without this, concurrently-processed
  // commands with variable-latency Puppeteer/CDP round trips can complete out of arrival order,
  // causing Puppeteer's "'left' is already pressed."/"'left' is not pressed." errors on rapid
  // mouse_down/mouse_up/mouse_click sequences.
  let inboundMessageQueue = Promise.resolve();

  async function handleIncomingPeerMessage(e) {
      const incomingOrigin = String(e?.origin || e?.from || remoteInput.value || '').trim();
      const incomingMessage = e?.message ?? e?.data;

      console.debug('[daemon-agent] message received', {
        origin: incomingOrigin,
        bytes: estimateBytes(incomingMessage),
      });
      appendMessage(`from ${incomingOrigin || 'unknown'}: ${estimateBytes(incomingMessage)} bytes`);
      postAgentEvent({
        kind: 'peer_message',
        origin: incomingOrigin,
        message: incomingMessage,
      }).catch(() => {});

      try {
        // Pipeline stage: receive → decode → command object
        const command = decodeIncomingMessage(incomingMessage);
        const normalizedType = String(command?.type || '').trim().toLowerCase();
        console.log('[daemon-agent] decoded peer message', {
          origin: incomingOrigin,
          normalizedType,
          requestId: command?.requestId || '',
        });

        if (normalizedType === 'resolve' || normalizedType === 'resolve-act') {
          await processResolveMessage(incomingOrigin, command);
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
          console.debug('[daemon-agent] command processed', {
            requestId: command.requestId,
            type: command.type,
            body,
          });
          console.debug(
            `[daemon-agent] command summary requestId=${command.requestId || 'n/a'} type=${command.type || 'unknown'} ok=${body?.ok !== false} ` +
            `message=${body?.message || ''} error=${body?.error || ''} bridge=${body?.bridge || ''}`
          );
        }
        if (normalizedType !== 'mouse_move') {
          await sendPeerMessageWithMetrics(
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
      } catch (error) {
        console.error('[daemon-agent] message decode/handle failed', {
          origin: e?.origin || '',
          rawType: typeof e?.message,
          isArrayBuffer: e?.message instanceof ArrayBuffer,
          error: error?.message,
        });
        appendMessage(`command error: ${error.message}`);
        postAgentEvent({
          kind: 'peer_command_result',
          ok: false,
          error: error.message,
        }).catch(() => {});
        try {
          await sendPeerMessageWithMetrics(
            incomingOrigin,
            {
              type: 'command_result',
              ok: false,
              error: error.message,
            },
            { label: 'command_result error fallback' }
          );
        } catch {
          // Ignore secondary send failures.
        }
      }
  }

  p2pClient.onMessage = (e) => {
    inboundMessageQueue = inboundMessageQueue
      .then(() => handleIncomingPeerMessage(e))
      .catch((error) => {
        appendMessage(`[queue] unhandled error processing peer message: ${error?.message || error}`);
      });
    return inboundMessageQueue;
  };

  p2pClient.onSignalingConnected = ({ host }) => {
    const daemonId = uidInput.value.trim();
    const clientId = remoteInput.value.trim();
    const signalingServer = String(host || hostInput.value || '').trim();
    const allowedRemoteIds = p2pClient.getAllowedRemoteIds();
    uidInput.disabled = true;
    console.log('[daemon-agent] connected to signaling server', { daemonId, remoteId: clientId, signalingHost: signalingServer, allowedRemoteIds });
    appendMessage(`connected to signaling: daemon=${daemonId} client=${clientId}`);
    setStatus(`Connected as ${daemonId}. Waiting for ${clientId} messages.`);
    postAgentEvent({
      kind: 'status',
      status: 'connected',
      state: {
        daemonId,
        clientId,
        signalingServer,
        allowedRemoteIds,
      },
    }).catch(() => {});
    startDaemonOnlineAnnouncements();
  };

  p2pClient.onReconnectAttempt = ({ connectedSession, desired, allowedRemoteIds }) => {
    console.debug('[daemon-agent] ensureConnected detected stale/mismatched session, reconnecting', {
      connectedSession,
      desired,
      allowedRemoteIds,
    });
    appendMessage('ensureConnected: stale signaling session detected, reconnecting.');
  };

  p2pClient.onRetrySend = ({ label, errorMessage }) => {
    appendMessage(`[data-channel] retrying ${label} after signaling reconnect: ${errorMessage}`);
  };


  function handleTerminationMessage(type, payload) {
    const clientId = payload?.clientId || 'unknown';
    const reason = payload?.reason || 'unspecified';
    const isTimeout = type === 'timeout';
    const message = isTimeout 
      ? `${type} from client ${clientId} (${reason})`
      : `${type} received from client ${clientId} (${reason})`;
    
    appendMessage(message);
    console.info('[daemon-agent] ' + message);
    console.info(`[daemon-agent] initiating disconnect after ${type} message`);
    
    disconnect()
      .then(() => console.debug(`[daemon-agent] disconnect completed after ${type} message`))
      .catch(err => console.debug(`[daemon-agent] disconnect failed on ${type}`, { error: err?.message }));
    
    return { ok: true, message: `${type} received` };
  }

  async function handleCommand(command) {
    const { type, payload = {} } = command;
    if (type !== 'mouse_move') {
      console.debug('[daemon-agent] handleCommand received', {
        type,
        requestId: command?.requestId,
      });
    }

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
      case 'leave':
      case 'finish':
      case 'timeout':
        if (type !== 'open_url' && type !== 'close_page' && type !== 'extension_ping' && type !== 'mouse_move') {
          console.debug(`[daemon-agent] handleCommand ${type}`, {
            requestId: command?.requestId,
          });
        }
        if (type === 'leave' || type === 'finish' || type === 'timeout') {
          return handleTerminationMessage(type, payload);
        }
        try {
          return await forwardCommandViaPuppeteer(command);
        } catch (error) {
          console.log(`[daemon-agent] puppeteer ${type} failed`, { error: error.message });
          return buildPuppeteerOnlyFailure(command, error);
        }
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

    console.log('[daemon-agent] connect() called', { daemonId, remoteId, signalingHost });
    appendMessage(`connect requested: daemon=${daemonId} client=${remoteId} signaling=${signalingHost}`);
    console.log('[daemon-agent] connect requested', { daemonId, remoteId, signalingHost });

    return p2pClient.connect({
      signalingHost,
      clientId: daemonId,
      daemonId: remoteId,
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
    console.log('[daemon-agent] shareScreen called', {
      automated,
      controlTargetMode,
      targetUrl: getTargetUrl(),
    });
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

    if (screenStream && screenStream.mediaStream) {
      screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }

    let mediaStream;
    let shareMethod = 'displaymedia';
    let manualPromptShown = false;
    if (automated && isRemoteDevtoolsMode()) {
      console.log('[daemon-agent] remote-devtools mode: using direct getDisplayMedia auto-select path');
      appendMessage('remote-devtools mode: using direct getDisplayMedia auto-select path');
    }

    try {
      if (!mediaStream && !automated) {
        manualPromptShown = true;
        setStatus('Please select the Puppeteer target tab in the browser picker to share it.');
      }

      if (!mediaStream) {
        if (automated) {
          manualPromptShown = !isRemoteDevtoolsMode();
          setStatus(isRemoteDevtoolsMode()
            ? 'Using getDisplayMedia auto-select in remote-devtools mode.'
            : 'Please select the Puppeteer target tab in the browser picker to share it.');
        }

        console.log('[daemon-agent] requesting getDisplayMedia', {
          automated,
          manualPromptShown,
          controlTargetMode,
        });
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: 'browser',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
      }
    } catch (error) {
      console.log('[daemon-agent] share capture failed', {
        automated,
        manualPromptShown,
        error: error.message,
      });
      setStatus(`Share error: ${error.message}`);
      return;
    }

    const sharedTrackLabel = getSharedTrackLabel(mediaStream);
    console.log('[daemon-agent] getDisplayMedia acquired', {
      automated,
      manualPromptShown,
      sharedTrackLabel,
      controlTargetMode,
      shareMethod,
    });
    if (!looksLikeCorrectSharedTarget(sharedTrackLabel)) {
      const expectedTarget = getTargetUrl() || 'unknown target';
      setStatus(
        `Share warning: selected stream looks like "${sharedTrackLabel}" but controlled tab is ${expectedTarget}`
      );
    }

    const capturedVideoTrack = mediaStream.getVideoTracks()[0];
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
    const publishTargetId = remoteInput.value.trim();
    const trackSummary = mediaStream.getTracks().map((track) => ({
      id: track.id,
      kind: track.kind,
      label: track.label,
      readyState: track.readyState,
      muted: track.muted,
    }));

    console.log('[daemon-agent] publishing screen stream', {
      publishTargetId,
      allowedRemoteIds: p2pClient.getAllowedRemoteIds(),
      mediaStreamId: mediaStream.id,
      trackSummary,
    });
    appendMessage(`publishing screen stream to ${publishTargetId}: ${JSON.stringify(trackSummary)}`);

    const publishTimeoutMs = 8000;
    await Promise.race([
      p2p.publish(publishTargetId, screenStream),
      new Promise((_, reject) => {
        window.setTimeout(() => {
          reject(new Error(`Timed out after ${publishTimeoutMs}ms waiting for remote peer to acknowledge published tracks.`));
        }, publishTimeoutMs);
      }),
    ]);
    console.log('[daemon-agent] screen stream publish acknowledged', {
      publishTargetId,
      mediaStreamId: mediaStream.id,
    });
    appendMessage(`screen stream publish acknowledged by ${publishTargetId}`);

    setStatus(
      sharedTrackLabel
        ? `Screen stream published via ${shareMethod} (${sharedTrackLabel}).`
        : `Screen stream published via ${shareMethod}.`
    );

    await postAgentEvent({
      kind: 'status',
      status: 'sharing',
      state: {
        automated,
        manualPromptShown,
        controlTargetMode,
        targetUrl: getTargetUrl(),
        sharedTrackLabel,
        shareMethod,
      },
    });
  }

  const initialScreenShareReason = getScreenShareUnavailableReason();
  if (initialScreenShareReason) {
    shareBtn.title = initialScreenShareReason;
    setStatus(`Share unavailable: ${initialScreenShareReason}`);
  }

  async function disconnect() {
    console.log('[daemon-agent] disconnect() starting');
    stopDaemonOnlineAnnouncements();
    resolveSeen = false;
    
    // Stop polling agent commands first
    pollingAgentCommands = false;
    console.log('[daemon-agent] polling stopped');
    
    if (screenStream?.mediaStream) {
      try {
        console.log('[daemon-agent] stopping screen stream tracks');
        screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        console.log('[daemon-agent] error stopping tracks', { error: err?.message });
      }
      screenStream = null;
    }

    console.log('[daemon-agent] disconnecting from P2P');
    await p2pClient.disconnect();
    console.log('[daemon-agent] P2P disconnected');
    
    // Reset UI state
    uidInput.disabled = false;
    uidInput.placeholder = 'Enter daemon ID';
    remoteInput.disabled = false;
    remoteInput.placeholder = 'Enter client ID';
    controlTargetMode = null;
    
    setStatus('Disconnected.');
    console.log('[daemon-agent] UI reset to disconnected state');
    
    appendMessage('--- Disconnected (leave/finish/timeout) ---');
    
    await postAgentEvent({
      kind: 'status',
      status: 'disconnected',
    });
    console.log('[daemon-agent] disconnect() completed');
  }

  async function executeAgentCommand(command) {
    const type = String(command?.type || '');
    const payload = command?.payload || {};
    console.log('[daemon-agent] executeAgentCommand', { type, payload, commandId: command?.id });
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
        const selectedTargetUrl = payload.url || getTargetUrl();
        const result = await submitLocalDaemonCommand({
          type: 'open_target_page',
          payload: {
            url: selectedTargetUrl,
          },
        });
        setTargetUrl(selectedTargetUrl);
        controlTargetMode = 'puppeteer';
        return result;
      }
      case 'close_target': {
        const result = await submitLocalDaemonCommand({ type: 'close_target_page', payload: {} });
        controlTargetMode = null;
        return result;
      }
      case 'connect_share': {
        if (typeof payload.daemonId === 'string' && payload.daemonId.trim()) {
          uidInput.value = payload.daemonId.trim();
        }
        if (typeof payload.clientId === 'string' && payload.clientId.trim()) {
          remoteInput.value = payload.clientId.trim();
        }

        await ensureConnected();
        await shareScreen({ automated: Boolean(payload.automated) });
        if (!screenStream) {
          return { ok: false, error: 'share failed or was cancelled by user.' };
        }
        return { ok: true, message: 'connect and share completed' };
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

        console.log('CONNECT_ONLY_RECEIVED', {
          daemonId: uidInput.value.trim(),
          clientId: remoteInput.value.trim(),
          signalingServer: hostInput.value.trim(),
          stunUrls: normalizeIceUrlList(stunUrlsInput?.value || ''),
          turnUrls: normalizeIceUrlList(turnUrlsInput?.value || ''),
          turnUsername: String(turnUsernameInput?.value || '').trim(),
          requestId: payload.requestId || '',
          forceReconnect: Boolean(payload.forceReconnect),
        });
        appendMessage(`CONNECT_ONLY_RECEIVED daemon=${uidInput.value.trim()} client=${remoteInput.value.trim()} signaling=${hostInput.value.trim()}`);

        resolveSeen = false;

        // Re-establish signaling/P2P deterministically for connect_only,
        // matching the manual disconnect+connect flow that is stable.
        await connect();

        // In CLI-driven connect_only flow, explicitly restart daemon_online announcements
        // so the mobile side can discover daemon readiness even after reconnect/session changes.
       // startDaemonOnlineAnnouncements();

        console.log('CONNECT_ONLY_CONNECTED', {
          daemonId: uidInput.value.trim(),
          clientId: remoteInput.value.trim(),
          signalingServer: hostInput.value.trim(),
          requestId: payload.requestId || '',
        });
        appendMessage(`CONNECT_ONLY_CONNECTED daemon=${uidInput.value.trim()} client=${remoteInput.value.trim()} signaling=${hostInput.value.trim()}`);

        return { ok: true, message: 'connected to signaling and waiting for resolve' };
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

        await sendPeerMessageWithMetrics(
          targetId,
          {
            type: noticeType,
            requestId,
            message,
            payload: noticePayload,
          },
          { label: `peer_notice:${noticeType}` }
        );

        appendMessage(`peer notice sent to ${targetId}: ${noticeType} (${requestId})`);
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
      // Ignore polling errors to keep page interactive.
    } finally {
      pollingAgentCommands = false;
    }
  }

  document.getElementById('connect').addEventListener('click', () => {
    console.debug('[daemon-agent] Connect button clicked');
    setStatus('Connecting...');
    connect().catch((error) => setStatus(`Connect error: ${error.message}`));
  });

  shareBtn.addEventListener('click', () => {
    console.log('[daemon-agent] Share button clicked');
    shareScreen().catch((error) => setStatus(`Share error: ${error.message}`));
  });

  document.getElementById('disconnect').addEventListener('click', () => {
    disconnect().catch((error) => setStatus(`Disconnect error: ${error.message}`));
  });

  window.setInterval(() => {
    postAgentEvent({
      kind: 'heartbeat',
      state: {
        daemonId: uidInput.value.trim(),
        clientId: remoteInput.value.trim(),
        signalingServer: hostInput.value.trim(),
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
})();

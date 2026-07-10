/* global Owt */

import { createDaemonP2PClient } from '/daemon-src/p2pClient.browser.js';

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

  const p2pClient = createDaemonP2PClient({
    windowObject: window,
    getSessionConfig: () => ({
      daemonId: uidInput.value.trim(),
      clientId: remoteInput.value.trim(),
      signalingServer: hostInput.value.trim(),
      stunUrls: stunUrlsInput?.value || '',
      turnUrls: turnUrlsInput?.value || '',
      turnUsername: turnUsernameInput?.value || '',
      turnCredential: turnCredentialInput?.value || '',
    }),
    onServerDisconnected: ({ daemonId, clientId, signalingServer }) => {
      console.log('[daemon-agent] signaling server disconnected', { daemonId, remoteId: clientId, signalingHost: signalingServer });
      setStatus('Disconnected from signaling server.');
      appendMessage('signaling server disconnected');
    },
    onMessage: async (e) => {
      console.log('[daemon-agent] message received', {
        origin: e.origin,
        message: e.message,
      });
      appendMessage(`from ${e.origin}: ${e.message}`);
      postAgentEvent({
        kind: 'peer_message',
        origin: e.origin,
        message: e.message,
      }).catch(() => {});

      try {
        const command = JSON.parse(e.message);

        if (command?.type === 'resolve') {
          console.log('[daemon-agent] resolve message received', {
            origin: e.origin,
            requestId: command.requestId,
            payload: command.payload || {},
          });
          appendMessage(`resolve received from ${e.origin} (${command.requestId || 'n/a'})`);

          controlTargetMode = 'puppeteer';

          try {
            await p2pClient.ensureConnected();

            try {
              window.focus();
              console.log('[daemon-agent] resolve requested window focus before capture');
            } catch (focusError) {
              console.log('[daemon-agent] resolve window focus failed', {
                requestId: command.requestId,
                error: focusError.message,
              });
            }

            try {
              const preparedTarget = await submitLocalDaemonCommand({ type: 'prepare_share_target', payload: {} });
              console.log('[daemon-agent] prepared share target before capture', preparedTarget);
              appendMessage(`share target prepared: ${JSON.stringify(preparedTarget)}`);
            } catch (prepareError) {
              console.log('[daemon-agent] prepare share target failed', {
                requestId: command.requestId,
                error: prepareError.message,
              });
              appendMessage(`prepare share target failed: ${prepareError.message}`);
            }

            await shareScreen({ automated: true });
            if (!screenStream) {
              throw new Error('share failed or was cancelled by user.');
            }

            await p2pClient.sendPeerMessage(
              e.origin,
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
          } catch (resolveError) {
            console.log('[daemon-agent] resolve processing failed', {
              requestId: command.requestId,
              error: resolveError.message,
            });
            appendMessage(`resolve failed: ${resolveError.message}`);

            await p2pClient.sendPeerMessage(
              e.origin,
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
          }
          return;
        }

        const body = await handleCommand(command);
        postAgentEvent({
          kind: 'peer_command_result',
          requestId: command.requestId,
          type: command.type,
          ok: body?.ok !== false,
          message: body?.message || '',
          error: body?.error || '',
          bridge: body?.bridge || '',
        }).catch(() => {});
        console.log('[daemon-agent] command processed', {
          requestId: command.requestId,
          type: command.type,
          body,
        });
        console.log(
          `[daemon-agent] command summary requestId=${command.requestId || 'n/a'} type=${command.type || 'unknown'} ok=${body?.ok !== false} ` +
          `message=${body?.message || ''} error=${body?.error || ''} bridge=${body?.bridge || ''}`
        );
        await p2pClient.sendPeerMessage(
          e.origin,
          {
            type: 'command_result',
            requestId: command.requestId,
            ok: body.ok !== false,
            result: body,
          },
          { label: 'command_result' }
        );
      } catch (error) {
        appendMessage(`command error: ${error.message}`);
        postAgentEvent({
          kind: 'peer_command_result',
          ok: false,
          error: error.message,
        }).catch(() => {});
        try {
          await p2pClient.sendPeerMessage(
            e.origin,
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
    },
    onConnected: async ({ daemonId, clientId, signalingServer, allowedRemoteIds }) => {
      uidInput.disabled = true;
      console.log('[daemon-agent] connected to signaling server', { daemonId, remoteId: clientId, signalingHost: signalingServer, allowedRemoteIds });
      appendMessage(`connected to signaling: daemon=${daemonId} client=${clientId}`);
      setStatus(`Connected as ${daemonId}. Waiting for ${clientId} messages.`);
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
    },
    onReconnectNeeded: ({ connectedSession, desired, allowedRemoteIds }) => {
      console.log('[daemon-agent] ensureConnected detected stale/mismatched session, reconnecting', {
        connectedSession,
        desired,
        allowedRemoteIds,
      });
      appendMessage('ensureConnected: stale signaling session detected, reconnecting.');
    },
    onRetrySend: ({ label, errorMessage }) => {
      appendMessage(`[data-channel] retrying ${label} after signaling reconnect: ${errorMessage}`);
    },
  });


  async function handleCommand(command) {
    const { type, payload = {} } = command;
    console.log('[daemon-agent] handleCommand received', {
      type,
      payload,
      requestId: command?.requestId,
    });

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
        if (type !== 'open_url' && type !== 'close_page' && type !== 'extension_ping') {
          console.debug(`[daemon-agent] handleCommand ${type}`, { payload });
        }
        if (type === 'leave') {
          appendMessage(`leave received from client ${payload?.clientId || 'unknown'} (${payload?.reason || 'unspecified'})`);
          return { ok: true, message: 'leave received' };
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

    return p2pClient.connect();
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
    let manualPromptShown = false;
    try {
      if (!automated) {
        manualPromptShown = true;
        setStatus('Please select the Puppeteer target tab in the browser picker to share it.');
      }

      console.log('[daemon-agent] requesting getDisplayMedia', {
        automated,
        manualPromptShown,
        controlTargetMode,
      });
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
      });
    } catch (error) {
      console.log('[daemon-agent] getDisplayMedia failed', {
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
    });
    if (!looksLikeCorrectSharedTarget(sharedTrackLabel)) {
      const expectedTarget = getTargetUrl() || 'unknown target';
      setStatus(
        `Share warning: selected stream looks like "${sharedTrackLabel}" but controlled tab is ${expectedTarget}`
      );
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
        ? `Screen stream published (${sharedTrackLabel}).`
        : 'Screen stream published.'
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
      },
    });
  }

  const initialScreenShareReason = getScreenShareUnavailableReason();
  if (initialScreenShareReason) {
    shareBtn.title = initialScreenShareReason;
    setStatus(`Share unavailable: ${initialScreenShareReason}`);
  }

  async function disconnect() {
    if (screenStream?.mediaStream) {
      try {
        screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      } catch {
        // Ignore track stop errors during cleanup.
      }
      screenStream = null;
    }

    await p2pClient.disconnect();
    uidInput.disabled = false;
    controlTargetMode = null;
    setStatus('Disconnected.');
    await postAgentEvent({
      kind: 'status',
      status: 'disconnected',
    });
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

        if (payload.forceReconnect) {
          appendMessage('CONNECT_ONLY forceReconnect requested: resetting existing signaling/share state first.');
          await disconnect();
        }

        await ensureConnected();

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

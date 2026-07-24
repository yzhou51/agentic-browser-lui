import {
  DirectUserControlClient,
  createPeerIds,
  createViewerMouseCommandSender,
  hasAnySearchParam,
  loadClientRuntimeConfig,
  getRenderedVideoContentRect,
  readSearchParam,
  readSearchParamAny,
  readSearchPercentParam,
  summarizeIceConfigForLog,
} from './sdk/index.js';
import { normalizeRtcIceOptions, parseRtcIceServersJson } from './sdk/config/rtcConfig.js';

async function init() {
  const runtimeConfig = await loadClientRuntimeConfig('/client.runtime.json');
  const searchParams = new URLSearchParams(window.location.search);
  const ducClient = new DirectUserControlClient();
  let connected = false;
  let isMousePressed = false;
  let activePointerId = null;
  let activePointerStart = null;
  // A press is "pending" from pointerdown until we can classify it as a click (release without
  // movement -> a single mouse_click) or a drag (movement past threshold -> mouse_down + moves +
  // mouse_up). This applies to BOTH touch and mouse: sending mouse_down eagerly on pointerdown and
  // a mouse_click on the DOM click would make the daemon receive mouse_down -> mouse_up ->
  // mouse_click, i.e. it clicks the element twice and the selection toggles back off.
  let pressPending = false;
  let suppressClick = false;
  let remoteDragMoved = false;
  let keyboardFabDrag = null;
  let keyboardFabSuppressClick = false;
  let resolveSent = false;
  let resolveAcked = false;
  let resolveAttempts = 0;
  let resolveInFlight = false;
  let resolveRetryTimer = null;
  let messageChannelReady = false;
  let daemonReadyHint = false;
  let hScrollHideTimer = null;
  let hScrollDrag = null;
  let hScrollHovering = false;
  let hScrollBottomZoneActive = false;
  let vScrollHideTimer = null;
  let vScrollDrag = null;
  let vScrollHovering = false;
  let vScrollRightZoneActive = false;
  let nativeScrollbarDrag = null;
  let swipeStart = null;
  let swipeTarget = null; // 'video' or 'scrollbar'
  let touchCount = 0;
  let leaveSent = false;
  const resolveWarnThreshold = 5;
  const resolveRetryDelayMs = 2000;
  const dragMoveThrottleMs = 34;
  let pendingMoveEvent = null;
  let pendingMoveExtra = null;
  let moveFlushTimer = null;
  // Chained promise (not a boolean flag) so that flushPendingDragMove() callers -- notably
  // pointerup, which must ensure the LAST drag-move is actually sent before mouse_up -- can
  // reliably AWAIT any currently in-flight send instead of racing past it. A boolean flag would
  // let a caller observe "busy" and simply give up, leaving its own pending move to be flushed
  // later by the in-flight send's own cleanup -- which could land AFTER mouse_up was sent.
  let moveSendChain = Promise.resolve();
  const clientState = {
    owtConnecting: 'Connecting to OWT',
    owtConnected: 'Connected to OWT',
    owtDisconnected: 'Disconnected from OWT',
    daemonConnecting: 'Connecting to daemon',
    daemonConnected: 'Connected to daemon',
    daemonDisconnected: 'Disconnected from daemon',
    daemonInteraction: 'Daemon interaction',
  };

  const el = {
    finishBtn: document.getElementById('finishBtn'),
    terminalNotice: document.getElementById('terminalNotice'),
    remotePanel: document.querySelector('.mobile-remote-panel'),
    remoteVideo: document.getElementById('remoteVideo'),
    calibrationVeil: document.getElementById('calibrationVeil'),
    hScrollOverlay: document.getElementById('hScrollOverlay'),
    hScrollThumb: document.getElementById('hScrollThumb'),
    vScrollOverlay: document.getElementById('vScrollOverlay'),
    vScrollThumb: document.getElementById('vScrollThumb'),
    keyboardFab: document.getElementById('keyboardFab'),
    keyboardCapture: document.getElementById('keyboardCapture'),
    timeoutCountdown: document.getElementById('timeoutCountdown'),
  };

  function setCalibrationVeilVisible(visible) {
    if (!el.calibrationVeil) {
      return;
    }

    el.calibrationVeil.classList.toggle('is-visible', Boolean(visible));
    el.calibrationVeil.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  const viewState = {
    scalePercent: 100,
    sourceWidth: 1280,
    sourceHeight: 720,
  };

  const defaultSignalingServer = 'http://localhost:8095';
  const envSignalingServer = readSearchParam(searchParams, 'signalingUrl', 
                          runtimeConfig.signalingServer || 
                          import.meta.env?.SIGNALING_SERVER || 
                          defaultSignalingServer);
  console.log('[client] Resolved signaling server to:', envSignalingServer, '(from config:', runtimeConfig.signalingServer, ')');
  if (!runtimeConfig.signalingServer && !import.meta.env?.SIGNALING_SERVER) {
    console.warn('[client] Using default signaling server. Consider setting SIGNALING_SERVER env var or /client.runtime.json');
  }
  const sessionId = readSearchParam(searchParams, 'sessionId', runtimeConfig.sessionId || import.meta.env?.SESSION_ID || '');
  const derivedPeerIds = sessionId ? createPeerIds(sessionId) : null;
  const envClientId = readSearchParam(
    searchParams,
    'clientId',
    derivedPeerIds?.clientId || runtimeConfig.clientId || import.meta.env?.CLIENT_ID || 'client-1'
  );
  const envDaemonId = readSearchParam(
    searchParams,
    'remoteId',
    derivedPeerIds?.daemonId || runtimeConfig.daemonId || import.meta.env?.DAEMON_ID || 'daemon-1'
  );
  const paramStunUrls = readSearchParamAny(searchParams, ['stunUrls', 'STUN_SERVER_URLS'], '');
  const paramTurnUrls = readSearchParamAny(searchParams, ['turnUrls', 'TURN_SERVER_URLS'], '');
  const paramTurnUsername = readSearchParamAny(searchParams, ['turnUsername', 'turnUserName', 'turnUser', 'TURN_USERNAME'], '');
  const paramTurnCredential = readSearchParamAny(searchParams, ['turnCredential', 'turnPassword', 'TURN_CREDENTIAL', 'TURN_PASSWORD'], '');
  const hasIceUrlParams = Boolean(
    paramStunUrls ||
    paramTurnUrls ||
    paramTurnUsername ||
    paramTurnCredential
  );

  const envIceConfig = normalizeRtcIceOptions({
    ...runtimeConfig,
    stunUrls: paramStunUrls || runtimeConfig.stunUrls || runtimeConfig.stuneUrls || import.meta.env?.STUN_SERVER_URLS,
    turnUrls: paramTurnUrls || runtimeConfig.turnUrls || import.meta.env?.TURN_SERVER_URLS,
    turnUsername: paramTurnUsername || runtimeConfig.turnUsername || import.meta.env?.TURN_USERNAME,
    turnCredential: paramTurnCredential || runtimeConfig.turnCredential || runtimeConfig.turnPassword || import.meta.env?.TURN_CREDENTIAL,
    rtcIceServers: hasIceUrlParams
      ? []
      : (Array.isArray(runtimeConfig.rtcIceServers) && runtimeConfig.rtcIceServers.length
        ? runtimeConfig.rtcIceServers
        : parseRtcIceServersJson(import.meta.env?.RTC_ICE_SERVERS_JSON)),
  });
  const hasScaleParam = hasAnySearchParam(searchParams, ['scrollRate', 'viewScale', 'scale']);
  const envScale = readSearchPercentParam(searchParams, ['scrollRate', 'viewScale', 'scale'], 100);
  const envFitValue = readSearchParam(searchParams, 'fit', '').toLowerCase();
  const fitToViewport = envFitValue
    ? !(['0', 'false', 'off', 'no'].includes(envFitValue))
    : !hasScaleParam;

  if (el.remotePanel) {
    el.remotePanel.classList.toggle('fit-mode', fitToViewport);
  }

  viewState.scalePercent = envScale > 0 ? envScale : 100;

  function getClientId() {
    return String(envClientId || '').trim();
  }

  function getDaemonId() {
    return String(envDaemonId || '').trim();
  }

  async function sendLeaveMessage(reason) {
    if (leaveSent || !connected) {
      return;
    }

    const daemonId = getDaemonId();
    if (!daemonId) {
      return;
    }

    leaveSent = true;
    ducClient.setDaemonId(daemonId);
    const leaveMessage = {
      type: 'leave',
      requestId: `leave-${Date.now()}`,
      payload: {
        clientId: getClientId(),
        reason,
      },
    };

    try {
      console.log('[client] sending leave message', { reason, daemonId });
      await Promise.race([
        ducClient.sendMessage(leaveMessage, daemonId),
        new Promise(resolve => setTimeout(resolve, 500)), // Max wait 500ms
      ]);
      console.log('[client] leave message sent', { reason });
    } catch (error) {
      console.log('[client] leave message failed', { reason, error: error?.message });
    }
  }

  async function sendFinishMessage(reason = 'user_click') {
    const daemonId = getDaemonId();
    if (!daemonId) {
      throw new Error('daemon id is missing.');
    }
    if (!connected) {
      throw new Error('not connected to daemon.');
    }

    ducClient.setDaemonId(daemonId);
    await ducClient.sendMessage(
      {
        type: 'finish',
        requestId: `finish-${Date.now()}`,
        payload: {
          clientId: getClientId(),
          reason,
        },
      },
      daemonId
    );
  }

  function getSignalingUrl() {
    return String(envSignalingServer || '').trim();
  }

  function getRtcConnectOptions() {
    return envIceConfig;
  }

  function setStatus(state, message) {
    console.log(`[client] status update: state=${state} message=${message}`);
  }

  function setClientState(stateKey, message) {
    const nextState = clientState[stateKey] || stateKey;
    setStatus(nextState, message);
  }

  function showTerminalNotice(state, message) {
    if (!el.terminalNotice) {
      return;
    }

    const text = String(message || '').trim();
    if (!text) {
      el.terminalNotice.classList.remove('is-visible');
      el.terminalNotice.dataset.state = 'idle';
      el.terminalNotice.textContent = '';
      return;
    }

    el.terminalNotice.dataset.state = state;
    el.terminalNotice.textContent = text;
    el.terminalNotice.classList.add('is-visible');
  }

  // --- Session inactivity countdown ----------------------------------------
  // The daemon enforces a client-message timeout: if it receives no peer
  // message from this client within its configured window, it snapshots and
  // terminates the session. The daemon resets that timer on every peer message
  // it receives from us, so we mirror it here -- the countdown is reset on each
  // operation we send -- to show the user how long they have left to act.
  let sessionTimeoutMs = 0;
  let countdownDeadline = 0;
  let countdownTimer = null;

  function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function renderCountdown(state) {
    if (!el.timeoutCountdown) {
      return;
    }
    if (!sessionTimeoutMs) {
      el.timeoutCountdown.hidden = true;
      return;
    }
    const remaining = Math.max(0, countdownDeadline - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    if (!state) {
      if (totalSeconds <= 10) {
        state = 'urgent';
      } else if (totalSeconds <= 30) {
        state = 'warn';
      }
    }
    el.timeoutCountdown.hidden = false;
    el.timeoutCountdown.dataset.state = state;
    el.timeoutCountdown.textContent = `Time left: ${formatCountdown(remaining)}`;
  }

  function stopSessionCountdown() {
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }

    countdownDeadline = 0;
    renderCountdown('ok');
    //if (el.timeoutCountdown) {
    //  el.timeoutCountdown.hidden = true;
    //  el.timeoutCountdown.dataset.state = 'idle';
    //  el.timeoutCountdown.textContent = '';
   // }
  }

  // Show a little less than the true daemon timeout so the countdown reaches
  // zero slightly before the daemon actually fires -- giving the user a safety
  // buffer rather than promising time that is already gone.
  const COUNTDOWN_BUFFER_MS = 15000;

  function startSessionCountdown(timeoutMs) {
    const rawMs = Number(timeoutMs);
    if (!Number.isFinite(rawMs) || rawMs <= 0) {
      log(`[client] countdown not started: invalid timeoutMs ${timeoutMs}`);
      return;
    }

    // Never drop below a small positive window, even for very short timeouts.
    const ms = Math.max(1000, rawMs - COUNTDOWN_BUFFER_MS);

    sessionTimeoutMs = ms;
    countdownDeadline = Date.now() + ms;
    if (!countdownTimer) {
      countdownTimer = window.setInterval(renderCountdown, 500);
    }
    renderCountdown();
  }

  function clearResolveRetryTimer() {
    if (resolveRetryTimer) {
      window.clearTimeout(resolveRetryTimer);
      resolveRetryTimer = null;
    }
  }

  async function sendResolve(reason = 'unspecified') {
    if (!connected || resolveSent || resolveAcked || resolveInFlight) {
      return;
    }

    resolveInFlight = true;
    resolveAttempts += 1;
    const resolveMessage = {
      type: 'resolve',
      requestId: `resolve-${Date.now()}-${resolveAttempts}`,
      payload: {
        clientId: getClientId(),
      },
    };

    setClientState('daemonConnecting', `Sending Resolve to daemon "${getDaemonId()}" (attempt ${resolveAttempts})...`);
    log(`Resolve send requested (${reason}) attempt ${resolveAttempts}: ${JSON.stringify(resolveMessage)}`);

    void ducClient.sendMessage(resolveMessage)
      .then(() => {
        setClientState('daemonConnecting', `Resolve sent to daemon "${getDaemonId()}". Waiting for response...`);
        log(`Resolve sent to daemon "${getDaemonId()}".`);
      })
      .catch((error) => {
        log(`Resolve send failed: ${error.message}`);
        console.warn('[client] Resolve send failed', {
          reason,
          attempt: resolveAttempts,
          error: error?.message,
        });
      });

    if (!resolveSent && !resolveAcked && connected) {
      if (resolveAttempts === resolveWarnThreshold) {
        log(`Resolve not acknowledged after ${resolveWarnThreshold} attempts. Keep retrying until daemon is ready.`);
      }
      clearResolveRetryTimer();
      resolveRetryTimer = window.setTimeout(() => {
        // Allow the next attempt (either this retry, or a fresh daemon_online broadcast)
        // to proceed once the previous attempt's ack window has elapsed.
        resolveInFlight = false;
        void sendResolve('retry-timer');
      }, resolveRetryDelayMs);
    } else {
      resolveInFlight = false;
    }
  }

  function log(message) {
    console.log(message);
  }

  // Debug aid for diagnosing the capture-to-content crop: saves the EXACT frame used for
  // calibration marker detection as a downloaded PNG, so it can be visually inspected (e.g. to
  // check whether Chrome's own title bar/tab strip/address bar are baked into the captured
  // content, which would confirm the "window chrome included in capture" cropping hypothesis).
  function saveDebugCalibrationFrame(canvas) {
    try {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `calibration-frame-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      log(`[DEBUG] Saved calibration frame snapshot (${canvas.width}x${canvas.height}) as ${link.download}`);
    } catch (error) {
      log(`[DEBUG] Failed to save calibration frame snapshot: ${error.message}`);
    }
  }

  async function detectCalibrationMarkers(markers, { saveDebugFrame = false } = {}) {
    const video = el.remoteVideo;
    if (!video || !video.videoWidth || !video.videoHeight) {
      return { ok: false, error: 'remote video is not ready for calibration.' };
    }
    if (!Array.isArray(markers) || !markers.length) {
      return { ok: false, error: 'no calibration markers provided.' };
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return { ok: false, error: 'canvas 2d context unavailable.' };
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (saveDebugFrame) {
      saveDebugCalibrationFrame(canvas);
    }

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (error) {
      return { ok: false, error: `getImageData failed: ${error.message}` };
    }

    const { data, width, height } = imageData;
    const tolerance = 40;
    const correspondences = [];
    const missing = [];

    for (const marker of markers) {
      const target = Array.isArray(marker.color) ? marker.color : [255, 0, 255];
      let sumX = 0;
      let sumY = 0;
      let count = 0;

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = (y * width + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          if (
            Math.abs(r - target[0]) <= tolerance &&
            Math.abs(g - target[1]) <= tolerance &&
            Math.abs(b - target[2]) <= tolerance
          ) {
            sumX += x;
            sumY += y;
            count += 1;
          }
        }
      }

      // Don't fail immediately just because one marker in the grid wasn't found -- with a 3x3
      // grid spread across the page, it's expected that some markers may fall outside whatever
      // region actually survives capture/crop/occlusion on a given page. As long as at least 2
      // markers ARE found (checked after this loop), that's enough for a linear calibration fit.
      if (count < 10) {
        missing.push(marker.id || 'unknown');
        continue;
      }

      correspondences.push({
        id: marker.id,
        domX: Number(marker.domX || 0),
        domY: Number(marker.domY || 0),
        videoX: sumX / count,
        videoY: sumY / count,
      });
    }

    if (correspondences.length < 2) {
      return {
        ok: false,
        error: `only ${correspondences.length}/${markers.length} calibration marker(s) detected (missing: ${missing.join(', ') || 'none'}).`,
      };
    }

    return {
      ok: true,
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
      correspondences,
    };
  }

  async function flushPendingDragMove() {
    // Chain onto any currently in-flight/pending send instead of a boolean "busy" check, so a
    // caller that awaits this (like pointerup, which must guarantee the final drag-move is sent
    // BEFORE mouse_up) reliably waits for everything already queued/sending to actually finish,
    // rather than observing "busy" and returning immediately while a send is still in flight.
    moveSendChain = moveSendChain.then(async () => {
      if (!pendingMoveEvent) {
        return;
      }

      const eventToSend = pendingMoveEvent;
      const extraToSend = pendingMoveExtra || { isDragging: true };
      pendingMoveEvent = null;
      pendingMoveExtra = null;

      try {
        log(`[DRAG] Flushing: (${eventToSend.clientX}, ${eventToSend.clientY}), extra=${JSON.stringify(extraToSend)}`);
        await sendMappedMouseCommand('mouse_move', eventToSend, extraToSend);
      } catch (err) {
        log(`[DRAG] Error flushing: ${err.message}`);
        // Keep drag move lightweight.
      }
    }).catch((err) => {
      log(`[DRAG] Unexpected error in move send chain: ${err.message}`);
    });

    await moveSendChain;

    // A new move may have been queued by the time our link ran (e.g. a pointermove fired while
    // we were awaiting the chain). Schedule another throttled flush for it rather than losing it.
    if (pendingMoveEvent && !moveFlushTimer) {
      log(`[DRAG] Another event queued, scheduling flush`);
      scheduleDragMoveFlush();
    }
  }

  function scheduleDragMoveFlush() {
    if (moveFlushTimer) {
      return;
    }

    moveFlushTimer = window.setTimeout(async () => {
      moveFlushTimer = null;
      await flushPendingDragMove();
    }, dragMoveThrottleMs);
  }

  function queueDragMove(event, extraPayload = { isDragging: true }) {
    pendingMoveEvent = {
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
    };
    pendingMoveExtra = extraPayload;
    scheduleDragMoveFlush();
  }

  function clearPendingDragMove() {
    pendingMoveEvent = null;
    pendingMoveExtra = null;
    if (moveFlushTimer) {
      window.clearTimeout(moveFlushTimer);
      moveFlushTimer = null;
    }
  }

  // Serializes the discrete button commands (mouse_down / mouse_up / mouse_click) through the
  // SAME chain as drag-moves, appending each one SYNCHRONOUSLY from its event handler.
  //
  // The browser dispatches pointerdown -> pointermove -> pointerup -> click in order, but each
  // handler is async: pointerup used to `await flushPendingDragMove()` before sending mouse_up,
  // and the browser fires the `click` event WITHOUT waiting for pointerup's promise to settle.
  // That let the click handler put mouse_click on the wire while pointerup was still awaiting the
  // flush, so mouse_click overtook mouse_up. The daemon processes commands in strict arrival
  // order, so it saw mouse_down -> mouse_click -> mouse_up -- a corrupted button sequence that
  // made element selection fail. Appending to the chain synchronously (the assignment below runs
  // before the handler yields) preserves DOM dispatch order regardless of per-send latency.
  function enqueueMouseCommand(type, event, extraPayload = {}) {
    // Snapshot the fields the payload builder reads, so the deferred send is unaffected by any
    // later mutation/reuse of the event or by the pointer having since moved.
    const snapshot = {
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
      pointerType: event.pointerType,
    };

    moveSendChain = moveSendChain.then(async () => {
      // Flush any coalesced pending drag-move first so a throttled move can never overtake the
      // button command that logically follows it.
      if (pendingMoveEvent) {
        const eventToSend = pendingMoveEvent;
        const extraToSend = pendingMoveExtra || { isDragging: true };
        pendingMoveEvent = null;
        pendingMoveExtra = null;
        try {
          await sendMappedMouseCommand('mouse_move', eventToSend, extraToSend);
        } catch (err) {
          log(`[mouse] pending move flush failed: ${err.message}`);
        }
      }
      await sendMappedMouseCommand(type, snapshot, extraPayload);
    }).catch((err) => {
      log(`[mouse] ${type} send failed: ${err.message}`);
    });

    return moveSendChain;
  }

  function launchKeyboard() {
    if (!el.keyboardCapture) {
      return;
    }

    el.keyboardCapture.value = '';
    el.keyboardCapture.focus();
    log('Keyboard launched.');
  }

  function positionKeyboardFab(left, top) {
    if (!el.keyboardFab) {
      return;
    }

    el.keyboardFab.style.left = `${Math.round(left)}px`;
    el.keyboardFab.style.top = `${Math.round(top)}px`;
    el.keyboardFab.style.right = 'auto';
    el.keyboardFab.style.bottom = 'auto';
  }

  function clampKeyboardFabPosition(left, top) {
    const boundsHost = el.keyboardFab?.offsetParent || el.remoteVideo?.closest('.mobile-remote-panel');
    if (!boundsHost || !el.keyboardFab) {
      return { left, top };
    }

    const panelRect = boundsHost.getBoundingClientRect();
    const fabRect = el.keyboardFab.getBoundingClientRect();
    const minLeft = 8;
    const minTop = 8;
    const maxLeft = Math.max(minLeft, panelRect.width - fabRect.width - 8);
    const maxTop = Math.max(minTop, panelRect.height - fabRect.height - 8);

    return {
      left: Math.max(minLeft, Math.min(maxLeft, left)),
      top: Math.max(minTop, Math.min(maxTop, top)),
    };
  }

  function getVideoScrollContainer() {
    return el.remoteVideo?.parentElement || null;
  }

  function getScrollbarHitInfo(event) {
    const container = getVideoScrollContainer();
    if (!container) {
      return { onVertical: false, onHorizontal: false, container: null };
    }

    const rect = container.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const verticalThickness = Math.max(0, container.offsetWidth - container.clientWidth);
    const horizontalThickness = Math.max(0, container.offsetHeight - container.clientHeight);

    const onVertical =
      verticalThickness > 0 &&
      localX >= container.clientWidth &&
      localX <= rect.width &&
      localY >= 0 &&
      localY <= container.clientHeight;

    const onHorizontal =
      horizontalThickness > 0 &&
      localY >= container.clientHeight &&
      localY <= rect.height &&
      localX >= 0 &&
      localX <= container.clientWidth;

    return {
      onVertical,
      onHorizontal,
      container,
    };
  }

  function getViewportMappingPayload() {
    const container = getVideoScrollContainer();
    if (!container || !el.remoteVideo) {
      return {};
    }

    const videoBox = getRenderedVideoContentRect(el.remoteVideo);
    const sourceWidth = Math.max(1, Number(el.remoteVideo.videoWidth || viewState.sourceWidth || 1));
    const sourceHeight = Math.max(1, Number(el.remoteVideo.videoHeight || viewState.sourceHeight || 1));
    const renderedWidth = Math.max(1, videoBox.rect.width || container.clientWidth || sourceWidth);
    const renderedHeight = Math.max(1, videoBox.rect.height || container.clientHeight || sourceHeight);

    // Calculate centering offset for letterboxing (aspect ratio mismatch)
    const containerAspect = renderedWidth / renderedHeight;
    const sourceAspect = sourceWidth / sourceHeight;
    const contentWidth = Math.max(1, videoBox.contentWidth || renderedWidth);
    const contentHeight = Math.max(1, videoBox.contentHeight || renderedHeight);
    const offsetX = Math.max(0, videoBox.offsetX || 0);
    const offsetY = Math.max(0, videoBox.offsetY || 0);

    const sourcePerCssX = sourceWidth / contentWidth;
    const sourcePerCssY = sourceHeight / contentHeight;

    // Use the actually visible video content area. Container can be taller/wider than
    // rendered content after layout changes, which would otherwise inflate mapped Y/X.
    const visibleCssWidth = Math.max(1, Math.min(container.clientWidth, contentWidth));
    const visibleCssHeight = Math.max(1, Math.min(container.clientHeight, contentHeight));

    const mappedViewWidth = Math.max(1, Math.round(visibleCssWidth * sourcePerCssX));
    const mappedViewHeight = Math.max(1, Math.round(visibleCssHeight * sourcePerCssY));

    const maxMappedScrollLeft = Math.max(0, sourceWidth - mappedViewWidth);
    const maxMappedScrollTop = Math.max(0, sourceHeight - mappedViewHeight);

    const mappedScrollLeft = Math.max(0, Math.round(container.scrollLeft * sourcePerCssX));
    const mappedScrollTop = Math.max(0, Math.round(container.scrollTop * sourcePerCssY));

    const payload = {
      viewScrollLeft: Math.min(maxMappedScrollLeft, mappedScrollLeft),
      viewScrollTop: Math.min(maxMappedScrollTop, mappedScrollTop),
      viewWidth: mappedViewWidth,
      viewHeight: mappedViewHeight,
      viewSourceWidth: sourceWidth,
      viewSourceHeight: sourceHeight,
    };

    return payload;
  }

  async function sendMappedMouseCommand(type, event, extraPayload = {}) {
    const viewportPayload = getViewportMappingPayload();
    const fullPayload = {
      ...viewportPayload,
      ...extraPayload,
    };
    
    if (type === 'mouse_move') {
      let data = {
        transmitted: {
          x: 'set by mapping',
          y: 'set by mapping',
          sx: 'set if isDragging=true',
          sy: 'set if isDragging=true',
          viewWidth: viewportPayload.viewWidth,
          viewHeight: viewportPayload.viewHeight,
          viewScrollLeft: viewportPayload.viewScrollLeft,
          viewScrollTop: viewportPayload.viewScrollTop,
        },
        clientLocal: {
          isDragging: extraPayload.isDragging,
        }
      };
      log('[sendMappedMouseCommand] mouse_move: ' + JSON.stringify(data));
    }
    
    return sendMouseCommand(type, event, fullPayload);
  }

  function updateHorizontalScrollbar() {
    const container = getVideoScrollContainer();
    if (!container || !el.hScrollOverlay || !el.hScrollThumb) {
      return;
    }

    const trackWidth = Math.max(1, el.hScrollOverlay.clientWidth - 2);
    const scrollWidth = container.scrollWidth;
    const clientWidth = container.clientWidth;
    const canScrollHorizontally = scrollWidth > clientWidth + 1;

    el.hScrollOverlay.classList.toggle('is-disabled', !canScrollHorizontally);
    if (!canScrollHorizontally) {
      el.hScrollThumb.style.width = `${trackWidth}px`;
      el.hScrollThumb.style.transform = 'translateX(0px)';
      return;
    }

    const ratio = clientWidth / scrollWidth;
    const thumbWidth = Math.max(36, Math.round(trackWidth * ratio));
    const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
    const maxScrollLeft = Math.max(1, scrollWidth - clientWidth);
    const thumbLeft = Math.round((container.scrollLeft / maxScrollLeft) * maxThumbLeft);

    el.hScrollThumb.style.width = `${thumbWidth}px`;
    el.hScrollThumb.style.transform = `translateX(${thumbLeft}px)`;
  }

  function updateVerticalScrollbar() {
    const container = getVideoScrollContainer();
    if (!container || !el.vScrollOverlay || !el.vScrollThumb) {
      return;
    }

    const trackHeight = Math.max(1, el.vScrollOverlay.clientHeight - 2);
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const canScrollVertically = scrollHeight > clientHeight + 1;

    el.vScrollOverlay.classList.toggle('is-disabled', !canScrollVertically);
    if (!canScrollVertically) {
      el.vScrollThumb.style.height = `${trackHeight}px`;
      el.vScrollThumb.style.transform = 'translateY(0px)';
      return;
    }

    const ratio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(36, Math.round(trackHeight * ratio));
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const thumbTop = Math.round((container.scrollTop / maxScrollTop) * maxThumbTop);

    el.vScrollThumb.style.height = `${thumbHeight}px`;
    el.vScrollThumb.style.transform = `translateY(${thumbTop}px)`;
  }

  function setHorizontalScrollVisible(visible) {
    if (!el.remotePanel) {
      return;
    }

    if (visible) {
      el.remotePanel.classList.add('show-h-scroll');
      if (hScrollHideTimer) {
        window.clearTimeout(hScrollHideTimer);
        hScrollHideTimer = null;
      }
      hScrollHideTimer = window.setTimeout(() => {
        if (hScrollDrag || hScrollHovering || hScrollBottomZoneActive) {
          setHorizontalScrollVisible(true);
          return;
        }
        el.remotePanel.classList.remove('show-h-scroll');
      }, 3200);
      return;
    }

    el.remotePanel.classList.remove('show-h-scroll');
    if (hScrollHideTimer) {
      window.clearTimeout(hScrollHideTimer);
      hScrollHideTimer = null;
    }
  }

  function setVerticalScrollVisible(visible) {
    if (!el.remotePanel) {
      return;
    }

    if (visible) {
      el.remotePanel.classList.add('show-v-scroll');
      if (vScrollHideTimer) {
        window.clearTimeout(vScrollHideTimer);
        vScrollHideTimer = null;
      }
      vScrollHideTimer = window.setTimeout(() => {
        if (vScrollDrag || vScrollHovering || vScrollRightZoneActive) {
          setVerticalScrollVisible(true);
          return;
        }
        el.remotePanel.classList.remove('show-v-scroll');
      }, 3200);
      return;
    }

    el.remotePanel.classList.remove('show-v-scroll');
    if (vScrollHideTimer) {
      window.clearTimeout(vScrollHideTimer);
      vScrollHideTimer = null;
    }
  }

  function showTouchScrollbars() {
    updateHorizontalScrollbar();
    updateVerticalScrollbar();
    setHorizontalScrollVisible(true);
    setVerticalScrollVisible(true);
  }

  function setScrollLeftFromTrackPosition(trackX) {
    const container = getVideoScrollContainer();
    if (!container || !el.hScrollOverlay || !el.hScrollThumb) {
      return;
    }

    const trackWidth = Math.max(1, el.hScrollOverlay.clientWidth - 2);
    const thumbWidth = el.hScrollThumb.offsetWidth;
    const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
    const clampedThumbLeft = Math.max(0, Math.min(maxThumbLeft, trackX));
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);

    if (maxThumbLeft <= 0 || maxScrollLeft <= 0) {
      container.scrollLeft = 0;
      updateHorizontalScrollbar();
      return;
    }

    container.scrollLeft = (clampedThumbLeft / maxThumbLeft) * maxScrollLeft;
    updateHorizontalScrollbar();
  }

  function setScrollTopFromTrackPosition(trackY) {
    const container = getVideoScrollContainer();
    if (!container || !el.vScrollOverlay || !el.vScrollThumb) {
      return;
    }

    const trackHeight = Math.max(1, el.vScrollOverlay.clientHeight - 2);
    const thumbHeight = el.vScrollThumb.offsetHeight;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const clampedThumbTop = Math.max(0, Math.min(maxThumbTop, trackY));
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

    if (maxThumbTop <= 0 || maxScrollTop <= 0) {
      container.scrollTop = 0;
      updateVerticalScrollbar();
      return;
    }

    container.scrollTop = (clampedThumbTop / maxThumbTop) * maxScrollTop;
    updateVerticalScrollbar();
  }

  function setupHorizontalWheelPan() {
    const container = getVideoScrollContainer();
    if (!container) {
      return;
    }

    container.addEventListener('wheel', (event) => {
      const hasHorizontalDelta = Math.abs(event.deltaX) > 0;
      const hasVerticalDelta = Math.abs(event.deltaY) > 0;
      const canScrollHorizontally = container.scrollWidth > container.clientWidth;

      if (!canScrollHorizontally || hasHorizontalDelta || !hasVerticalDelta || !event.shiftKey) {
        return;
      }

      event.preventDefault();
      container.scrollLeft += event.deltaY;
    }, { passive: false });
  }

  function setupVerticalWheelPan() {
    const container = getVideoScrollContainer();
    if (!container) {
      return;
    }

    container.addEventListener('wheel', (event) => {
      const hasHorizontalDelta = Math.abs(event.deltaX) > 0;
      const hasVerticalDelta = Math.abs(event.deltaY) > 0;
      const canScrollVertically = container.scrollHeight > container.clientHeight;

      if (!canScrollVertically || !hasVerticalDelta || hasHorizontalDelta || event.shiftKey) {
        return;
      }

      event.preventDefault();
      container.scrollTop += event.deltaY;
    }, { passive: false });
  }

  function detectSwipe(startX, startY, endX, endY) {
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const distance = Math.hypot(deltaX, deltaY);
    const minSwipeDistance = 40;

    if (distance < minSwipeDistance) {
      return null;
    }

    const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
    const normalizedAngle = (angle + 360) % 360;

    // Eight-directional swipe detection
    if (normalizedAngle >= 337.5 || normalizedAngle < 22.5) {
      return { direction: 'right', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    if (normalizedAngle >= 22.5 && normalizedAngle < 67.5) {
      return { direction: 'down-right', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    if (normalizedAngle >= 67.5 && normalizedAngle < 112.5) {
      return { direction: 'down', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    if (normalizedAngle >= 112.5 && normalizedAngle < 157.5) {
      return { direction: 'down-left', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    if (normalizedAngle >= 157.5 && normalizedAngle < 202.5) {
      return { direction: 'left', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    if (normalizedAngle >= 202.5 && normalizedAngle < 247.5) {
      return { direction: 'up-left', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    if (normalizedAngle >= 247.5 && normalizedAngle < 292.5) {
      return { direction: 'up', deltaX, deltaY, distance, angle: normalizedAngle };
    }
    return { direction: 'up-right', deltaX, deltaY, distance, angle: normalizedAngle };
  }

  function applyViewScale(scalePercent) {
    const normalizedPercent = Number.isFinite(scalePercent) && scalePercent > 0 ? scalePercent : 100;
    viewState.scalePercent = normalizedPercent;

    const container = getVideoScrollContainer();
    if (!container) {
      return;
    }

    if (fitToViewport) {
      // First version: lock stream rendering to viewport to avoid page swipe/scroll conflicts.
      el.remoteVideo.style.width = '100%';
      el.remoteVideo.style.height = '100%';
      el.remoteVideo.style.maxWidth = '100%';
      el.remoteVideo.style.maxHeight = '100%';
      el.remoteVideo.style.transform = 'none';
      el.remoteVideo.style.transformOrigin = 'top left';
      container.scrollLeft = 0;
      container.scrollTop = 0;
      return;
    }

    const sourceWidth = Math.max(1, Math.round(viewState.sourceWidth || 1280));
    const sourceHeight = Math.max(1, Math.round(viewState.sourceHeight || 720));

    el.remoteVideo.style.width = `${sourceWidth}px`;
    el.remoteVideo.style.height = `${sourceHeight}px`;
    el.remoteVideo.style.maxWidth = 'none';
    el.remoteVideo.style.maxHeight = 'none';
    el.remoteVideo.style.transformOrigin = 'top left';
    el.remoteVideo.style.transform = `scale(${normalizedPercent / 100})`;
  }

  function isControlReady() {
    // Require actual video metadata (videoWidth/videoHeight), not just srcObject being
    // attached. srcObject is set immediately in onRemoteStream, well before the video has
    // decoded any real frame -- clicking before then makes getRenderedVideoContentRect()
    // fall back to the video element's own CSS-rendered box size instead of the real
    // stream resolution, producing a click mapping completely unrelated to the actual
    // captured video (and unrelated to anything changed on the daemon side).
    return Boolean(connected && el.remoteVideo?.srcObject && el.remoteVideo.videoWidth > 0 && el.remoteVideo.videoHeight > 0);
  }

  async function sendTextInput(text) {
    if (!text) {
      return;
    }

    if (!isControlReady()) {
      log('Skip text_input: remote stream is not ready.');
      return;
    }

    const requestId = await ducClient.sendCommand('text_input', { text });
    log(`text_input sent (${requestId}): ${JSON.stringify(text)}`);
  }

  async function sendKeyPress(key) {
    if (!isControlReady()) {
      log('Skip key_press: remote stream is not ready.');
      return;
    }

    const requestId = await ducClient.sendCommand('key_press', { key });
    log(`key_press sent (${requestId}): ${key}`);
  }

  const sendMouseCommand = createViewerMouseCommandSender({
    sendCommand: async (type, payload) => {
      if (!isControlReady()) {
        log(`Skip ${type}: remote stream is not ready.`);
        return `skipped-${type}-${Date.now()}`;
      }

      return ducClient.sendCommand(type, payload);
    },
    videoElement: el.remoteVideo,
    getIsDragging: () => isMousePressed,
    onPointerMapped: (mapped, { type, pointerEvent, extraPayload }) => {
      if (type === 'mouse_click') {
        const viewportInfo = getViewportMappingPayload();
        const videoBox = getRenderedVideoContentRect(el.remoteVideo);
        log(
          `[DEBUG] ${type} - raw: (${Math.round(pointerEvent.clientX)}, ${Math.round(pointerEvent.clientY)}) ` +
          `mapped: (${mapped.x}, ${mapped.y}) ` +
          `source: ${mapped.sourceWidth}x${mapped.sourceHeight} ` +
          `content: ${Math.round(mapped.contentRect.width)}x${Math.round(mapped.contentRect.height)} ` +
          `offset: (${mapped.contentRect.offsetX}, ${mapped.contentRect.offsetY}) ` +
          `rendered: ${Math.round(videoBox.rect.width)}x${Math.round(videoBox.rect.height)} ` +
          `renderedOffset: (${Math.round(videoBox.offsetX)}, ${Math.round(videoBox.offsetY)}) ` +
          `viewport: scroll(${viewportInfo.viewScrollLeft}, ${viewportInfo.viewScrollTop}) ` +
          `size(${viewportInfo.viewWidth}, ${viewportInfo.viewHeight})`
        );
      }
    },
    onAfterSend: ({ type, requestId, payload, mapped }) => {
      if (type === 'mouse_click') {
        log(`${type} sent (${requestId}): x=${payload.x} y=${payload.y} source=${payload.sourceWidth}x${payload.sourceHeight}`);
      } else if (type !== 'mouse_move') {
        log(`${type} sent (${requestId}).`);
      }
    },
  });

  ducClient.onRemoteStream = (stream) => {
    const mediaStream =
      (stream?.mediaStream instanceof MediaStream)
        ? stream.mediaStream
        : (stream instanceof MediaStream ? stream : null);

    if (mediaStream) {
      el.remoteVideo.autoplay = true;
      el.remoteVideo.playsInline = true;
      el.remoteVideo.muted = true;

      if (el.remoteVideo.srcObject !== mediaStream) {
        el.remoteVideo.srcObject = mediaStream;
      }

      el.remoteVideo.play().catch(() => {});
      daemonReadyHint = true;
      setClientState('daemonConnected', `Daemon "${getDaemonId()}" started screen sharing.`);
      setClientState('daemonInteraction', 'Connected and receiving remote stream.');
      log('Remote stream attached.');
      return;
    }

    log('Remote stream event received without mediaStream.');
  };

  ducClient.onSignalingConnected = ({ uid, host }) => {
    log(`Signaling authenticated as "${uid}" via "${host}".`);
  };

  el.remoteVideo.addEventListener('loadedmetadata', () => {
    if (el.remoteVideo.videoWidth > 0) {
      viewState.sourceWidth = el.remoteVideo.videoWidth;
    }
    if (el.remoteVideo.videoHeight > 0) {
      viewState.sourceHeight = el.remoteVideo.videoHeight;
    }
    applyViewScale(viewState.scalePercent);
    updateHorizontalScrollbar();
    updateVerticalScrollbar();
  });

  el.keyboardFab.addEventListener('click', () => {
    if (keyboardFabSuppressClick) {
      keyboardFabSuppressClick = false;
      return;
    }

    launchKeyboard();
  });

  el.keyboardFab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const fabRect = el.keyboardFab.getBoundingClientRect();
    keyboardFabDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: fabRect.left - el.keyboardFab.offsetParent.getBoundingClientRect().left,
      originTop: fabRect.top - el.keyboardFab.offsetParent.getBoundingClientRect().top,
      moved: false,
    };

    el.keyboardFab.classList.add('is-dragging');

    try {
      if (typeof el.keyboardFab.setPointerCapture === 'function') {
        el.keyboardFab.setPointerCapture(event.pointerId);
      }
    } catch {
      // Ignore pointer capture failures.
    }
  });

  el.keyboardFab.addEventListener('pointermove', (event) => {
    if (!keyboardFabDrag || keyboardFabDrag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - keyboardFabDrag.startX;
    const deltaY = event.clientY - keyboardFabDrag.startY;

    if (!keyboardFabDrag.moved && Math.hypot(deltaX, deltaY) < 4) {
      return;
    }

    keyboardFabDrag.moved = true;
    keyboardFabSuppressClick = true;
    const nextPosition = clampKeyboardFabPosition(
      keyboardFabDrag.originLeft + deltaX,
      keyboardFabDrag.originTop + deltaY,
    );
    positionKeyboardFab(nextPosition.left, nextPosition.top);
  });

  el.keyboardFab.addEventListener('pointerup', (event) => {
    if (!keyboardFabDrag || keyboardFabDrag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const wasDragged = keyboardFabDrag.moved;
    keyboardFabDrag = null;
    el.keyboardFab.classList.remove('is-dragging');

    try {
      if (typeof el.keyboardFab.releasePointerCapture === 'function') {
        el.keyboardFab.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore pointer capture failures.
    }

    if (!wasDragged) {
      keyboardFabSuppressClick = true;
      launchKeyboard();
    }
  });

  el.keyboardFab.addEventListener('pointercancel', (event) => {
    if (!keyboardFabDrag || keyboardFabDrag.pointerId !== event.pointerId) {
      return;
    }

    keyboardFabDrag = null;
    el.keyboardFab.classList.remove('is-dragging');
  });

  ducClient.onDisconnect = () => {
    connected = false;
    messageChannelReady = false;
    daemonReadyHint = false;
    leaveSent = false;
    resolveSent = false;
    resolveAcked = false;
    resolveAttempts = 0;
    resolveInFlight = false;
    clearResolveRetryTimer();
    clearPendingDragMove();
    stopSessionCountdown();
    setClientState('owtDisconnected', 'Disconnected from signaling.');
    log('Disconnected from signaling server.');
  };

  ducClient.onMessage = ({ origin, message }) => {
    try {
      const rawMessage =
        message && typeof message === 'object'
          ? (Object.prototype.hasOwnProperty.call(message, 'message')
            ? message.message
            : (Object.prototype.hasOwnProperty.call(message, 'data') ? message.data : message))
          : message;
      const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
      if (parsed.type === 'daemon_online') {
        const daemonId = String(parsed?.payload?.daemonId || getDaemonId()).trim();
        if (daemonId) {
          ducClient.setDaemonId(daemonId);
        }
        daemonReadyHint = true;
        startSessionCountdown(parsed?.payload?.timeoutMs);
        setClientState('daemonConnected', `Daemon "${daemonId || getDaemonId()}" is online.`);
        if (resolveInFlight) {
          log(`daemon_online received from "${origin}" while a Resolve attempt is already in flight; skipping.`);
          return;
        }
        setClientState('daemonConnecting', `Sending Resolve to daemon "${daemonId || getDaemonId()}"...`);
        log(`daemon_online received from "${origin}". Triggering Resolve.`);
        void sendResolve('daemon-online');
        return;
      }
      if (parsed.type === 'calibrate_request') {
        const markers = Array.isArray(parsed?.payload?.markers) ? parsed.payload.markers : [];
        log(`Calibration requested by daemon "${origin}" (${markers.length} markers).`);
        void (async () => {
          setCalibrationVeilVisible(true);
          // Retry a few times with a short delay: the video element may not yet have
          // decoded/rendered a frame that actually contains the just-injected markers
          // (WebRTC first-frame latency can exceed a single detection attempt).
          try {
            const maxAttempts = 4;
            const retryDelayMs = 300;
            let detection = { ok: false, error: 'not attempted' };
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              // Only save a debug snapshot on the first attempt (and only when explicitly enabled
              // via ?debugCalibrationFrame=1) to avoid spamming downloads during normal use.
              const shouldSaveDebugFrame = attempt === 1 && hasAnySearchParam(searchParams, ['debugCalibrationFrame']);
              detection = await detectCalibrationMarkers(markers, { saveDebugFrame: shouldSaveDebugFrame });
              if (detection.ok) {
                break;
              }
              log(`Calibration detection attempt ${attempt}/${maxAttempts} failed: ${detection.error}`);
              if (attempt < maxAttempts) {
                await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
              }
            }

            if (!detection.ok) {
              log(`Calibration detection failed after ${maxAttempts} attempts: ${detection.error}`);
            } else {
              log(`Calibration detection succeeded: ${JSON.stringify(detection.correspondences)}`);
            }

            try {
              await ducClient.sendMessage({
                type: 'calibrate_result',
                requestId: parsed.requestId,
                payload: detection,
              });
            } catch (error) {
              log(`Calibration result send failed: ${error.message}`);
            }
          } finally {
            setCalibrationVeilVisible(false);
          }
        })();
        return;
      }
      if (parsed.type === 'resolve_ack') {
        resolveAcked = true;
        resolveInFlight = false;
        clearResolveRetryTimer();
        setClientState('daemonConnected', 'Resolve acknowledged by daemon. Waiting for result...');
        log(`Resolve acknowledged by daemon. Waiting for result...`);
        console.log('[client] resolve_ack received', { requestId: parsed.requestId });
        return;
      }
      if (parsed.type === 'resolve_result') {
        const ok = parsed.ok !== false;
        if (ok) {
          resolveSent = true;
          clearResolveRetryTimer();
        }
        resolveInFlight = false;
        setClientState(ok ? 'daemonConnected' : 'daemonDisconnected', ok ? 'Resolve processed. Daemon is starting screen share.' : `Resolve failed: ${parsed.error || 'unknown error'}`);
        log(`Resolve result: ${ok ? 'ok' : 'failed'} ${parsed.error ? `(${parsed.error})` : ''}`);
        return;
      }
      if (parsed.type === 'timeout_notice' || parsed.type === 'finish_ack') {
        const isFinish = parsed.type === 'finish_ack';
        const noticeMessage = String(parsed.message || parsed.payload?.message || (isFinish
          ? 'Session finished by daemon.'
          : 'Session timed out on daemon.')).trim();

        showTerminalNotice(isFinish ? 'active' : 'error', noticeMessage);
        setClientState('daemonDisconnected', noticeMessage);
        log(`${parsed.type} received: ${noticeMessage}`);

        stopSessionCountdown();
        void ducClient.disconnect().catch(() => {});
        connected = false;
        leaveSent = false;
        resolveSent = false;
        resolveAcked = false;
        resolveAttempts = 0;
        resolveInFlight = false;
        clearResolveRetryTimer();
        return;
      }
      if (parsed.type === 'command_result') {
        log(
          `Result "${parsed.requestId || 'n/a'}" from "${origin}": ${parsed.ok ? 'ok' : 'failed'} ` +
          `${parsed.error ? `(${parsed.error})` : ''}`
        );
        return;
      }
    } catch {
      // Keep compatibility with plain text messages.
    }

    log(`Message from "${origin}": ${String(message || '').length} bytes`);
  };

  el.keyboardCapture.addEventListener('beforeinput', async (event) => {
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

  el.keyboardCapture.addEventListener('keydown', async (event) => {
    if (event.key !== 'Backspace') {
      return;
    }

    event.preventDefault();
    try {
      await sendKeyPress('Backspace');
      el.keyboardCapture.value = '';
    } catch (error) {
      log(`key_press(keydown) failed: ${error.message}`);
    }
  });

  el.keyboardCapture.addEventListener('input', async (event) => {
    if (event.inputType === 'deleteContentBackward') {
      try {
        await sendKeyPress('Backspace');
      } catch (error) {
        log(`key_press(input-delete) failed: ${error.message}`);
      }
      el.keyboardCapture.value = '';
      return;
    }

    const text = event.data ?? el.keyboardCapture.value;
    el.keyboardCapture.value = '';

    if (!text) {
      return;
    }

    try {
      await sendTextInput(text);
    } catch (error) {
      log(`text_input failed: ${error.message}`);
    }
  });

  // Touch and pointer event handlers with swipe gesture detection
  el.remoteVideo.addEventListener('pointerdown', async (event) => {
    if (nativeScrollbarDrag && nativeScrollbarDrag.pointerId === event.pointerId) {
      log(`Skipped mouse_down: pointer ${event.pointerId} is dragging native scrollbar.`);
      return;
    }

    if (event.pointerType === 'touch') {
      showTouchScrollbars();
      swipeStart = { x: event.clientX, y: event.clientY, timestamp: Date.now() };
      swipeTarget = 'video';
      log(`Touch start on VIDEO (pointer ${event.pointerId}): (${Math.round(event.clientX)}, ${Math.round(event.clientY)})`);
    }

    // Defer the button press for ALL pointer types until we know click vs drag. Do NOT send
    // mouse_down here -- a plain click will send a single mouse_click on release instead.
    pressPending = true;
    isMousePressed = false;
    activePointerId = event.pointerId;
    activePointerStart = { x: event.clientX, y: event.clientY };
    remoteDragMoved = false;
    try {
      if (typeof el.remoteVideo.setPointerCapture === 'function') {
        el.remoteVideo.setPointerCapture(event.pointerId);
      }
    } catch {
      // Ignore pointer capture failures.
    }
  });

  el.remoteVideo.addEventListener('pointermove', async (event) => {
    if (nativeScrollbarDrag && nativeScrollbarDrag.pointerId === event.pointerId) {
      return;
    }

    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }

    if (pressPending && activePointerStart) {
      const dx = event.clientX - activePointerStart.x;
      const dy = event.clientY - activePointerStart.y;
      if (Math.hypot(dx, dy) >= 6) {
        // Movement past threshold => this is a drag, not a click. Now (and only now) press the
        // button down; the matching mouse_up is sent on release.
        pressPending = false;
        isMousePressed = true;
        remoteDragMoved = true;
        enqueueMouseCommand('mouse_down', event);
      } else {
        return;
      }
    }

    if (!isMousePressed) {
      return;
    }

    if (activePointerStart) {
      const dx = event.clientX - activePointerStart.x;
      const dy = event.clientY - activePointerStart.y;
      if (Math.hypot(dx, dy) >= 3) {
        remoteDragMoved = true;
      }
    }

    queueDragMove(event, { isDragging: true });
  });

  el.remoteVideo.addEventListener('pointerup', async (event) => {
    if (nativeScrollbarDrag && nativeScrollbarDrag.pointerId === event.pointerId) {
      return;
    }

    const wasTouch = event.pointerType === 'touch';
    const currentSwipeTarget = swipeTarget;
    const swipe = wasTouch && swipeStart && currentSwipeTarget === 'video' ? detectSwipe(swipeStart.x, swipeStart.y, event.clientX, event.clientY) : null;

    if (swipe) {
      log(`Swipe detected on VIDEO: ${swipe.direction} (distance=${Math.round(swipe.distance)}px, angle=${Math.round(swipe.angle)}°)`);
    }

    if (wasTouch) {
      const targetName = currentSwipeTarget === 'video' ? 'VIDEO' : 'SCROLLBAR';
      log(`Touch end on ${targetName} (pointer ${event.pointerId}): (${Math.round(event.clientX)}, ${Math.round(event.clientY)})`);
      swipeStart = null;
      swipeTarget = null;
    }

    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }

    if (pressPending) {
      // Released without dragging => a plain click. Send exactly ONE mouse_click and suppress the
      // synthetic DOM 'click' that follows, so the daemon clicks the element once (not twice, and
      // with no stray mouse_down/mouse_up around it).
      pressPending = false;
      activePointerId = null;
      activePointerStart = null;
      isMousePressed = false;
      suppressClick = true;

      if (currentSwipeTarget !== 'scrollbar') {
        enqueueMouseCommand('mouse_click', event);
      }
      return;
    }

    // A drag was in progress => release the button that pointermove pressed.
    activePointerId = null;
    activePointerStart = null;
    isMousePressed = false;
    pressPending = false;

    // Only send to daemon if the gesture was on video, not on a scrollbar.
    // enqueueMouseCommand flushes any pending drag-move as part of the same chain link, so we
    // must NOT await a separate flush here.
    if (currentSwipeTarget !== 'scrollbar' || !wasTouch) {
      enqueueMouseCommand('mouse_up', event, { isDragging: false });
    } else {
      clearPendingDragMove();
      log(`Skipped mouse_up: touch was on scrollbar, not video`);
    }
  });

  el.remoteVideo.addEventListener('pointercancel', async (event) => {
    if (nativeScrollbarDrag && nativeScrollbarDrag.pointerId === event.pointerId) {
      return;
    }

    const currentSwipeTarget = swipeTarget;
    if (event.pointerType === 'touch') {
      const targetName = currentSwipeTarget === 'video' ? 'VIDEO' : 'SCROLLBAR';
      log(`Touch cancelled on ${targetName} (pointer ${event.pointerId})`);
      swipeStart = null;
      swipeTarget = null;
    }

    if (!isMousePressed || (activePointerId !== null && event.pointerId !== activePointerId)) {
      // Includes the deferred-press case (pressPending but never dragged): a cancelled click sends
      // nothing to the daemon.
      pressPending = false;
      clearPendingDragMove();
      return;
    }

    activePointerId = null;
    activePointerStart = null;
    isMousePressed = false;
    pressPending = false;

    // Only send to daemon if touch was on video. (enqueueMouseCommand flushes any pending
    // drag-move within the same chain link, so no separate await-flush is needed here.)
    if (currentSwipeTarget !== 'scrollbar' || event.pointerType !== 'touch') {
      enqueueMouseCommand('mouse_up', event, { isDragging: false });
    } else {
      clearPendingDragMove();
    }
  });

  el.remoteVideo.addEventListener('click', async (event) => {
    // For both touch and mouse, pointerup already sent the single mouse_click for a plain click
    // and set suppressClick. This synthetic DOM 'click' must therefore be dropped so the element
    // isn't clicked twice. (Kept as a defensive fallback path in case pointerup didn't run.)
    if (suppressClick) {
      suppressClick = false;
      return;
    }

    if (remoteDragMoved) {
      remoteDragMoved = false;
      return;
    }

    if (event.button !== 0) {
      return;
    }

    if (event.detail > 1) {
      return;
    }

    event.preventDefault();
    const videoRect = el.remoteVideo.getBoundingClientRect();
    log(
      `[DEBUG] click event - pointerType: ${event.pointerType} ` +
      `raw coords: (${Math.round(event.clientX)}, ${Math.round(event.clientY)}) ` +
      `video rect: (${Math.round(videoRect.left)}, ${Math.round(videoRect.top)}) ` +
      `video size: ${Math.round(videoRect.width)}x${Math.round(videoRect.height)} ` +
      `video source: ${el.remoteVideo.videoWidth}x${el.remoteVideo.videoHeight}`
    );
    // Enqueued (not awaited) so it lands on the wire strictly after the preceding mouse_up that
    // the pointerup handler enqueued synchronously a moment earlier.
    enqueueMouseCommand('mouse_click', event);
  });

  el.remoteVideo.addEventListener('dblclick', (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    launchKeyboard();
  });

  // Multi-touch detection for context menu (two-finger tap)
  el.remoteVideo.addEventListener('touchstart', (event) => {
    touchCount = event.touches.length;
    if (touchCount === 2) {
      log(`Two-finger touch detected (touchstart)`);
    }
  }, { passive: true });

  el.remoteVideo.addEventListener('touchend', (event) => {
    touchCount = event.touches.length;
    if (event.changedTouches.length === 2 && touchCount === 0) {
      log(`Two-finger tap detected (right-click equivalent)`);
    }
  }, { passive: true });

  el.remoteVideo.addEventListener('contextmenu', (event) => {
    if (event.altKey) {
      event.preventDefault();
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    applyViewScale(viewState.scalePercent);
    updateHorizontalScrollbar();
    updateVerticalScrollbar();

    if (!el.keyboardFab) {
      return;
    }

    const currentLeft = Number.parseFloat(el.keyboardFab.style.left || '0');
    const currentTop = Number.parseFloat(el.keyboardFab.style.top || '0');
    if (Number.isFinite(currentLeft) && Number.isFinite(currentTop) && el.keyboardFab.style.left) {
      const clamped = clampKeyboardFabPosition(currentLeft, currentTop);
      positionKeyboardFab(clamped.left, clamped.top);
    }
  });

  resizeObserver.observe(el.remoteVideo.parentElement || el.remoteVideo);

  window.addEventListener('resize', () => {
    applyViewScale(viewState.scalePercent);
    updateHorizontalScrollbar();
    updateVerticalScrollbar();
  });

  function setupCustomHorizontalScrollbar() {
    if (fitToViewport) {
      if (el.remotePanel) {
        el.remotePanel.classList.remove('show-h-scroll');
      }
      return;
    }

    const container = getVideoScrollContainer();
    if (!container || !el.hScrollOverlay || !el.hScrollThumb) {
      return;
    }

    container.addEventListener('scroll', () => {
      updateHorizontalScrollbar();
      setHorizontalScrollVisible(true);
      updateVerticalScrollbar();
      setVerticalScrollVisible(true);
    }, { passive: true });

    el.hScrollOverlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      // Mark swipe target as scrollbar when touch starts on scrollbar
      if (event.pointerType === 'touch') {
        showTouchScrollbars();
        swipeStart = { x: event.clientX, y: event.clientY, timestamp: Date.now() };
        swipeTarget = 'scrollbar';
        log(`Touch start on SCROLLBAR (pointer ${event.pointerId}): (${Math.round(event.clientX)}, ${Math.round(event.clientY)})`);
      }

      event.preventDefault();
      setHorizontalScrollVisible(true);
      const trackRect = el.hScrollOverlay.getBoundingClientRect();
      const thumbRect = el.hScrollThumb.getBoundingClientRect();
      const pointerX = event.clientX - trackRect.left;
      const thumbLeft = thumbRect.left - trackRect.left;
      const pointerOffsetInThumb = event.target === el.hScrollThumb
        ? event.clientX - thumbRect.left
        : thumbRect.width / 2;

      hScrollDrag = {
        pointerId: event.pointerId,
        trackLeft: trackRect.left,
        pointerOffsetInThumb,
      };

      setScrollLeftFromTrackPosition(pointerX - pointerOffsetInThumb);

      try {
        if (typeof el.hScrollOverlay.setPointerCapture === 'function') {
          el.hScrollOverlay.setPointerCapture(event.pointerId);
        }
      } catch {
        // Ignore pointer capture failures.
      }
    });

    el.hScrollOverlay.addEventListener('pointermove', (event) => {
      if (!hScrollDrag || hScrollDrag.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const pointerX = event.clientX - hScrollDrag.trackLeft;
      setScrollLeftFromTrackPosition(pointerX - hScrollDrag.pointerOffsetInThumb);
      setHorizontalScrollVisible(true);
    });

    const finishDrag = (event) => {
      if (!hScrollDrag || hScrollDrag.pointerId !== event.pointerId) {
        return;
      }

      // Detect swipe on scrollbar
      const wasTouch = event.pointerType === 'touch';
      const swipe = wasTouch && swipeStart && swipeTarget === 'scrollbar' ? detectSwipe(swipeStart.x, swipeStart.y, event.clientX, event.clientY) : null;

      if (swipe) {
        log(`Swipe detected on SCROLLBAR: ${swipe.direction} (distance=${Math.round(swipe.distance)}px, angle=${Math.round(swipe.angle)}°) - NOT sent to daemon`);
      }

      if (wasTouch && swipeTarget === 'scrollbar') {
        swipeStart = null;
        swipeTarget = null;
      }

      hScrollDrag = null;
      setHorizontalScrollVisible(true);
      try {
        if (typeof el.hScrollOverlay.releasePointerCapture === 'function') {
          el.hScrollOverlay.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Ignore pointer capture failures.
      }
    };

    el.hScrollOverlay.addEventListener('pointerup', finishDrag);
    el.hScrollOverlay.addEventListener('pointercancel', finishDrag);
    el.hScrollOverlay.addEventListener('mouseenter', () => {
      hScrollHovering = true;
      setHorizontalScrollVisible(true);
    });
    el.hScrollOverlay.addEventListener('mouseleave', () => {
      hScrollHovering = false;
      if (!hScrollDrag && !hScrollBottomZoneActive) {
        setHorizontalScrollVisible(false);
      }
    });
  }

  function setupCustomVerticalScrollbar() {
    if (fitToViewport) {
      if (el.remotePanel) {
        el.remotePanel.classList.remove('show-v-scroll');
      }
      return;
    }

    const container = getVideoScrollContainer();
    if (!container || !el.vScrollOverlay || !el.vScrollThumb) {
      return;
    }

    el.vScrollOverlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      if (event.pointerType === 'touch') {
        showTouchScrollbars();
        swipeStart = { x: event.clientX, y: event.clientY, timestamp: Date.now() };
        swipeTarget = 'scrollbar';
        log(`Touch start on VSCROLLBAR (pointer ${event.pointerId}): (${Math.round(event.clientX)}, ${Math.round(event.clientY)})`);
      }

      event.preventDefault();
      setVerticalScrollVisible(true);
      const trackRect = el.vScrollOverlay.getBoundingClientRect();
      const thumbRect = el.vScrollThumb.getBoundingClientRect();
      const pointerY = event.clientY - trackRect.top;
      const pointerOffsetInThumb = event.target === el.vScrollThumb
        ? event.clientY - thumbRect.top
        : thumbRect.height / 2;

      vScrollDrag = {
        pointerId: event.pointerId,
        trackTop: trackRect.top,
        pointerOffsetInThumb,
      };

      setScrollTopFromTrackPosition(pointerY - pointerOffsetInThumb);

      try {
        if (typeof el.vScrollOverlay.setPointerCapture === 'function') {
          el.vScrollOverlay.setPointerCapture(event.pointerId);
        }
      } catch {
        // Ignore pointer capture failures.
      }
    });

    el.vScrollOverlay.addEventListener('pointermove', (event) => {
      if (!vScrollDrag || vScrollDrag.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const pointerY = event.clientY - vScrollDrag.trackTop;
      setScrollTopFromTrackPosition(pointerY - vScrollDrag.pointerOffsetInThumb);
      setVerticalScrollVisible(true);
    });

    const finishDrag = (event) => {
      if (!vScrollDrag || vScrollDrag.pointerId !== event.pointerId) {
        return;
      }

      const wasTouch = event.pointerType === 'touch';
      const swipe = wasTouch && swipeStart && swipeTarget === 'scrollbar' ? detectSwipe(swipeStart.x, swipeStart.y, event.clientX, event.clientY) : null;

      if (swipe) {
        log(`Swipe detected on VSCROLLBAR: ${swipe.direction} (distance=${Math.round(swipe.distance)}px, angle=${Math.round(swipe.angle)}°) - NOT sent to daemon`);
      }

      if (wasTouch && swipeTarget === 'scrollbar') {
        swipeStart = null;
        swipeTarget = null;
      }

      vScrollDrag = null;
      setVerticalScrollVisible(true);
      try {
        if (typeof el.vScrollOverlay.releasePointerCapture === 'function') {
          el.vScrollOverlay.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Ignore pointer capture failures.
      }
    };

    el.vScrollOverlay.addEventListener('pointerup', finishDrag);
    el.vScrollOverlay.addEventListener('pointercancel', finishDrag);
    el.vScrollOverlay.addEventListener('mouseenter', () => {
      vScrollHovering = true;
      setVerticalScrollVisible(true);
    });
    el.vScrollOverlay.addEventListener('mouseleave', () => {
      vScrollHovering = false;
      if (!vScrollDrag && !vScrollRightZoneActive) {
        setVerticalScrollVisible(false);
      }
    });
  }

  function setupNativeScrollbarGestureGuard() {
    const container = getVideoScrollContainer();
    if (!container) {
      return;
    }

    container.addEventListener('pointerdown', (event) => {
      const hit = getScrollbarHitInfo(event);
      if (!hit.onVertical && !hit.onHorizontal) {
        return;
      }

      const axis = hit.onVertical && hit.onHorizontal
        ? 'corner'
        : hit.onVertical
          ? 'vertical'
          : 'horizontal';

      nativeScrollbarDrag = {
        pointerId: event.pointerId,
        axis,
      };

      if (event.pointerType === 'touch') {
        showTouchScrollbars();
        swipeStart = { x: event.clientX, y: event.clientY, timestamp: Date.now() };
        swipeTarget = 'scrollbar';
      }

      setHorizontalScrollVisible(true);
      setVerticalScrollVisible(true);
      log(`Pointer down on native ${axis} scrollbar (pointer ${event.pointerId}); event kept local.`);
    }, { capture: true });

    const finishNativeScrollbarDrag = (event) => {
      if (!nativeScrollbarDrag || nativeScrollbarDrag.pointerId !== event.pointerId) {
        return;
      }

      if (event.pointerType === 'touch' && swipeTarget === 'scrollbar') {
        swipeStart = null;
        swipeTarget = null;
      }

      nativeScrollbarDrag = null;
    };

    container.addEventListener('pointerup', finishNativeScrollbarDrag, { capture: true });
    container.addEventListener('pointercancel', finishNativeScrollbarDrag, { capture: true });
  }

  document.addEventListener('pointermove', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') {
      return;
    }

    const nearBottom = window.innerHeight - event.clientY <= 140;
    hScrollBottomZoneActive = nearBottom;
    const nearRight = window.innerWidth - event.clientX <= 140;
    vScrollRightZoneActive = nearRight;
    if (nearBottom) {
      setHorizontalScrollVisible(true);
    } else if (!hScrollDrag && !hScrollHovering) {
      setHorizontalScrollVisible(false);
    }

    if (nearRight) {
      setVerticalScrollVisible(true);
      return;
    }

    if (!vScrollDrag && !vScrollHovering) {
      setVerticalScrollVisible(false);
    }
  }, { passive: true });

  window.addEventListener('pagehide', async () => {
    await sendLeaveMessage('pagehide');
  });

  window.addEventListener('beforeunload', async () => {
    await sendLeaveMessage('beforeunload');
  });

  if (el.finishBtn) {
    el.finishBtn.addEventListener('click', async () => {
      // Stop the "Time left" countdown as soon as the user finishes the session.
      stopSessionCountdown();
      try {
        await sendFinishMessage('button_click');
        setClientState('daemonInteraction', `Finish sent to daemon "${getDaemonId()}".`);
        log(`Finish sent to daemon "${getDaemonId()}".`);

        // Finish delivered: proactively disconnect from the OWT signaling server
        // instead of waiting for the daemon's finish_ack (which may not arrive
        // before teardown). Mirrors the finish_ack/timeout_notice teardown below.
        void ducClient.disconnect().catch(() => {});
        connected = false;
        leaveSent = false;
        resolveSent = false;
        resolveAcked = false;
        resolveAttempts = 0;
        resolveInFlight = false;
        clearResolveRetryTimer();
      } catch (error) {
        setClientState('daemonDisconnected', `Finish failed: ${error.message}`);
        log(`Finish failed: ${error.message}`);
      }
    });
  }

  setupNativeScrollbarGestureGuard();
  setupHorizontalWheelPan();
  setupVerticalWheelPan();
  setupCustomHorizontalScrollbar();
  setupCustomVerticalScrollbar();

  const scrollContainer = getVideoScrollContainer();
  if (scrollContainer) {
    scrollContainer.addEventListener('touchstart', () => {
      showTouchScrollbars();
    }, { passive: true });
  }

  setClientState('owtConnecting', `Connecting to signaling for daemon "${getDaemonId()}"...`);
  log(`Auto-connecting to signaling server "${getSignalingUrl()}" for daemon "${getDaemonId()}".`);

  try {
    const rtcOptions = getRtcConnectOptions();
    console.log('[client] p2p connect config', {
      signalingServer: getSignalingUrl(),
      daemonId: getDaemonId(),
      clientId: getClientId(),
      ...summarizeIceConfigForLog(rtcOptions),
    });

    ducClient.connect({
      signalingHost: getSignalingUrl(),
      clientId: getClientId(),
      daemonId: getDaemonId(),
      ...rtcOptions,
    }).then(() => {
      connected = true;
      leaveSent = false;
      messageChannelReady = true;
      clearResolveRetryTimer();
      setClientState('owtConnected', `Connected to signaling for daemon "${getDaemonId()}". Waiting for daemon_online...`);

      // Fallback path: if daemon_online is delayed/dropped, initiate resolve from client side.
      // This keeps session startup deterministic across signaling/server timing differences.
      window.setTimeout(() => {
        if (!connected || resolveSent || resolveAcked) {
          return;
        }
        void sendResolve('client-connect-fallback');
      }, 2000);

      log('Client connect() promise resolved.');
    }).catch((error) => {
      setClientState('owtDisconnected', `Client connect() failed: ${error.message}`);
      log(`Client connect() failed: ${error.message}`);
    });
  } catch (error) {
    setClientState('owtDisconnected', `Connect setup failed: ${error.message}`);
    log(`Connect setup failed: ${error.message}`);
    return;
  }

  applyViewScale(viewState.scalePercent);
  updateHorizontalScrollbar();
  updateVerticalScrollbar();
}

init();

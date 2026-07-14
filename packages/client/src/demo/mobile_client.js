import {
  AgenticBrowserClient,
  createPeerIds,
  createViewerMouseCommandSender,
  hasAnySearchParam,
  loadClientRuntimeConfig,
  readSearchParam,
  readSearchParamAny,
  readSearchPercentParam,
  summarizeIceConfigForLog,
} from '../sdk/index.js';
import { normalizeRtcIceOptions, parseRtcIceServersJson } from '../sdk/rtcConfig.js';

async function init() {
  const runtimeConfig = await loadClientRuntimeConfig('/client-demo.runtime.json');
  const searchParams = new URLSearchParams(window.location.search);
  const client = new AgenticBrowserClient();
  let connected = false;
  let isMousePressed = false;
  let activePointerId = null;
  let activePointerStart = null;
  let touchPressPending = false;
  let suppressTouchClick = false;
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
  let moveSendInFlight = false;
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
    hScrollOverlay: document.getElementById('hScrollOverlay'),
    hScrollThumb: document.getElementById('hScrollThumb'),
    vScrollOverlay: document.getElementById('vScrollOverlay'),
    vScrollThumb: document.getElementById('vScrollThumb'),
    keyboardFab: document.getElementById('keyboardFab'),
    keyboardCapture: document.getElementById('keyboardCapture'),
  };

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
  console.log('[mobile_client] Resolved signaling server to:', envSignalingServer, '(from config:', runtimeConfig.signalingServer, ')');
  if (!runtimeConfig.signalingServer && !import.meta.env?.SIGNALING_SERVER) {
    console.warn('[mobile_client] Using default signaling server. Consider setting SIGNALING_SERVER env var or /client-demo.runtime.json');
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
    client.setDaemonId(daemonId);
    const leaveMessage = {
      type: 'leave',
      requestId: `leave-${Date.now()}`,
      payload: {
        clientId: getClientId(),
        reason,
      },
    };

    try {
      console.log('[mobile] sending leave message', { reason, daemonId });
      await Promise.race([
        client.sendMessage(leaveMessage, daemonId),
        new Promise(resolve => setTimeout(resolve, 500)), // Max wait 500ms
      ]);
      console.log('[mobile] leave message sent', { reason });
    } catch (error) {
      console.log('[mobile] leave message failed', { reason, error: error?.message });
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

    client.setDaemonId(daemonId);
    await client.sendMessage(
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
    console.log(`[mobile_client] status update: state=${state} message=${message}`);
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

    void client.sendMessage(resolveMessage)
      .then(() => {
        setClientState('daemonConnecting', `Resolve sent to daemon "${getDaemonId()}". Waiting for response...`);
        log(`Resolve sent to daemon "${getDaemonId()}".`);
      })
      .catch((error) => {
        log(`Resolve send failed: ${error.message}`);
        console.warn('[mobile_client] Resolve send failed', {
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

  async function flushPendingDragMove() {
    if (!pendingMoveEvent || moveSendInFlight) {
      return;
    }

    const eventToSend = pendingMoveEvent;
    const extraToSend = pendingMoveExtra || { isDragging: true };
    pendingMoveEvent = null;
    pendingMoveExtra = null;
    moveSendInFlight = true;

    try {
      log(`[DRAG] Flushing: (${eventToSend.clientX}, ${eventToSend.clientY}), extra=${JSON.stringify(extraToSend)}`);
      await sendMappedMouseCommand('mouse_move', eventToSend, extraToSend);
    } catch (err) {
      log(`[DRAG] Error flushing: ${err.message}`);
      // Keep drag move lightweight.
    } finally {
      moveSendInFlight = false;
      if (pendingMoveEvent) {
        log(`[DRAG] Another event queued, scheduling flush`);
        scheduleDragMoveFlush();
      }
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

    const sourceWidth = Math.max(1, Number(el.remoteVideo.videoWidth || viewState.sourceWidth || 1));
    const sourceHeight = Math.max(1, Number(el.remoteVideo.videoHeight || viewState.sourceHeight || 1));
    const renderedWidth = Math.max(1, el.remoteVideo.clientWidth || container.clientWidth || sourceWidth);
    const renderedHeight = Math.max(1, el.remoteVideo.clientHeight || container.clientHeight || sourceHeight);

    // Calculate centering offset for letterboxing (aspect ratio mismatch)
    const containerAspect = renderedWidth / renderedHeight;
    const sourceAspect = sourceWidth / sourceHeight;
    let contentWidth = renderedWidth;
    let contentHeight = renderedHeight;

    if (Number.isFinite(containerAspect) && Number.isFinite(sourceAspect) && sourceWidth > 0 && sourceHeight > 0) {
      if (sourceAspect > containerAspect) {
        // Source is wider: vertical letterbox (top/bottom black bars)
        contentHeight = renderedWidth / sourceAspect;
      } else {
        // Source is taller: horizontal letterbox (left/right black bars)
        contentWidth = renderedHeight * sourceAspect;
      }
    }

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
      console.debug('[sendMappedMouseCommand] mouse_move', {
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
        },
      });
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
    return Boolean(connected && el.remoteVideo?.srcObject);
  }

  async function sendTextInput(text) {
    if (!text) {
      return;
    }

    if (!isControlReady()) {
      log('Skip text_input: remote stream is not ready.');
      return;
    }

    const requestId = await client.sendCommand('text_input', { text });
    log(`text_input sent (${requestId}): ${JSON.stringify(text)}`);
  }

  async function sendKeyPress(key) {
    if (!isControlReady()) {
      log('Skip key_press: remote stream is not ready.');
      return;
    }

    const requestId = await client.sendCommand('key_press', { key });
    log(`key_press sent (${requestId}): ${key}`);
  }

  const sendMouseCommand = createViewerMouseCommandSender({
    sendCommand: async (type, payload) => {
      if (!isControlReady()) {
        log(`Skip ${type}: remote stream is not ready.`);
        return `skipped-${type}-${Date.now()}`;
      }
      return client.sendCommand(type, payload);
    },
    videoElement: el.remoteVideo,
    getIsDragging: () => isMousePressed,
    onPointerMapped: (mapped, { type, pointerEvent, extraPayload }) => {
      if (type === 'mouse_click') {
        const viewportInfo = getViewportMappingPayload();
        log(
          `[DEBUG] ${type} - raw: (${Math.round(pointerEvent.clientX)}, ${Math.round(pointerEvent.clientY)}) ` +
          `mapped: (${mapped.x}, ${mapped.y}) ` +
          `source: ${mapped.sourceWidth}x${mapped.sourceHeight} ` +
          `content: ${Math.round(mapped.contentRect.width)}x${Math.round(mapped.contentRect.height)} ` +
          `offset: (${mapped.contentRect.offsetX}, ${mapped.contentRect.offsetY}) ` +
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

  client.onRemoteStream = (stream) => {
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

  client.onSignalingConnected = ({ uid, host }) => {
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

  client.onDisconnect = () => {
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
    setClientState('owtDisconnected', 'Disconnected from signaling.');
    log('Disconnected from signaling server.');
  };

  client.onMessage = ({ origin, message }) => {
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
          client.setDaemonId(daemonId);
        }
        daemonReadyHint = true;
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
      if (parsed.type === 'resolve_ack') {
        resolveAcked = true;
        resolveInFlight = false;
        clearResolveRetryTimer();
        setClientState('daemonConnected', 'Resolve acknowledged by daemon. Waiting for result...');
        log(`Resolve acknowledged by daemon. Waiting for result...`);
        console.log('[mobile_client] resolve_ack received', { requestId: parsed.requestId });
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

        void client.disconnect().catch(() => {});
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
      touchPressPending = true;
      isMousePressed = false;
      log(`Touch start on VIDEO (pointer ${event.pointerId}): (${Math.round(event.clientX)}, ${Math.round(event.clientY)})`);
    } else {
      isMousePressed = true;
    }

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

    if (event.pointerType !== 'touch') {
      try {
        await sendMappedMouseCommand('mouse_down', event);
      } catch (error) {
        log(`mouse_down failed: ${error.message}`);
      }
    }
  });

  el.remoteVideo.addEventListener('pointermove', async (event) => {
    if (nativeScrollbarDrag && nativeScrollbarDrag.pointerId === event.pointerId) {
      return;
    }

    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }

    if (event.pointerType === 'touch' && touchPressPending && activePointerStart) {
      const dx = event.clientX - activePointerStart.x;
      const dy = event.clientY - activePointerStart.y;
      if (Math.hypot(dx, dy) >= 6) {
        touchPressPending = false;
        isMousePressed = true;
        remoteDragMoved = true;
        try {
          await sendMappedMouseCommand('mouse_down', event);
        } catch (error) {
          log(`mouse_down(touch-drag) failed: ${error.message}`);
        }
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

    if (wasTouch && touchPressPending) {
      touchPressPending = false;
      activePointerId = null;
      activePointerStart = null;
      isMousePressed = false;
      suppressTouchClick = true;

      if (currentSwipeTarget !== 'scrollbar') {
        try {
          await sendMappedMouseCommand('mouse_click', event);
        } catch (error) {
          log(`mouse_click(touch-tap) failed: ${error.message}`);
        }
      }
      return;
    }

    activePointerId = null;
    activePointerStart = null;
    isMousePressed = false;
    touchPressPending = false;
    await flushPendingDragMove();

    // Only send to daemon if touch was on video, not on scrollbar
    if (currentSwipeTarget !== 'scrollbar' || !wasTouch) {
      try {
        await sendMappedMouseCommand('mouse_up', event, { isDragging: false });
      } catch (error) {
        log(`mouse_up failed: ${error.message}`);
      }
    } else {
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
      if (event.pointerType === 'touch') {
        touchPressPending = false;
      }
      clearPendingDragMove();
      return;
    }

    activePointerId = null;
    activePointerStart = null;
    isMousePressed = false;
    touchPressPending = false;
    await flushPendingDragMove();

    // Only send to daemon if touch was on video
    if (currentSwipeTarget !== 'scrollbar' || event.pointerType !== 'touch') {
      try {
        await sendMappedMouseCommand('mouse_up', event, { isDragging: false });
      } catch (error) {
        log(`mouse_up(cancel) failed: ${error.message}`);
      }
    }
  });

  el.remoteVideo.addEventListener('click', async (event) => {
    if (suppressTouchClick) {
      suppressTouchClick = false;
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
    try {
      const videoRect = el.remoteVideo.getBoundingClientRect();
      log(
        `[DEBUG] click event - pointerType: ${event.pointerType} ` +
        `raw coords: (${Math.round(event.clientX)}, ${Math.round(event.clientY)}) ` +
        `video rect: (${Math.round(videoRect.left)}, ${Math.round(videoRect.top)}) ` +
        `video size: ${Math.round(videoRect.width)}x${Math.round(videoRect.height)} ` +
        `video source: ${el.remoteVideo.videoWidth}x${el.remoteVideo.videoHeight}`
      );
      await sendMappedMouseCommand('mouse_click', event);
    } catch (error) {
      log(`mouse_click failed: ${error.message}`);
    }
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
      try {
        await sendFinishMessage('button_click');
        setClientState('daemonInteraction', `Finish sent to daemon "${getDaemonId()}".`);
        log(`Finish sent to daemon "${getDaemonId()}".`);
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
    console.log('[mobile-client] p2p connect config', {
      signalingServer: getSignalingUrl(),
      daemonId: getDaemonId(),
      clientId: getClientId(),
      ...summarizeIceConfigForLog(rtcOptions),
    });

    client.connect({
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

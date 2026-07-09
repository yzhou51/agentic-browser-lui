import {
  AgenticBrowserClient,
  createViewerMouseCommandSender,
} from '../sdk/index.js';
import { normalizeRtcIceOptions, parseRtcIceServersJson } from '../sdk/rtcConfig.js';

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
  let resolvePromise = null;
  let resolveAttempts = 0;
  let resolveRetryTimer = null;
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
  const maxResolveAttempts = 5;

  const el = {
    status: document.getElementById('status'),
    remotePanel: document.querySelector('.mobile-remote-panel'),
    remoteVideo: document.getElementById('remoteVideo'),
    hScrollOverlay: document.getElementById('hScrollOverlay'),
    hScrollThumb: document.getElementById('hScrollThumb'),
    vScrollOverlay: document.getElementById('vScrollOverlay'),
    vScrollThumb: document.getElementById('vScrollThumb'),
    keyboardFab: document.getElementById('keyboardFab'),
    keyboardCapture: document.getElementById('keyboardCapture'),
    logs: document.getElementById('logs'),
  };

  const viewState = {
    scalePercent: 100,
    sourceWidth: 1280,
    sourceHeight: 720,
  };

  function readParam(name, fallback = '') {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(name);
    return value && String(value).trim() ? String(value).trim() : fallback;
  }

  function readParamAny(names, fallback = '') {
    const params = new URLSearchParams(window.location.search);
    for (const name of names) {
      const value = params.get(name);
      if (value && String(value).trim()) {
        return String(value).trim();
      }
    }
    return fallback;
  }

  function readPercentParam(names, fallback = 100) {
    const params = new URLSearchParams(window.location.search);
    for (const name of names) {
      const raw = params.get(name);
      if (!raw) {
        continue;
      }

      const parsed = Number.parseFloat(String(raw).replace('%', ''));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
  }

  function hasAnyParam(names) {
    const params = new URLSearchParams(window.location.search);
    return names.some((name) => {
      const value = params.get(name);
      return value && String(value).trim();
    });
  }

  const envSignalingServer = readParam('signalingUrl', runtimeConfig.signalingServer || import.meta.env?.SIGNALING_SERVER || window.location.origin);
  const envClientId = readParam('clientId', runtimeConfig.clientId || import.meta.env?.CLIENT_ID || 'client-1');
  const envDaemonId = readParam('remoteId', runtimeConfig.daemonId || import.meta.env?.DAEMON_ID || 'daemon-1');
  const paramStunUrls = readParamAny(['stunUrls', 'STUN_SERVER_URLS'], '');
  const paramTurnUrls = readParamAny(['turnUrls', 'TURN_SERVER_URLS'], '');
  const paramTurnUsername = readParamAny(['turnUsername', 'turnUserName', 'turnUser', 'TURN_USERNAME'], '');
  const paramTurnCredential = readParamAny(['turnCredential', 'turnPassword', 'TURN_CREDENTIAL', 'TURN_PASSWORD'], '');
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
  const hasScaleParam = hasAnyParam(['scrollRate', 'viewScale', 'scale']);
  const envScale = readPercentParam(['scrollRate', 'viewScale', 'scale'], 100);
  const envFitValue = readParam('fit', '').toLowerCase();
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

  function getSignalingUrl() {
    return String(envSignalingServer || '').trim();
  }

  function getRtcConnectOptions() {
    return envIceConfig;
  }

  function summarizeIceConfigForLog(rtcOptions) {
    const iceServers = Array.isArray(rtcOptions?.rtcIceServers) ? rtcOptions.rtcIceServers : [];
    const stunUrls = iceServers
      .flatMap((entry) => (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]))
      .filter((url) => /^stuns?:/i.test(String(url || '').trim()));
    const turnUrls = iceServers
      .flatMap((entry) => (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]))
      .filter((url) => /^turns?:/i.test(String(url || '').trim()));
    const firstTurnServer = iceServers.find((entry) => {
      const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
      return urls.some((url) => /^turns?:/i.test(String(url || '').trim()));
    });

    return {
      stunUrls,
      turnUrls,
      turnUsername: firstTurnServer?.username || '',
      hasTurnCredential: Boolean(firstTurnServer?.credential),
      iceServerCount: iceServers.length,
    };
  }

  function setStatus(state, message) {
    el.status.dataset.state = state;
    el.status.textContent = message;
  }

  function clearResolveRetryTimer() {
    if (resolveRetryTimer) {
      window.clearTimeout(resolveRetryTimer);
      resolveRetryTimer = null;
    }
  }

  async function sendResolve(reason = 'unspecified') {
    if (!connected || resolveSent || resolvePromise) {
      return;
    }

    if (resolveAttempts >= maxResolveAttempts) {
      setStatus('error', `Resolve not acknowledged after ${maxResolveAttempts} attempts.`);
      log(`Resolve stopped after ${maxResolveAttempts} attempts.`);
      return;
    }

    resolveAttempts += 1;
    const resolveMessage = {
      type: 'resolve',
      requestId: `resolve-${Date.now()}-${resolveAttempts}`,
      payload: {
        clientId: getClientId(),
      },
    };

    setStatus('connecting', `Sending Resolve to daemon "${getDaemonId()}" (attempt ${resolveAttempts}/${maxResolveAttempts})...`);
    log(`Resolve send requested (${reason}) attempt ${resolveAttempts}: ${JSON.stringify(resolveMessage)}`);

    resolvePromise = client.sendMessage(resolveMessage)
      .then(() => {
        setStatus('connecting', `Resolve sent to daemon "${getDaemonId()}". Waiting for response...`);
        log(`Resolve sent to daemon "${getDaemonId()}".`);
      })
      .catch((error) => {
        log(`Resolve send failed: ${error.message}`);
      })
      .finally(() => {
        resolvePromise = null;

        if (!resolveSent && resolveAttempts < maxResolveAttempts) {
          clearResolveRetryTimer();
          resolveRetryTimer = window.setTimeout(() => {
            void sendResolve('retry-timer');
          }, 1800);
        }
      });
  }

  function log(message) {
    if (el.logs) {
      el.logs.textContent += `${message}\n`;
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
    const panel = el.remoteVideo?.closest('.mobile-remote-panel');
    if (!panel || !el.keyboardFab) {
      return { left, top };
    }

    const panelRect = panel.getBoundingClientRect();
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
    const sourcePerCssX = sourceWidth / renderedWidth;
    const sourcePerCssY = sourceHeight / renderedHeight;

    return {
      viewScrollLeft: Math.max(0, Math.round(container.scrollLeft * sourcePerCssX)),
      viewScrollTop: Math.max(0, Math.round(container.scrollTop * sourcePerCssY)),
      viewWidth: Math.max(1, Math.round(container.clientWidth * sourcePerCssX)),
      viewHeight: Math.max(1, Math.round(container.clientHeight * sourcePerCssY)),
      viewSourceWidth: sourceWidth,
      viewSourceHeight: sourceHeight,
    };
  }

  async function sendMappedMouseCommand(type, event, extraPayload = {}) {
    return sendMouseCommand(type, event, {
      ...getViewportMappingPayload(),
      ...extraPayload,
    });
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
    onAfterSend: ({ type, requestId }) => {
      log(`${type} sent (${requestId}).`);
    },
  });

  client.onRemoteStream = (stream) => {
    if (stream?.mediaStream) {
      el.remoteVideo.srcObject = stream.mediaStream;
      el.remoteVideo.play().catch(() => {});
      setStatus('active', 'Connected and receiving remote stream.');
      log('Remote stream attached.');
      return;
    }

    log('Remote stream event received without mediaStream.');
  };

  client.onDataChannelOpen = ({ label }) => {
    if (label !== 'message') {
      return;
    }
    if (!resolveSent) {
      setStatus('connecting', `Data channel connected for daemon "${getDaemonId()}".`);
      log('Data channel connected. Pending Resolve should flush now.');
      void sendResolve('data-channel-open');
    }
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
    resolveSent = false;
    resolvePromise = null;
    resolveAttempts = 0;
    clearResolveRetryTimer();
    setStatus('idle', 'Disconnected from signaling.');
    log('Disconnected from signaling server.');
  };

  client.onMessage = ({ origin, message }) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'resolve_result') {
        const ok = parsed.ok !== false;
        if (ok) {
          resolveSent = true;
          clearResolveRetryTimer();
        }
        setStatus(ok ? 'active' : 'error', ok ? 'Resolve processed. Daemon is starting screen share.' : `Resolve failed: ${parsed.error || 'unknown error'}`);
        log(`Resolve result: ${ok ? 'ok' : 'failed'} ${parsed.error ? `(${parsed.error})` : ''}`);
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

    log(`Message from "${origin}": ${message}`);
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

    if (swipeStart && event.pointerType === 'touch' && swipeTarget === 'video') {
      const currentDist = Math.hypot(event.clientX - swipeStart.x, event.clientY - swipeStart.y);
      if (currentDist > 8) {
        log(`Touch move on VIDEO: (${Math.round(event.clientX)}, ${Math.round(event.clientY)}) dist=${Math.round(currentDist)}`);
      }
    }

    if (activePointerStart) {
      const dx = event.clientX - activePointerStart.x;
      const dy = event.clientY - activePointerStart.y;
      if (Math.hypot(dx, dy) >= 3) {
        remoteDragMoved = true;
      }
    }

    try {
      await sendMappedMouseCommand('mouse_move', event, { isDragging: true });
    } catch {
      // Keep drag move lightweight.
    }
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
      return;
    }

    activePointerId = null;
    activePointerStart = null;
    isMousePressed = false;
    touchPressPending = false;

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

  setStatus('connecting', `Connecting to signaling for daemon "${getDaemonId()}"...`);
  log(`Auto-connecting to signaling server "${getSignalingUrl()}" for daemon "${getDaemonId()}".`);

  try {
    const rtcOptions = getRtcConnectOptions();
    console.log('[mobile-client] p2p connect config', {
      signalingServer: getSignalingUrl(),
      daemonId: getDaemonId(),
      clientId: getClientId(),
      ...summarizeIceConfigForLog(rtcOptions),
    });

    await client.connect({
      signalingHost: getSignalingUrl(),
      clientId: getClientId(),
      daemonId: getDaemonId(),
      forceReconnect: true,
      ...rtcOptions,
    });
    connected = true;
    resolveAttempts = 0;
    clearResolveRetryTimer();
    setStatus('connected', `Connected to signaling for daemon "${getDaemonId()}". Waiting for data channel...`);
    log('Connected to signaling and daemon peer endpoint.');
    void sendResolve('connect-success');
  } catch (error) {
    setStatus('error', `Connect failed: ${error.message}`);
    log(`Connect failed: ${error.message}`);
    return;
  }

  applyViewScale(viewState.scalePercent);
  updateHorizontalScrollbar();
  updateVerticalScrollbar();
}

init();

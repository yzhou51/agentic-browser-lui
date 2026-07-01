import { AgenticBrowserClient } from '../sdk/index.js';

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

  const el = {
    clientId: document.getElementById('clientId'),
    daemonId: document.getElementById('daemonId'),
    signalingUrl: document.getElementById('signalingUrl'),
    targetUrl: document.getElementById('targetUrl'),
    status: document.getElementById('status'),
    connectBtn: document.getElementById('connectBtn'),
    launchChromeBtn: document.getElementById('launchChromeBtn'),
    openUrlBtn: document.getElementById('openUrlBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    remoteVideo: document.getElementById('remoteVideo'),
    textCapture: document.getElementById('textCapture'),
    closePageBtn: document.getElementById('closePageBtn'),
    exitChromeBtn: document.getElementById('exitChromeBtn'),
    textInput: document.getElementById('textInput'),
    sendTextBtn: document.getElementById('sendTextBtn'),
    logs: document.getElementById('logs'),
  };

  const envSignalingServer = runtimeConfig.signalingServer || window.location.origin || import.meta.env?.SIGNALING_SERVER;
  const envClientId = runtimeConfig.clientId || import.meta.env?.CLIENT_ID;
  const envDaemonId = runtimeConfig.daemonId || import.meta.env?.DAEMON_ID;

  if (envSignalingServer) {
    el.signalingUrl.value = envSignalingServer;
  }
  if (envClientId) {
    el.clientId.value = envClientId;
  }
  if (envDaemonId) {
    el.daemonId.value = envDaemonId;
  }

  function log(message) {
    el.logs.textContent += `${message}\n`;
  }

  function setStatus(state, message) {
    el.status.dataset.state = state;
    el.status.textContent = message;
  }

  async function sendTextInput(text) {
    if (!text) {
      return;
    }

    const requestId = await client.sendCommand('text_input', { text });
    log(`text_input sent (${requestId}): ${JSON.stringify(text)}`);
  }

  async function sendKeyPress(key) {
    const requestId = await client.sendCommand('key_press', { key });
    log(`key_press sent (${requestId}): ${key}`);
  }

  function getRenderedVideoContentRect() {
    const rect = el.remoteVideo.getBoundingClientRect();
    const sourceWidth = el.remoteVideo.videoWidth || rect.width;
    const sourceHeight = el.remoteVideo.videoHeight || rect.height;

    const containerAspect = rect.width / rect.height;
    const sourceAspect = sourceWidth / sourceHeight;

    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (Number.isFinite(containerAspect) && Number.isFinite(sourceAspect) && sourceWidth > 0 && sourceHeight > 0) {
      if (sourceAspect > containerAspect) {
        contentHeight = rect.width / sourceAspect;
        offsetY = (rect.height - contentHeight) / 2;
      } else {
        contentWidth = rect.height * sourceAspect;
        offsetX = (rect.width - contentWidth) / 2;
      }
    }

    return {
      rect,
      sourceWidth,
      sourceHeight,
      contentWidth,
      contentHeight,
      offsetX,
      offsetY,
      containerAspect,
      sourceAspect,
    };
  }

  function mapPointerToVideoSpace(event) {
    const videoBox = getRenderedVideoContentRect();
    const localX = event.clientX - videoBox.rect.left - videoBox.offsetX;
    const localY = event.clientY - videoBox.rect.top - videoBox.offsetY;

    const clampedX = Math.max(0, Math.min(videoBox.contentWidth - 1, localX));
    const clampedY = Math.max(0, Math.min(videoBox.contentHeight - 1, localY));

    const x = Math.max(0, Math.min(videoBox.sourceWidth - 1, Math.round((clampedX / videoBox.contentWidth) * videoBox.sourceWidth)));
    const y = Math.max(0, Math.min(videoBox.sourceHeight - 1, Math.round((clampedY / videoBox.contentHeight) * videoBox.sourceHeight)));

    const mapped = {
      x,
      y,
      sourceWidth: videoBox.sourceWidth,
      sourceHeight: videoBox.sourceHeight,
      videoRect: {
        width: Math.round(videoBox.rect.width),
        height: Math.round(videoBox.rect.height),
      },
      contentRect: {
        width: Math.round(videoBox.contentWidth),
        height: Math.round(videoBox.contentHeight),
        offsetX: Math.round(videoBox.offsetX),
        offsetY: Math.round(videoBox.offsetY),
      },
      pointer: {
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY),
      },
    };

    console.debug('[client] pointer mapped', mapped);
    return mapped;
  }

  client.onRemoteStream = (stream) => {
    if (stream?.mediaStream) {
      el.remoteVideo.srcObject = stream.mediaStream;
      el.remoteVideo.play().catch(() => {});
      setStatus('active', `Connected to daemon ${el.daemonId.value} and receiving remote stream.`);
      log('Remote stream attached.');
    }
  };

  client.onMessage = ({ origin, message }) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'command_result') {
        setStatus('active', `Connected to daemon ${origin}. Last command result received.`);
        log(
          `Result ${parsed.requestId || 'n/a'} from ${origin}: ${parsed.ok ? 'ok' : 'failed'} ` +
          `${parsed.error ? `(${parsed.error})` : ''}`
        );
        return;
      }
    } catch {
      // Keep compatibility with plain text messages.
    }
    setStatus('active', `Connected to daemon ${origin}. Message received.`);
    log(`Message from ${origin}: ${message}`);
  };

  el.connectBtn.addEventListener('click', async () => {
    setStatus('connecting', `Connecting to daemon ${el.daemonId.value} via ${el.signalingUrl.value}...`);
    try {
      await client.connect({
        signalingHost: el.signalingUrl.value,
        clientId: el.clientId.value,
        daemonId: el.daemonId.value,
      });
      setStatus('connected', `Connected to signaling. Waiting for daemon ${el.daemonId.value} activity.`);
      log('Connected to signaling and daemon peer endpoint.');
    } catch (error) {
      setStatus('error', `Connect failed: ${error.message}`);
      log(`Connect failed: ${error.message}`);
    }
  });

  el.launchChromeBtn.addEventListener('click', async () => {
    try {
      const requestId = await client.sendCommand('launch_chrome');
      log(`launch_chrome sent (${requestId}).`);
    } catch (error) {
      log(`launch_chrome failed: ${error.message}`);
    }
  });

  el.openUrlBtn.addEventListener('click', async () => {
    try {
      const requestId = await client.sendCommand('open_url', { url: el.targetUrl.value });
      log(`open_url sent (${requestId}): ${el.targetUrl.value}`);
    } catch (error) {
      log(`open_url failed: ${error.message}`);
    }
  });

  el.disconnectBtn.addEventListener('click', async () => {
    await client.disconnect();
    setStatus('idle', 'Disconnected. Not connected to daemon.');
    log('Disconnected.');
  });

  el.closePageBtn.addEventListener('click', async () => {
    try {
      const requestId = await client.sendCommand('close_page');
      log(`close_page sent (${requestId}).`);
    } catch (error) {
      log(`close_page failed: ${error.message}`);
    }
  });

  el.exitChromeBtn.addEventListener('click', async () => {
    try {
      const requestId = await client.sendCommand('exit_chrome');
      log(`exit_chrome sent (${requestId}).`);
    } catch (error) {
      log(`exit_chrome failed: ${error.message}`);
    }
  });

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

  el.remoteVideo.addEventListener('click', async (event) => {
    event.preventDefault();
    el.textCapture.value = '';
    el.textCapture.focus();
    el.textCapture.setSelectionRange(0, 0);
    log('Remote viewer clicked. Text capture is active.');

    const { x, y, sourceWidth, sourceHeight } = mapPointerToVideoSpace(event);

    console.debug('[client] remoteVideo click', {
      x,
      y,
      sourceWidth,
      sourceHeight,
      videoWidth: el.remoteVideo.videoWidth,
      videoHeight: el.remoteVideo.videoHeight,
    });

    try {
      const requestId = await client.sendCommand('mouse_click', {
        x,
        y,
        button: 'left',
        sourceWidth,
        sourceHeight,
      });
      log(`mouse_click sent (${requestId}) at (${x}, ${y}) in ${sourceWidth}x${sourceHeight}.`);
    } catch (error) {
      log(`mouse_click failed: ${error.message}`);
    }
  });

  el.remoteVideo.addEventListener('mousemove', async (event) => {
    if ((event.timeStamp | 0) % 7 !== 0) {
      return;
    }
    const { x, y, sourceWidth, sourceHeight } = mapPointerToVideoSpace(event);

    console.debug('[client] remoteVideo move', {
      x,
      y,
      sourceWidth,
      sourceHeight,
      videoWidth: el.remoteVideo.videoWidth,
      videoHeight: el.remoteVideo.videoHeight,
    });

    try {
      await client.sendCommand('mouse_move', { x, y, sourceWidth, sourceHeight });
    } catch {
      // Keep cursor movement lightweight and silent on temporary send errors.
    }
  });

  el.remoteVideo.addEventListener('focus', () => {
    log('Remote viewer focused. Click the viewer to activate text capture.');
  });
}

init();

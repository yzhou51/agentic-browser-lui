import { formatIceUrls, normalizeRtcIceOptions, parseRtcIceServersJson } from '../sdk/rtcConfig.js';

async function loadRuntimeConfig() {
  try {
    const response = await fetch('/agent-demo.runtime.json', { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    const config = await response.json();
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

function normalizeDaemonApiBase(url) {
  const value = String(url || '').trim();
  if (!value) {
    return 'http://localhost:8788';
  }

  if (!/^https?:\/\//i.test(value)) {
    return `http://${value}`.replace(/\/+$/, '');
  }

  return value.replace(/\/+$/, '');
}

function parseChromeParamsInput(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Chrome params must be a JSON array.');
  }
  return parsed;
}

async function init() {
  const runtimeConfig = await loadRuntimeConfig();
  const actionChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('agentic-browser-action')
    : null;

  const el = {
    clientId: document.getElementById('clientId'),
    daemonId: document.getElementById('daemonId'),
    signalingUrl: document.getElementById('signalingUrl'),
    stunUrls: document.getElementById('stunUrls'),
    turnUrls: document.getElementById('turnUrls'),
    turnUsername: document.getElementById('turnUsername'),
    turnCredential: document.getElementById('turnCredential'),
    daemonApiUrl: document.getElementById('daemonApiUrl'),
    sessionId: document.getElementById('sessionId'),
    sessionTimeout: document.getElementById('sessionTimeout'),
    chromePath: document.getElementById('chromePath'),
    chromeParams: document.getElementById('chromeParams'),
    targetUrl: document.getElementById('targetUrl'),
    snapshotFullPage: document.getElementById('snapshotFullPage'),
    status: document.getElementById('status'),
    startSessionBtn: document.getElementById('startSessionBtn'),
    launchChromeBtn: document.getElementById('launchChromeBtn'),
    closeChromeBtn: document.getElementById('closeChromeBtn'),
    openUrlBtn: document.getElementById('openUrlBtn'),
    takeActionBtn: document.getElementById('takeActionBtn'),
    snapshotBtn: document.getElementById('snapshotBtn'),
    stopShareBtn: document.getElementById('stopShareBtn'),
    snapshotMeta: document.getElementById('snapshotMeta'),
    snapshotImage: document.getElementById('snapshotImage'),
    logs: document.getElementById('logs'),
  };

  let lastSnapshotObjectUrl = '';

  const envSignalingServer = runtimeConfig.signalingServer || import.meta.env?.SIGNALING_SERVER || window.location.origin;
  const envClientId = runtimeConfig.clientId || import.meta.env?.CLIENT_ID;
  const envDaemonId = runtimeConfig.daemonId || import.meta.env?.DAEMON_ID;
  const envIceConfig = normalizeRtcIceOptions({
    ...runtimeConfig,
    stunUrls: runtimeConfig.stunUrls ?? import.meta.env?.STUN_SERVER_URLS,
    turnUrls: runtimeConfig.turnUrls ?? import.meta.env?.TURN_SERVER_URLS,
    turnUsername: runtimeConfig.turnUsername ?? import.meta.env?.TURN_USERNAME,
    turnCredential: runtimeConfig.turnCredential ?? import.meta.env?.TURN_CREDENTIAL,
    rtcIceServers: Array.isArray(runtimeConfig.rtcIceServers) && runtimeConfig.rtcIceServers.length
      ? runtimeConfig.rtcIceServers
      : parseRtcIceServersJson(import.meta.env?.RTC_ICE_SERVERS_JSON),
  });

  if (envSignalingServer) {
    el.signalingUrl.value = envSignalingServer;
  }
  if (envClientId) {
    el.clientId.value = envClientId;
  }
  if (envDaemonId) {
    el.daemonId.value = envDaemonId;
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
  if (!el.daemonApiUrl.value) {
    el.daemonApiUrl.value = 'http://localhost:8788';
  }

  function getRtcConfigFields() {
    const rtcOptions = normalizeRtcIceOptions({
      stunUrls: el.stunUrls.value,
      turnUrls: el.turnUrls.value,
      turnUsername: el.turnUsername.value,
      turnCredential: el.turnCredential.value,
    });

    return {
      stunUrls: rtcOptions.stunUrls,
      turnUrls: rtcOptions.turnUrls,
      turnUsername: rtcOptions.turnUsername,
      turnCredential: rtcOptions.turnCredential,
      rtcIceServers: rtcOptions.rtcIceServers,
    };
  }

  function setStatus(state, message) {
    el.status.dataset.state = state;
    el.status.textContent = message;
  }

  function log(message) {
    el.logs.textContent += `${message}\n`;
  }

  async function callDaemonApi(path, body = {}) {
    const endpoint = `${normalizeDaemonApiBase(el.daemonApiUrl.value)}${path}`;
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `Cannot reach daemon API at ${endpoint}. ` +
        'Check daemon is running, Daemon Server address is correct, and browser can access that host/port. ' +
        `Original error: ${error.message}`
      );
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `API call failed: ${path}`);
    }
    return payload;
  }

  async function callDaemonSnapshot(path, body) {
    const endpoint = `${normalizeDaemonApiBase(el.daemonApiUrl.value)}${path}`;
    const isGet = body === undefined;
    let response;

    try {
      response = await fetch(endpoint, {
        method: isGet ? 'GET' : 'POST',
        headers: isGet
          ? undefined
          : {
              'Content-Type': 'application/json',
            },
        body: isGet ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `Cannot reach daemon API at ${endpoint}. ` +
        'Check daemon is running, Daemon Server address is correct, and browser can access that host/port. ' +
        `Original error: ${error.message}`
      );
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Snapshot API call failed.');
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('image/png')) {
      throw new Error(`Snapshot API returned unexpected content-type: ${contentType || 'unknown'}`);
    }

    const blob = await response.blob();
    const targetUrl = response.headers.get('X-Snapshot-Target-Url') || '';
    return { blob, targetUrl };
  }

  function applySnapshotResult(blob, targetUrl) {
    if (lastSnapshotObjectUrl) {
      URL.revokeObjectURL(lastSnapshotObjectUrl);
    }

    lastSnapshotObjectUrl = URL.createObjectURL(blob);
    el.snapshotImage.src = lastSnapshotObjectUrl;
    el.snapshotImage.style.display = 'block';

    const now = new Date();
    const sizeKb = (blob.size / 1024).toFixed(1);
    const fileName = `target-snapshot-${now.toISOString().replace(/[:.]/g, '-')}.png`;
    const targetText = targetUrl ? ` target=${targetUrl}` : '';

    el.snapshotMeta.textContent = `Latest snapshot: ${fileName} (${sizeKb} KB).${targetText}`;
    log(`snapshot captured: ${fileName}, size=${sizeKb} KB${targetText}`);

    const downloadLink = document.createElement('a');
    downloadLink.href = lastSnapshotObjectUrl;
    downloadLink.download = fileName;
    downloadLink.click();
  }

  el.launchChromeBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Launching Chrome...');
    try {
      const params = parseChromeParamsInput(el.chromeParams.value);
      await callDaemonApi('/api/v1/chrome/launch', {
        chrome: el.chromePath.value,
        params,
      });
      setStatus('connected', 'Launch Chrome request sent successfully.');
      log('launch_chrome requested via daemon REST API.');
    } catch (error) {
      setStatus('error', `Launch chrome failed: "${error.message}"`);
      log(`launch_chrome API failed: ${error.message}`);
    }
  });

  el.startSessionBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Starting unified session...');
    try {
      const rtc = getRtcConfigFields();
      const chromeParams = parseChromeParamsInput(el.chromeParams.value);
      const payload = {
        daemonId: String(el.daemonId.value || '').trim(),
        clientId: String(el.clientId.value || '').trim(),
        targetUrl: String(el.targetUrl.value || '').trim(),
        signalingServer: String(el.signalingUrl.value || '').trim(),
        stunUrls: rtc.stunUrls,
        turnUrls: rtc.turnUrls,
        turnUsername: rtc.turnUsername,
        turnCredential: rtc.turnCredential,
        chrome: String(el.chromePath.value || '').trim(),
        chromeParams,
      };

      const sessionId = String(el.sessionId?.value || '').trim();
      if (sessionId) {
        payload.sessionId = sessionId;
      }

      const timeoutText = String(el.sessionTimeout?.value || '').trim();
      if (timeoutText) {
        const timeoutValue = Number(timeoutText);
        if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) {
          throw new Error('Session timeout must be a positive number (seconds).');
        }
        payload.timeout = Math.floor(timeoutValue);
      }

      const response = await callDaemonApi('/api/v1/session/start', payload);
      const finalSessionId = String(response.sessionId || sessionId || '');
      if (finalSessionId && el.sessionId) {
        el.sessionId.value = finalSessionId;
      }

      setStatus('connected', 'Session started and waiting flow completed (connected + resolve received).');
      log(`session_start requested via daemon REST API. sessionId=${finalSessionId || 'n/a'}`);
      log(`session_start commandIds=${JSON.stringify(response.commandIds || [])}`);
    } catch (error) {
      setStatus('error', `Start session failed: "${error.message}"`);
      log(`session_start API failed: ${error.message}`);
    }
  });

  el.closeChromeBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Stopping sharing and closing Chrome...');
    try {
      try {
        await callDaemonApi('/api/v1/share/stop', {});
        log('share_stop requested via daemon REST API before exit_chrome.');
      } catch (stopError) {
        // Close should still proceed even if share-stop is unavailable.
        log(`share_stop before close failed, proceeding to exit_chrome: ${stopError.message}`);
      }

      await callDaemonApi('/api/v1/chrome/exit', {});
      setStatus('connected', 'Stop sharing and close Chrome requests sent successfully.');
      log('exit_chrome requested via daemon REST API.');
    } catch (error) {
      setStatus('error', `Close chrome failed: "${error.message}"`);
      log(`exit_chrome API failed: ${error.message}`);
    }
  });

  el.openUrlBtn.addEventListener('click', async () => {
    setStatus('connecting', `Opening target page "${el.targetUrl.value}"...`);
    try {
      const request = {
        daemonId: el.daemonId.value,
        clientId: el.clientId.value,
        signalingServer: el.signalingUrl.value,
        targetUrl: el.targetUrl.value,
        ...getRtcConfigFields(),
      };

      await callDaemonApi('/api/v1/page/open', {
        name: 'agent-target',
        url: request.targetUrl,
        daemonId: request.daemonId,
        clientId: request.clientId,
        signalingServer: request.signalingServer,
        stunUrls: request.stunUrls,
        turnUrls: request.turnUrls,
        turnUsername: request.turnUsername,
        turnCredential: request.turnCredential,
      });
      setStatus('connected', `Open Target Page request sent for "${el.targetUrl.value}".`);
      log(`open_url requested via daemon REST API: ${el.targetUrl.value}`);
    } catch (error) {
      setStatus('error', `Open target failed: "${error.message}"`);
      log(`open_url API failed: ${error.message}`);
    }
  });

  el.takeActionBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Sending Take Action request...');
    try {
      const request = {
        daemonId: el.daemonId.value,
        clientId: el.clientId.value,
        signalingServer: el.signalingUrl.value,
        targetUrl: el.targetUrl.value,
        ...getRtcConfigFields(),
      };

      const response = await callDaemonApi('/api/v1/action/connect', request);
      const requestId = String(response.requestId || `action-${Date.now()}`);

      if (actionChannel) {
        actionChannel.postMessage({
          type: 'take_action',
          requestId,
          daemonId: request.daemonId,
          clientId: request.clientId,
          signalingServer: request.signalingServer,
          stunUrls: request.stunUrls,
          turnUrls: request.turnUrls,
          turnUsername: request.turnUsername,
          turnCredential: request.turnCredential,
          rtcIceServers: request.rtcIceServers,
          targetUrl: request.targetUrl,
          createdAt: new Date().toISOString(),
        });
      }

      setStatus('connected', 'Take Action request sent. Ask user to open Client page, connect, then click Resolve.');
      log(`take_action requested via daemon REST API. requestId=${requestId}`);
    } catch (error) {
      setStatus('error', `Take Action failed: "${error.message}"`);
      log(`take_action API failed: ${error.message}`);
    }
  });

  el.stopShareBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Stopping sharing...');
    try {
      await callDaemonApi('/api/v1/share/stop', {});
      setStatus('connected', 'Stop sharing request sent successfully. You can call Share Start again to re-share.');
      log('share_stop requested via daemon REST API.');
    } catch (error) {
      setStatus('error', `Stop sharing failed: "${error.message}"`);
      log(`share_stop API failed: ${error.message}`);
    }
  });

  el.snapshotBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Capturing target page snapshot...');
    try {
      const useFullPage = Boolean(el.snapshotFullPage?.checked);
      const requestBody = useFullPage ? { fullPage: true } : {};
      const { blob, targetUrl } = await callDaemonSnapshot('/api/v1/page/snapshot', requestBody);
      applySnapshotResult(blob, targetUrl);
      setStatus('connected', 'Snapshot captured successfully.');
    } catch (error) {
      setStatus('error', `Snapshot failed: "${error.message}"`);
      log(`snapshot API failed: ${error.message}`);
    }
  });
}

init();

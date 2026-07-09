import { formatIceUrls, normalizeRtcIceOptions, parseRtcIceServersJson } from '../sdk/rtcConfig.js';

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
    chromePath: document.getElementById('chromePath'),
    chromeParams: document.getElementById('chromeParams'),
    targetUrl: document.getElementById('targetUrl'),
    status: document.getElementById('status'),
    launchChromeBtn: document.getElementById('launchChromeBtn'),
    closeChromeBtn: document.getElementById('closeChromeBtn'),
    openUrlBtn: document.getElementById('openUrlBtn'),
    takeActionBtn: document.getElementById('takeActionBtn'),
    logs: document.getElementById('logs'),
  };

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

  el.closeChromeBtn.addEventListener('click', async () => {
    setStatus('connecting', 'Closing Chrome...');
    try {
      await callDaemonApi('/api/v1/chrome/exit', {});
      setStatus('connected', 'Close Chrome request sent successfully.');
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

      const response = await callDaemonApi('/api/v1/action/request', request);
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
}

init();

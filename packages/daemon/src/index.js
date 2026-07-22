import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { buildCli } from './cli.js';
import { BrowserController } from './daemon/browserController.js';
import { AgentControlBridge } from './daemon/agentControlBridge.js';
import { CommandProcessor } from './daemon/commandProcessor.js';
import { createToolModeRuntime, PutterMode, RemoteDevtoolsMode } from './daemon/toolMode.js';
import { createLogger } from './logger.js';
import { startStaticServer } from './server.js';
import { createPeerIds } from '../../client/src/sdk/peerIds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = createLogger('daemon-runtime');

const browser = new BrowserController({
  headless: config.browserHeadless,
  enableHeadlessCalibration: config.enableHeadlessCalibration,
  maxPageWidth: config.targetPageWidthMax,
  maxPageHeight: config.targetPageHeightMax,
});
const commands = new CommandProcessor(browser);
const agentBridge = new AgentControlBridge({
  initialState: {
    daemonId: config.daemonId,
    clientId: config.defaultClientId,
    signalingServer: config.signalingServer,
    stunUrls: config.stunUrls,
    turnUrls: config.turnUrls,
    turnUsername: config.turnUsername,
    turnCredential: config.turnCredential,
  },
});

const session = {
  daemonId: config.daemonId,
  clientId: config.defaultClientId,
  signalingServer: config.signalingServer,
  stunUrls: config.stunUrls,
  turnUrls: config.turnUrls,
  turnUsername: config.turnUsername,
  turnCredential: config.turnCredential,
  staticServerHost: config.staticServerHost,
  staticServerPort: config.staticServerPort,
  headless: config.browserHeadless,
};

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

function parseChromeParamsValue(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw;
  }

  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('chromeParams must be a JSON array.');
    }
    return parsed;
  }

  throw new Error('chromeParams must be a JSON array or JSON string array.');
}

function parseTimeoutSeconds(value, fallbackSeconds) {
  if (value === undefined || value === null || value === '') {
    return fallbackSeconds;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('timeout must be a positive number (seconds).');
  }

  return Math.floor(parsed);
}

function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeToolFlagName(name) {
  const raw = String(name || '').trim();
  if (!raw) {
    return '';
  }
  const base = raw.replace(/^-+/, '');
  return base.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseAweDaemonToolOptions(argv = []) {
  if (!Array.isArray(argv) || !argv.length) {
    return null;
  }

  if (!argv.some((arg) => String(arg || '').startsWith('--'))) {
    return null;
  }

  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) {
      continue;
    }

    const eqIndex = token.indexOf('=');
    const rawName = eqIndex === -1 ? token : token.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? '' : token.slice(eqIndex + 1);
    const key = normalizeToolFlagName(rawName);
    if (!key) {
      continue;
    }

    if (eqIndex !== -1) {
      options[key] = inlineValue;
      continue;
    }

    const next = index + 1 < argv.length ? String(argv[index + 1] || '') : '';
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  const payload = {
    targetUrl: options.targetUrl,
    sessionId: options.sessionId,
  };

  payload.sessionId = String(payload.sessionId || '').trim();

  if (payload.sessionId) {
    const derived = createPeerIds(payload.sessionId);
    payload.daemonId = payload.daemonId || derived.daemonId;
    payload.clientId = payload.clientId || derived.clientId;
  }

  if (!payload.daemonId || !payload.clientId || !payload.targetUrl) {
    return null;
  }

  if (options.timeout !== undefined) {
    payload.timeout = Number(options.timeout);
  }
  if (options.signalingServer !== undefined) {
    payload.signalingServer = String(options.signalingServer || '').trim();
  }
  if (options.stunUrls !== undefined) {
    payload.stunUrls = options.stunUrls;
  }
  if (options.turnUrls !== undefined) {
    payload.turnUrls = options.turnUrls;
  }
  if (options.turnUsername !== undefined) {
    payload.turnUsername = options.turnUsername;
  }
  if (options.turnCredential !== undefined) {
    payload.turnCredential = options.turnCredential;
  }
  if (options.chrome !== undefined) {
    payload.chrome = options.chrome;
  }
  if (options.remoteDebuggingPort !== undefined) {
    payload.remoteDebuggingPort = options.remoteDebuggingPort;
  }
  if (options.chromeParams !== undefined) {
    payload.chromeParams = options.chromeParams;
  }
  if (options.jsonCompact !== undefined) {
    payload.jsonCompact = Boolean(options.jsonCompact);
  }

  return payload;
}

function emitToolResult(data, { compact = false, isError = false } = {}) {
  const text = compact
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2);
  if (isError) {
    console.error(text);
    return;
  }
  console.log(text);
}

let clientMessageTimeoutHandle = null;
let currentClientMessageTimeoutMs = Number(config.clientMessageTimeoutMs || 120000);
let latestTimeoutSnapshot = {
  path: '',
  targetUrl: '',
  capturedAt: 0,
};
const sessionSnapshots = [];
const SESSION_STAGES = {
  START: 'start',
  LAUNCH_CHROME: 'lauch_chrome',
  OPEN_DAEMON_AGENT_PAGE: 'open_daemon_agent_page',
  OPEN_TARGET_PAGE: 'open_target_page',
  CONNECT_TO_SIGNAL_SERVER: 'connect_to_signalServer',
  WAIT_CLIENT_RESOLVE: 'wait_client_resolve',
  USER_INTERACTION: 'user_interaction',
  FINISH: 'finish',
};
const activeSession = {
  id: '',
  daemonId: '',
  clientId: '',
  targetUrl: '',
  timeoutMs: currentClientMessageTimeoutMs,
  stage: SESSION_STAGES.START,
  status: 'idle',
  statusMessage: '',
  outcome: '',
  connected: false,
  connectedAt: 0,
  resolved: false,
  startedAt: 0,
  lastResolveAt: 0,
  lastResolveFrom: '',
  lastFinishAt: 0,
  lastFinishFrom: '',
  completedAt: 0,
  snapshots: sessionSnapshots,
};
const sessionReadyWaiters = [];
const sessionCompletionWaiters = [];

function updateSessionProgress(stage, status, statusMessage = '') {
  activeSession.stage = stage;
  activeSession.status = status;
  activeSession.statusMessage = statusMessage;
}

function notifySessionCompletionWaiters(result) {
  while (sessionCompletionWaiters.length) {
    const waiter = sessionCompletionWaiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }
}

function completeSession(outcome, statusMessage = '') {
  if (activeSession.completedAt) {
    return;
  }

  clearClientMessageTimeout();
  activeSession.outcome = outcome;
  activeSession.completedAt = Date.now();
  updateSessionProgress(SESSION_STAGES.FINISH, outcome, statusMessage);
  notifySessionCompletionWaiters({
    outcome,
    status: activeSession.status,
    stage: activeSession.stage,
    statusMessage,
    completedAt: activeSession.completedAt,
  });
}

function enqueueTerminalNotice(type, {
  clientId = '',
  message = '',
  status = '',
  outcome = '',
  stage = SESSION_STAGES.FINISH,
} = {}) {
  const targetId = String(clientId || activeSession.clientId || '').trim();
  if (!targetId) {
    return null;
  }

  return agentBridge.enqueue('send_peer_notice', {
    targetId,
    type,
    requestId: `${type}-${Date.now()}`,
    message,
    payload: {
      clientId: targetId,
      sessionId: activeSession.id,
      stage,
      status,
      outcome,
      completedAt: Date.now(),
    },
  });
}

async function handleTerminationMessage(options = {}) {
  const {
    expectedActiveClientId,
    messageOrigin,
    payloadClientId,
    outcome,
    statusMessage,
    snapshotPrefix,
    sendNotice = false,
    updateSessionState = null, // function to update activeSession state
  } = options;

  const originMatchesActiveClient = normalizeId(messageOrigin) && expectedActiveClientId && normalizeId(messageOrigin) === expectedActiveClientId;
  const payloadMatchesActiveClient = normalizeId(payloadClientId) && expectedActiveClientId && normalizeId(payloadClientId) === expectedActiveClientId;
  const accepted = Boolean(originMatchesActiveClient || payloadMatchesActiveClient || (activeSession.id && !activeSession.completedAt));

  if (!accepted) {
    return false;
  }

  // Update session state if needed
  if (updateSessionState) {
    updateSessionState();
  }

  // Capture snapshot
  try {
    const snapshot = await browser.saveTargetSnapshotToFile({
      fullPage: true,
      outputDir: config.timeoutSnapshotDir,
      fileNamePrefix: snapshotPrefix,
    });
    rememberTimeoutSnapshot(snapshot, outcome);
  } catch (error) {
    logger.warn(`Failed to capture ${outcome} snapshot.`, {
      error: error.message,
    });
  }

  // Complete session
  completeSession(outcome, statusMessage);

  // Send terminal notice if requested
  if (sendNotice) {
    enqueueTerminalNotice(`${outcome}_ack`, {
      clientId: activeSession.clientId,
      message: activeSession.statusMessage,
      status: activeSession.status,
      outcome: activeSession.outcome,
    });
  }

  return true;
}

function waitForSessionCompletion(timeoutMs = 0) {
  if (activeSession.completedAt) {
    return Promise.resolve({
      outcome: activeSession.outcome,
      status: activeSession.status,
      stage: activeSession.stage,
      statusMessage: activeSession.statusMessage,
      completedAt: activeSession.completedAt,
    });
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: null,
    };

    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        const index = sessionCompletionWaiters.indexOf(waiter);
        if (index !== -1) {
          sessionCompletionWaiters.splice(index, 1);
        }
        reject(new Error('Timed out waiting for session completion.'));
      }, timeoutMs);
    }

    sessionCompletionWaiters.push(waiter);
  });
}

function notifySessionReadyWaiters() {
  if (!(activeSession.connected && activeSession.resolved)) {
    return;
  }

  while (sessionReadyWaiters.length) {
    const waiter = sessionReadyWaiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve({
      sessionId: activeSession.id,
      connectedAt: activeSession.connectedAt,
      resolveAt: activeSession.lastResolveAt,
      resolveFrom: activeSession.lastResolveFrom,
    });
  }
}

function waitForSessionReady(timeoutMs) {
  if (activeSession.connected && activeSession.resolved) {
    return Promise.resolve({
      sessionId: activeSession.id,
      connectedAt: activeSession.connectedAt,
      resolveAt: activeSession.lastResolveAt,
      resolveFrom: activeSession.lastResolveFrom,
    });
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: null,
    };

    waiter.timer = setTimeout(() => {
      const index = sessionReadyWaiters.indexOf(waiter);
      if (index !== -1) {
        sessionReadyWaiters.splice(index, 1);
      }
      reject(new Error('Timed out waiting for client connection and resolve message.'));
    }, timeoutMs);

    sessionReadyWaiters.push(waiter);
  });
}

function waitForSessionReadyOrCompletion(timeoutMs = 0) {
  if (activeSession.connected && activeSession.resolved) {
    return Promise.resolve({
      kind: 'ready',
      data: {
        sessionId: activeSession.id,
        connectedAt: activeSession.connectedAt,
        resolveAt: activeSession.lastResolveAt,
        resolveFrom: activeSession.lastResolveFrom,
      },
    });
  }

  if (activeSession.completedAt) {
    return Promise.resolve({
      kind: 'completion',
      data: {
        outcome: activeSession.outcome,
        status: activeSession.status,
        stage: activeSession.stage,
        statusMessage: activeSession.statusMessage,
        completedAt: activeSession.completedAt,
      },
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const finalize = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(probeTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const probe = () => {
      if (activeSession.connected && activeSession.resolved) {
        finalize({
          kind: 'ready',
          data: {
            sessionId: activeSession.id,
            connectedAt: activeSession.connectedAt,
            resolveAt: activeSession.lastResolveAt,
            resolveFrom: activeSession.lastResolveFrom,
          },
        });
        return;
      }

      if (activeSession.completedAt) {
        finalize({
          kind: 'completion',
          data: {
            outcome: activeSession.outcome,
            status: activeSession.status,
            stage: activeSession.stage,
            statusMessage: activeSession.statusMessage,
            completedAt: activeSession.completedAt,
          },
        });
      }
    };

    const probeTimer = setInterval(probe, 100);
    const timeoutTimer = timeoutMs > 0
      ? setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(probeTimer);
        reject(new Error('Timed out waiting for session readiness or completion.'));
      }, timeoutMs)
      : null;

    probe();
  });
}

function rememberTimeoutSnapshot(snapshot = {}, type = 'timeout') {
  const snapshotPath = String(snapshot.outputPath || '').trim();
  if (!snapshotPath) {
    return;
  }

  const capturedAt = Date.now();
  sessionSnapshots.push({
    type: String(type || 'timeout').trim() || 'timeout',
    timestamp: new Date(capturedAt).toISOString(),
    path: snapshotPath,
  });

  latestTimeoutSnapshot = {
    path: snapshotPath,
    targetUrl: String(snapshot?.targetPage?.url || '').trim(),
    capturedAt,
  };
}

function getLatestTimeoutSnapshot() {
  const rememberedPath = String(latestTimeoutSnapshot.path || '').trim();
  if (rememberedPath && fs.existsSync(rememberedPath)) {
    return {
      path: rememberedPath,
      targetUrl: latestTimeoutSnapshot.targetUrl,
      capturedAt: latestTimeoutSnapshot.capturedAt,
    };
  }

  const snapshotDir = String(config.timeoutSnapshotDir || '').trim();
  if (!snapshotDir || !fs.existsSync(snapshotDir)) {
    return null;
  }

  const candidates = fs.readdirSync(snapshotDir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => {
      const absolutePath = path.resolve(snapshotDir, name);
      const stat = fs.statSync(absolutePath);
      return {
        path: absolutePath,
        capturedAt: stat.mtimeMs || 0,
      };
    })
    .sort((a, b) => b.capturedAt - a.capturedAt);

  if (!candidates.length) {
    return null;
  }

  const latest = candidates[0];
  latestTimeoutSnapshot = {
    path: latest.path,
    targetUrl: '',
    capturedAt: latest.capturedAt,
  };

  return {
    path: latest.path,
    targetUrl: '',
    capturedAt: latest.capturedAt,
  };
}

function clearClientMessageTimeout() {
  if (!clientMessageTimeoutHandle) {
    return;
  }
  clearTimeout(clientMessageTimeoutHandle);
  clientMessageTimeoutHandle = null;
}

function armClientMessageTimeout(reason = 'init', timeoutMsOverride = null) {
  clearClientMessageTimeout();
  const timeoutMs = Number(timeoutMsOverride || currentClientMessageTimeoutMs || config.clientMessageTimeoutMs || 120000);
  currentClientMessageTimeoutMs = timeoutMs;
  clientMessageTimeoutHandle = setTimeout(async () => {
    clientMessageTimeoutHandle = null;

    logger.warn('Client message timeout reached. Capturing full-page snapshot.', {
      timeoutMs,
      reason,
      clientId: session.clientId,
      outputDir: config.timeoutSnapshotDir,
    });

    try {
      const snapshot = await browser.saveTargetSnapshotToFile({
        fullPage: true,
        outputDir: config.timeoutSnapshotDir,
        fileNamePrefix: `timeout-${session.clientId || 'client'}`,
      });
      rememberTimeoutSnapshot(snapshot, 'timeout');
      logger.info('Timeout snapshot saved.', {
        outputPath: snapshot.outputPath,
        targetUrl: snapshot?.targetPage?.url || '',
      });
    } catch (error) {
      logger.error('Timeout snapshot failed.', {
        error: error.message,
      });
    }

    if (activeSession.id) {
      completeSession('timeout', `Session timed out after ${Math.max(1, Math.floor(timeoutMs / 1000))} seconds.`);
      enqueueTerminalNotice('timeout_notice', {
        clientId: activeSession.clientId,
        message: activeSession.statusMessage,
        status: activeSession.status,
        outcome: activeSession.outcome,
      });
    }
  }, timeoutMs);
}

async function waitForAgentOnline(timeoutMs = 12000) {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (agentBridge.isOnline(10000)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function startSessionWorkflow(payload = {}) {
  const requestedSessionId = String(payload.sessionId || '').trim();
  let daemonId = String(payload.daemonId || '').trim();
  let clientId = String(payload.clientId || '').trim();
  if ((!daemonId || !clientId) && requestedSessionId) {
    const derived = createPeerIds(requestedSessionId);
    daemonId = daemonId || derived.daemonId;
    clientId = clientId || derived.clientId;
  }

  const targetUrl = String(payload.targetUrl || '').trim();
  if (!daemonId || !clientId || !targetUrl) {
    throw new Error('daemonId, clientId, and targetUrl are required.');
  }

  const sessionId = requestedSessionId || createSessionId();
  const timeoutSeconds = parseTimeoutSeconds(payload.timeout, Math.max(1, Math.floor((config.clientMessageTimeoutMs || 120000) / 1000)));
  const timeoutMs = timeoutSeconds * 1000;
  const agentPageNameRaw = String(payload.agentPage || '').trim().toLowerCase();
  const agentPageName = agentPageNameRaw === 'daemon-cli.html' ? 'daemon-cli.html' : 'daemon-agent.html';
  const signalingServer = String(payload.signalingServer || session.signalingServer || config.signalingServer || '').trim();
  const stunUrls = normalizeIceUrlList(payload.stunUrls).length
    ? normalizeIceUrlList(payload.stunUrls)
    : normalizeIceUrlList(session.stunUrls || config.stunUrls);
  const turnUrls = normalizeIceUrlList(payload.turnUrls).length
    ? normalizeIceUrlList(payload.turnUrls)
    : normalizeIceUrlList(session.turnUrls || config.turnUrls);
  const turnUsername = String(payload.turnUsername ?? session.turnUsername ?? config.turnUsername ?? '').trim();
  const turnCredential = String(payload.turnCredential ?? session.turnCredential ?? config.turnCredential ?? '').trim();
  const hasRemoteDebuggingPort = Object.prototype.hasOwnProperty.call(payload, 'remoteDebuggingPort');
  const chromeExecutablePath = String(
    payload.chrome ?? process.env.DAEMON_SESSION_START_CHROME ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? ''
  ).trim();
  let remoteDebuggingPort = null;
  if (hasRemoteDebuggingPort) {
    const parsedRemotePort = Number(payload.remoteDebuggingPort);
    if (!Number.isFinite(parsedRemotePort) || parsedRemotePort <= 0) {
      throw new Error('remote-debugging-port must be a positive number.');
    }
    remoteDebuggingPort = Math.floor(parsedRemotePort);
  }
  const chromeParamsRaw = payload.chromeParams ?? process.env.DAEMON_SESSION_START_CHROME_PARAMS_JSON ?? '[]';
  const chromeParams = parseChromeParamsValue(chromeParamsRaw);

  activeSession.id = sessionId;
  activeSession.daemonId = daemonId;
  activeSession.clientId = clientId;
  activeSession.targetUrl = targetUrl;
  activeSession.timeoutMs = timeoutMs;
  activeSession.stage = SESSION_STAGES.START;
  activeSession.status = 'running';
  activeSession.statusMessage = 'session initialized';
  activeSession.outcome = '';
  activeSession.connected = false;
  activeSession.connectedAt = 0;
  activeSession.resolved = false;
  activeSession.startedAt = Date.now();
  activeSession.lastResolveAt = 0;
  activeSession.lastResolveFrom = '';
  activeSession.lastFinishAt = 0;
  activeSession.lastFinishFrom = '';
  activeSession.completedAt = 0;
  sessionSnapshots.length = 0;

  updateSessionProgress(SESSION_STAGES.START, 'running', 'starting session flow');

  updateSessionProgress(SESSION_STAGES.LAUNCH_CHROME, 'running', 'launching chrome');
  const launchResult = await commands.handle({
    type: 'launch_chrome',
    payload: {
      chrome: chromeExecutablePath,
      remoteDebuggingPort: hasRemoteDebuggingPort ? remoteDebuggingPort : null,
      params: chromeParams,
    },
  });

  session.daemonId = daemonId;
  session.clientId = clientId;
  session.signalingServer = signalingServer;
  session.stunUrls = stunUrls.join(',');
  session.turnUrls = turnUrls.join(',');
  session.turnUsername = turnUsername;
  session.turnCredential = turnCredential;

  const openHost =
    config.staticServerHost === '0.0.0.0' || config.staticServerHost === '::'
      ? 'localhost'
      : config.staticServerHost;
  const daemonAgentUrl = new URL(`http://${openHost}:${config.staticServerPort}/${agentPageName}`);
  daemonAgentUrl.searchParams.set('uid', daemonId);
  daemonAgentUrl.searchParams.set('remote', clientId);
  daemonAgentUrl.searchParams.set('host', signalingServer);
  if (stunUrls.length) {
    daemonAgentUrl.searchParams.set('stunUrls', stunUrls.join(','));
  }
  if (turnUrls.length) {
    daemonAgentUrl.searchParams.set('turnUrls', turnUrls.join(','));
  }
  if (turnUsername) {
    daemonAgentUrl.searchParams.set('turnUsername', turnUsername);
  }
  if (turnCredential) {
    daemonAgentUrl.searchParams.set('turnCredential', turnCredential);
  }

  updateSessionProgress(SESSION_STAGES.OPEN_DAEMON_AGENT_PAGE, 'running', 'opening daemon-agent page');
  await commands.handle({
    type: 'open_url',
    payload: { url: daemonAgentUrl.toString() },
  });
  updateSessionProgress(SESSION_STAGES.OPEN_TARGET_PAGE, 'running', 'opening target page');
  const openTargetResult = await commands.handle({
    type: 'open_target_page',
    payload: {
      name: 'session-target',
      url: targetUrl,
    },
  });

  const online = await waitForAgentOnline(12000);
  if (!online) {
    updateSessionProgress(SESSION_STAGES.CONNECT_TO_SIGNAL_SERVER, 'error', 'daemon-agent bridge did not come online in time');
    throw new Error('daemon-agent bridge did not come online in time.');
  }

  updateSessionProgress(SESSION_STAGES.CONNECT_TO_SIGNAL_SERVER, 'running', 'connecting to signaling server');
  const requestId = `${sessionId}-connect`;
  const connectCommand = agentBridge.enqueue('connect_only', {
    daemonId,
    clientId,
    signalingServer,
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
    requestId,
  });

  armClientMessageTimeout('session_start', timeoutMs);

  updateSessionProgress(SESSION_STAGES.WAIT_CLIENT_RESOLVE, 'running', 'waiting for client resolve');
  let waitResult = null;
  try {
    waitResult = await waitForSessionReady(timeoutMs + 500);
    updateSessionProgress(SESSION_STAGES.USER_INTERACTION, 'running', 'user interaction phase');
  } catch (error) {
    if (!/Timed out waiting for client connection and resolve message/i.test(String(error?.message || ''))) {
      throw error;
    }
    logger.warn('Session resolve wait timed out; awaiting completion status.', {
      sessionId,
      timeoutSeconds,
    });
  }

  const completion = await waitForSessionCompletion(timeoutMs + 1500);

  return {
    ok: true,
    sessionId,
    daemonId,
    clientId,
    targetUrl,
    signalingServer,
    timeout: timeoutSeconds,
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
    launch: launchResult,
    openTarget: openTargetResult,
    commandIds: [connectCommand.id],
    wait: {
      connected: Boolean(waitResult?.connectedAt || activeSession.connected),
      resolveReceived: Boolean(waitResult?.resolveAt || activeSession.resolved),
      connectedAt: waitResult?.connectedAt || activeSession.connectedAt || 0,
      resolveAt: waitResult?.resolveAt || activeSession.lastResolveAt || 0,
      resolveFrom: waitResult?.resolveFrom || activeSession.lastResolveFrom || '',
    },
    completion,
    agentPage: agentPageName,
    flow: {
      interaction: 'Client sends mouse/keyboard/text over data channel; daemon-agent replays to Puppeteer target.',
      timeoutSnapshot: `Timeout (${timeoutSeconds}s) captures snapshot and returns timeout status.`,
    },
  };
}

const cli = buildCli({
  getState: () => ({
    daemonId: session.daemonId,
    clientId: session.clientId,
    signalingServer: session.signalingServer,
    staticServerHost: session.staticServerHost,
    staticServerPort: session.staticServerPort,
    browserLaunched: Boolean(browser.browser),
    pageOpen: Boolean(browser.page),
  }),
  submitCommand: (command) => commands.handle(command),
});

const toolModePayload = parseAweDaemonToolOptions(process.argv.slice(2));

if (process.argv.length > 2 && !toolModePayload) {
  cli.parse(process.argv);
} else {
  const publicDir = path.resolve(__dirname, '../public');
  const browserModuleDir = path.resolve(__dirname, './daemon');
  const clientSdkDir = path.resolve(__dirname, '../../client/src/sdk');
  const openHost =
    config.staticServerHost === '0.0.0.0' || config.staticServerHost === '::'
      ? 'localhost'
      : config.staticServerHost;
  const daemonAgentUrl = `http://${openHost}:${config.staticServerPort}/daemon-agent.html?uid=${encodeURIComponent(session.daemonId)}&remote=${encodeURIComponent(session.clientId)}`;
  const daemonCliUrl = `http://${openHost}:${config.staticServerPort}/daemon-cli.html?uid=${encodeURIComponent(session.daemonId)}&remote=${encodeURIComponent(session.clientId)}&host=${encodeURIComponent(session.signalingServer)}`;

  const server = await startStaticServer({
    rootDir: publicDir,
    browserModuleDir,
    clientSdkDir,
    host: config.staticServerHost,
    port: config.staticServerPort,
    getDaemonAgentConfig: () => ({
      ...session,
      headless: config.browserHeadless,
      runtimeMode: browser.getRuntimeMode(),
      browserConnectionMode: browser.browserConnectionMode,
      // Prefer the active session's timeout: it is assigned early in
      // startSessionWorkflow (before the daemon-agent page is opened and fetches
      // this config), whereas currentClientMessageTimeoutMs is only armed later.
      // Reading currentClientMessageTimeoutMs here would return the default
      // (e.g. 120s) instead of the session's --timeout value (e.g. 300s).
      clientMessageTimeoutMs: activeSession.timeoutMs || currentClientMessageTimeoutMs,
    }),
    submitCommand: (command) => commands.handle(command),
    getDaemonState: () => ({
      daemonId: session.daemonId,
      clientId: session.clientId,
      signalingServer: session.signalingServer,
      browserLaunched: Boolean(browser.browser),
      pageOpen: Boolean(browser.page),
      targetPageOpen: browser.hasTargetPage(),
      targetPage: browser.describeTargetPage(),
      latestTimeoutSnapshot: getLatestTimeoutSnapshot(),
      activeSession,
      agentBridge: agentBridge.snapshot(),
    }),
    getSharePreflight: () => browser.getSharePreflightSnapshot(),
    startSession: (payload) => startSessionWorkflow(payload),
    getLatestSavedSnapshot: () => getLatestTimeoutSnapshot(),
    enqueueAgentCommand: (type, payload) => {
      if (type === 'set_session') {
        if (typeof payload.daemonId === 'string' && payload.daemonId.trim()) {
          session.daemonId = payload.daemonId.trim();
        }
        if (typeof payload.clientId === 'string' && payload.clientId.trim()) {
          session.clientId = payload.clientId.trim();
        }
        if (typeof payload.signalingServer === 'string' && payload.signalingServer.trim()) {
          session.signalingServer = payload.signalingServer.trim();
        }
        if (payload.stunUrls !== undefined) {
          session.stunUrls = Array.isArray(payload.stunUrls)
            ? payload.stunUrls.join(',')
            : String(payload.stunUrls || '').trim();
        }
        if (payload.turnUrls !== undefined) {
          session.turnUrls = Array.isArray(payload.turnUrls)
            ? payload.turnUrls.join(',')
            : String(payload.turnUrls || '').trim();
        }
        if (payload.turnUsername !== undefined) {
          session.turnUsername = String(payload.turnUsername || '').trim();
        }
        if (payload.turnCredential !== undefined || payload.turnPassword !== undefined) {
          session.turnCredential = String(payload.turnCredential ?? payload.turnPassword ?? '').trim();
        }
      }
      return agentBridge.enqueue(type, payload);
    },
    getAgentCommandsAfter: (after) => agentBridge.getCommandsAfter(after),
    onAgentEvent: async (event) => {
      const kind = String(event?.kind || '').trim();
      if (kind === 'heartbeat') {
        agentBridge.mergeState(event.state || {});
        return;
      }
      if (kind === 'status') {
        if (event.status === 'connected') {
          logger.info('daemon-agent signaling connected', {
            daemonId: String(event?.state?.daemonId || ''),
            clientId: String(event?.state?.clientId || ''),
            signalingServer: String(event?.state?.signalingServer || ''),
            allowedRemoteIds: Array.isArray(event?.state?.allowedRemoteIds) ? event.state.allowedRemoteIds : [],
          });
        }
        if (event.status === 'sharing') {
          logger.info('daemon-agent share diagnostics', {
            automated: Boolean(event?.state?.automated),
            manualPromptShown: Boolean(event?.state?.manualPromptShown),
            controlTargetMode: String(event?.state?.controlTargetMode || ''),
            targetUrl: String(event?.state?.targetUrl || ''),
            targetDescriptor: String(event?.state?.targetDescriptor || ''),
            sharedTrackLabel: String(event?.state?.sharedTrackLabel || ''),
            capturedResolution: event?.state?.capturedResolution || null,
          });
        }
        if (event.status === 'connected') {
          const connectedClientId = normalizeId(event?.state?.clientId);
          const expectedClientId = normalizeId(activeSession.clientId);
          if (connectedClientId && expectedClientId && connectedClientId === expectedClientId) {
            activeSession.connected = true;
            activeSession.connectedAt = Date.now();
            notifySessionReadyWaiters();
          }
        }
        agentBridge.markSeen(event.status || null);
        return;
      }
      if (kind === 'command_result') {
        agentBridge.recordCommandResult(event);
        return;
      }
      if (kind === 'peer_message') {
        const rawMessage = String(event?.message || '');
        const messageBytes = (() => {
          try {
            return new TextEncoder().encode(rawMessage).length;
          } catch {
            return rawMessage.length;
          }
        })();
        let parsedType = '';
        let parsedRequestId = '';
        let parsedPayload = null;
        try {
          const parsed = JSON.parse(rawMessage);
          parsedPayload = parsed;
          parsedType = String(parsed?.type || '').trim().toLowerCase();
          parsedRequestId = String(parsed?.requestId || '');
        } catch {
          // Keep raw message logging even for non-JSON payloads.
        }

        logger.debug('daemon-agent peer message received', {
          origin: String(event?.origin || ''),
          type: parsedType,
          requestId: parsedRequestId,
          bytes: messageBytes,
        });

        const payloadClientId = String(
          parsedPayload?.payload?.clientId || parsedPayload?.clientId || ''
        ).trim();

        const messageOrigin = String(event?.origin || '').trim();
        const expectedClientId = String(session.clientId || '').trim();
        const originMatchesSessionClient = normalizeId(messageOrigin) && normalizeId(expectedClientId) && normalizeId(messageOrigin) === normalizeId(expectedClientId);
        const payloadMatchesSessionClient = normalizeId(payloadClientId) && normalizeId(expectedClientId) && normalizeId(payloadClientId) === normalizeId(expectedClientId);

        if (originMatchesSessionClient || payloadMatchesSessionClient) {
          if (!activeSession.connected) {
            activeSession.connected = true;
            activeSession.connectedAt = Date.now();
          }
          armClientMessageTimeout('peer_message', currentClientMessageTimeoutMs);
          logger.debug('Client message timeout reset from peer message.', {
            origin: messageOrigin,
            timeoutMs: currentClientMessageTimeoutMs,
          });
        }

        if (parsedType === 'resolve') {
          const expectedActiveClientId = normalizeId(activeSession.clientId);
          const originMatchesActiveClient = normalizeId(messageOrigin) && expectedActiveClientId && normalizeId(messageOrigin) === expectedActiveClientId;
          const payloadMatchesActiveClient = normalizeId(payloadClientId) && expectedActiveClientId && normalizeId(payloadClientId) === expectedActiveClientId;
          if (originMatchesActiveClient || payloadMatchesActiveClient) {
            if (!activeSession.connected) {
              activeSession.connected = true;
              activeSession.connectedAt = Date.now();
            }
            activeSession.resolved = true;
            activeSession.lastResolveAt = Date.now();
            activeSession.lastResolveFrom = messageOrigin || payloadClientId;
            notifySessionReadyWaiters();
            updateSessionProgress(SESSION_STAGES.USER_INTERACTION, 'running', 'resolve received, user interaction phase');
          }
          logger.info('RESOLVE_RECEIVED', {
            origin: String(event?.origin || ''),
            payloadClientId,
            requestId: parsedRequestId,
            bytes: messageBytes,
          });
        } else if (parsedType === 'finish') {
          const expectedActiveClientId = normalizeId(activeSession.clientId);
          const earlyFinishForActiveSession = Boolean(activeSession.id && !activeSession.completedAt);
          const acceptedFinish = await handleTerminationMessage({
            expectedActiveClientId,
            messageOrigin,
            payloadClientId,
            outcome: 'success',
            statusMessage: 'Finish message received. Session completed successfully.',
            snapshotPrefix: `finish-${activeSession.clientId || 'client'}`,
            sendNotice: true,
            updateSessionState: () => {
              activeSession.lastFinishAt = Date.now();
              activeSession.lastFinishFrom = messageOrigin || payloadClientId;
            },
          });

          logger.info('FINISH_RECEIVED', {
            origin: String(event?.origin || ''),
            payloadClientId,
            acceptedFinish,
            earlyFinishForActiveSession,
            requestId: parsedRequestId,
            bytes: messageBytes,
          });
        } else if (parsedType === 'leave') {
          const expectedActiveClientId = normalizeId(activeSession.clientId);
          const acceptedLeave = await handleTerminationMessage({
            expectedActiveClientId,
            messageOrigin,
            payloadClientId,
            outcome: 'leave',
            statusMessage: 'Leave message received from client. Session ended by client disconnect.',
            snapshotPrefix: `leave-${activeSession.clientId || 'client'}`,
            sendNotice: false,
            updateSessionState: null,
          });

          logger.info('LEAVE_RECEIVED', {
            origin: String(event?.origin || ''),
            payloadClientId,
            acceptedLeave,
            requestId: parsedRequestId,
            bytes: messageBytes,
          });
        } else if (parsedType === 'timeout') {
          const expectedActiveClientId = normalizeId(activeSession.clientId);
          const acceptedTimeout = await handleTerminationMessage({
            expectedActiveClientId,
            messageOrigin,
            payloadClientId,
            outcome: 'timeout',
            statusMessage: 'Timeout message received from client. Session ended by timeout event.',
            snapshotPrefix: `timeout-${activeSession.clientId || 'client'}`,
            sendNotice: true,
            updateSessionState: null,
          });

          logger.info('TIMEOUT_RECEIVED', {
            origin: String(event?.origin || ''),
            payloadClientId,
            acceptedTimeout,
            requestId: parsedRequestId,
            bytes: messageBytes,
          });
        } else if (parsedType === 'connect_only') {
          logger.info('TAKE_ACTION_CONNECT_ONLY_RECEIVED', {
            origin: String(event?.origin || ''),
            requestId: parsedRequestId,
            bytes: messageBytes,
          });
        }

        agentBridge.recordPeerMessage(event);
        return;
      }
      if (kind === 'peer_command_result') {
        const resultType = String(event?.type || '').trim().toLowerCase();
        logger.debug('daemon-agent peer command result', {
          requestId: String(event?.requestId || ''),
          type: resultType,
          ok: event?.ok !== false,
          message: String(event?.message || ''),
          error: String(event?.error || ''),
          bridge: String(event?.bridge || ''),
        });

        if (resultType === 'resolve') {
          if (event?.ok !== false) {
            logger.info('RESOLVE_SHARE_STARTED', {
              requestId: String(event?.requestId || ''),
              message: String(event?.message || ''),
            });
          } else {
            logger.error('RESOLVE_SHARE_FAILED', {
              requestId: String(event?.requestId || ''),
              error: String(event?.error || ''),
            });
          }
        } else if (resultType === 'connect_only') {
          if (event?.ok !== false) {
            logger.info('TAKE_ACTION_SIGNALING_CONNECTED', {
              requestId: String(event?.requestId || ''),
              message: String(event?.message || ''),
            });
          } else {
            logger.error('TAKE_ACTION_SIGNALING_CONNECT_FAILED', {
              requestId: String(event?.requestId || ''),
              error: String(event?.error || ''),
            });
          }
        }

        agentBridge.recordPeerCommandResult(event);
        return;
      }
      agentBridge.markSeen();
    },
    isAgentOnline: () => agentBridge.isOnline(10000),
    bootstrapAgentBridge: async () => {
      const pageName = toolModePayload ? 'daemon-cli.html' : 'daemon-agent.html';
      const targetUrl = `http://${openHost}:${config.staticServerPort}/${pageName}?uid=${encodeURIComponent(session.daemonId)}&remote=${encodeURIComponent(session.clientId)}&host=${encodeURIComponent(session.signalingServer)}`;
      await commands.handle({ type: 'open_url', payload: { url: targetUrl } });
    },
  });

  let shuttingDown = false;

  if (!toolModePayload) {
    armClientMessageTimeout('runtime_start');
  }

  const shutdown = async (exitCode = null, options = {}) => {
    if (shuttingDown) {
      return;
    }
    const toolModeRuntime = options.toolModeRuntime || null;
    const preserveBrowser = Object.prototype.hasOwnProperty.call(options, 'preserveBrowser')
      ? Boolean(options.preserveBrowser)
      : browser.shouldPreserveBrowserOnExit();
    const code = Number.isInteger(exitCode) ? exitCode : (Number.isInteger(process.exitCode) ? process.exitCode : 0);
    shuttingDown = true;
    clearClientMessageTimeout();

    if (toolModeRuntime) {
      await toolModeRuntime.shutdownBrowser();
    } else if (preserveBrowser) {
      await new RemoteDevtoolsMode({
        browser,
        logger,
        requestedRemoteDebuggingPort: browser.remoteDebuggingPort,
      }).shutdownBrowser();
    } else {
      await new PutterMode({ browser, logger, reason: 'default runtime shutdown' }).shutdownBrowser();
    }
    const serverCloseGraceMs = 1500;
    await Promise.race([
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });

        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          logger.warn(`Server close grace period elapsed (${serverCloseGraceMs}ms). Forcing daemon exit.`);
          resolve();
        }, serverCloseGraceMs);
      }),
    ]).catch((error) => {
      logger.warn('Server close reported an error during shutdown; continuing to exit.', {
        error: error.message,
      });
    });
    process.exit(code);
  };
  process.once('SIGINT', () => shutdown(null));
  process.once('SIGTERM', () => shutdown(null));

  logger.info(`Using external OWT signaling server: ${session.signalingServer}`);
  logger.info(`Daemon static server running: http://${config.staticServerHost}:${config.staticServerPort}`);
  logger.info(`Open daemon peer page: ${daemonAgentUrl}`);
  logger.info(`Open daemon CLI page: ${daemonCliUrl}`);
  logger.info(`Daemon log level: ${config.daemonLogLevel}`);
  logger.info('[MODE] Effective browser mode', {
    env: {
      BROWSER_HEADLESS: String(process.env.BROWSER_HEADLESS || ''),
      DAEMON_CHROME_REMOTE_DEBUGGING_PORT: String(process.env.DAEMON_CHROME_REMOTE_DEBUGGING_PORT || ''),
    },
    config: {
      browserHeadless: config.browserHeadless,
      targetPageWidthMax: config.targetPageWidthMax,
      targetPageHeightMax: config.targetPageHeightMax,
    },
    session: {
      headless: session.headless,
    },
    browserController: {
      headless: browser.headless,
      mode: browser.mode,
      connectionMode: browser.browserConnectionMode,
    },
  });

  if (!toolModePayload) {
    try {
      await commands.handle({ type: 'launch_chrome' });
      await commands.handle({ type: 'open_url', payload: { url: daemonCliUrl } });
      logger.info('Opened daemon CLI page on startup.');
    } catch (error) {
      logger.warn('Failed to auto-open daemon CLI page on startup.', {
        error: error?.message || String(error || ''),
      });
    }
  }

  if (toolModePayload) {
    logger.info('awe-daemon tool mode started', {
      daemonId: toolModePayload.daemonId,
      clientId: toolModePayload.clientId,
      targetUrl: toolModePayload.targetUrl,
      timeout: toolModePayload.timeout,
      sessionId: toolModePayload.sessionId,
    });

    try {
      const startResult = await startSessionWorkflow({
        ...toolModePayload,
        agentPage: 'daemon-cli.html',
      });
      const toolModeRuntime = createToolModeRuntime({
        browser,
        logger,
        requestedRemoteDebuggingPort: toolModePayload.remoteDebuggingPort,
      });
      logger.info('Tool-mode runtime selected', {
        mode: toolModeRuntime.name,
        requestedRemoteDebuggingPort: toolModePayload.remoteDebuggingPort,
        browserConnectionMode: browser.browserConnectionMode,
      });

      const completion = await waitForSessionCompletion(Math.max(activeSession.timeoutMs + 60000, activeSession.timeoutMs));
      const ok = completion.outcome === 'success';
      const result = {
        ok,
        mode: toolModeRuntime.name,
        stage: activeSession.stage,
        status: activeSession.status,
        message: completion.statusMessage || (ok ? 'Session completed successfully.' : 'Session completed with timeout.'),
        snapshots: sessionSnapshots,
        start: startResult,
        completion,
      };

      emitToolResult(result, { compact: Boolean(toolModePayload.jsonCompact) });
      await shutdown(ok ? 0 : 124, { toolModeRuntime });
    } catch (error) {
      updateSessionProgress(activeSession.stage || SESSION_STAGES.START, 'error', error.message);
      emitToolResult({
        ok: false,
        stage: activeSession.stage,
        status: activeSession.status,
        message: error.message,
      }, { compact: Boolean(toolModePayload.jsonCompact), isError: true });
      const toolModeRuntime = createToolModeRuntime({
        browser,
        logger,
        requestedRemoteDebuggingPort: toolModePayload.remoteDebuggingPort,
      });
      await shutdown(1, { toolModeRuntime });
    }
  }
}

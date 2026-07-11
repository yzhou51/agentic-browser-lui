import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { buildCli } from './cli.js';
import { BrowserController } from './daemon/browserController.js';
import { AgentControlBridge } from './daemon/agentControlBridge.js';
import { CommandProcessor } from './daemon/commandProcessor.js';
import { createLogger } from './logger.js';
import { startStaticServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = createLogger('daemon-runtime');

const browser = new BrowserController({ headless: false });
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

let clientMessageTimeoutHandle = null;
let currentClientMessageTimeoutMs = Number(config.clientMessageTimeoutMs || 120000);
let latestTimeoutSnapshot = {
  path: '',
  targetUrl: '',
  capturedAt: 0,
};
const activeSession = {
  id: '',
  daemonId: '',
  clientId: '',
  targetUrl: '',
  timeoutMs: currentClientMessageTimeoutMs,
  connected: false,
  connectedAt: 0,
  resolved: false,
  startedAt: 0,
  lastResolveAt: 0,
};
const sessionReadyWaiters = [];

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
    });
  }
}

function waitForSessionReady(timeoutMs) {
  if (activeSession.connected && activeSession.resolved) {
    return Promise.resolve({
      sessionId: activeSession.id,
      connectedAt: activeSession.connectedAt,
      resolveAt: activeSession.lastResolveAt,
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

function rememberTimeoutSnapshot(snapshot = {}) {
  const snapshotPath = String(snapshot.outputPath || '').trim();
  if (!snapshotPath) {
    return;
  }

  latestTimeoutSnapshot = {
    path: snapshotPath,
    targetUrl: String(snapshot?.targetPage?.url || '').trim(),
    capturedAt: Date.now(),
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
      rememberTimeoutSnapshot(snapshot);
      logger.info('Timeout snapshot saved.', {
        outputPath: snapshot.outputPath,
        targetUrl: snapshot?.targetPage?.url || '',
      });
    } catch (error) {
      logger.error('Timeout snapshot failed.', {
        error: error.message,
      });
    }

    try {
      const requestId = `timeout-${Date.now()}`;
      agentBridge.enqueue('disconnect', {
        reason: 'client_message_timeout',
        requestId,
      });
      logger.info('Enqueued daemon-agent disconnect due to client message timeout.', {
        requestId,
      });
    } catch (error) {
      logger.warn('Failed to enqueue daemon-agent disconnect on timeout.', {
        error: error.message,
      });
    }

    try {
      await browser.closeTargetPage();
      logger.info('Closed target page due to client message timeout.');
    } catch (error) {
      logger.warn('Failed to close target page on timeout cleanup.', {
        error: error.message,
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
  const daemonId = String(payload.daemonId || '').trim();
  const clientId = String(payload.clientId || '').trim();
  const targetUrl = String(payload.targetUrl || '').trim();
  if (!daemonId || !clientId || !targetUrl) {
    throw new Error('daemonId, clientId, and targetUrl are required.');
  }

  const sessionId = String(payload.sessionId || '').trim() || createSessionId();
  const timeoutSeconds = parseTimeoutSeconds(payload.timeout, Math.max(1, Math.floor((config.clientMessageTimeoutMs || 120000) / 1000)));
  const timeoutMs = timeoutSeconds * 1000;
  const signalingServer = String(payload.signalingServer || session.signalingServer || config.signalingServer || '').trim();
  const stunUrls = normalizeIceUrlList(payload.stunUrls).length
    ? normalizeIceUrlList(payload.stunUrls)
    : normalizeIceUrlList(session.stunUrls || config.stunUrls);
  const turnUrls = normalizeIceUrlList(payload.turnUrls).length
    ? normalizeIceUrlList(payload.turnUrls)
    : normalizeIceUrlList(session.turnUrls || config.turnUrls);
  const turnUsername = String(payload.turnUsername ?? session.turnUsername ?? config.turnUsername ?? '').trim();
  const turnCredential = String(payload.turnCredential ?? session.turnCredential ?? config.turnCredential ?? '').trim();
  const chromeExecutablePath = String(
    payload.chrome ?? process.env.DAEMON_SESSION_START_CHROME ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? ''
  ).trim();
  const chromeParamsRaw = payload.chromeParams ?? process.env.DAEMON_SESSION_START_CHROME_PARAMS_JSON ?? '[]';
  const chromeParams = parseChromeParamsValue(chromeParamsRaw);

  const launchResult = await commands.handle({
    type: 'launch_chrome',
    payload: {
      chrome: chromeExecutablePath,
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
  const daemonAgentUrl = new URL(`http://${openHost}:${config.staticServerPort}/daemon-agent.html`);
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

  await commands.handle({
    type: 'open_url',
    payload: { url: daemonAgentUrl.toString() },
  });
  const openTargetResult = await commands.handle({
    type: 'open_target_page',
    payload: {
      name: 'session-target',
      url: targetUrl,
    },
  });

  const online = await waitForAgentOnline(12000);
  if (!online) {
    throw new Error('daemon-agent bridge did not come online in time.');
  }

  const requestId = `${sessionId}-connect`;
  const setSessionCommand = agentBridge.enqueue('set_session', {
    daemonId,
    clientId,
    signalingServer,
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
  });
  const disconnectCommand = agentBridge.enqueue('disconnect', {
    reason: 'session_start_reset',
    requestId,
  });
  const connectCommand = agentBridge.enqueue('connect_only', {
    daemonId,
    clientId,
    signalingServer,
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
    requestId,
    forceReconnect: true,
  });

  activeSession.id = sessionId;
  activeSession.daemonId = daemonId;
  activeSession.clientId = clientId;
  activeSession.targetUrl = targetUrl;
  activeSession.timeoutMs = timeoutMs;
  activeSession.connected = false;
  activeSession.connectedAt = 0;
  activeSession.resolved = false;
  activeSession.startedAt = Date.now();
  activeSession.lastResolveAt = 0;

  armClientMessageTimeout('session_start', timeoutMs);

  const waitResult = await waitForSessionReady(timeoutMs);

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
    commandIds: [setSessionCommand.id, disconnectCommand.id, connectCommand.id],
    wait: {
      connected: true,
      resolveReceived: true,
      connectedAt: waitResult.connectedAt,
      resolveAt: waitResult.resolveAt,
    },
    flow: {
      interaction: 'Client sends mouse/keyboard/text over data channel; daemon-agent replays to Puppeteer target.',
      timeoutSnapshot: `Timeout (${timeoutSeconds}s) captures snapshot and performs cleanup.`,
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

if (process.argv.length > 2) {
  cli.parse(process.argv);
} else {
  const publicDir = path.resolve(__dirname, '../public');
  const browserModuleDir = path.resolve(__dirname, './daemon');
  const openHost =
    config.staticServerHost === '0.0.0.0' || config.staticServerHost === '::'
      ? 'localhost'
      : config.staticServerHost;
  const daemonAgentUrl = `http://${openHost}:${config.staticServerPort}/daemon-agent.html?uid=${encodeURIComponent(session.daemonId)}&remote=${encodeURIComponent(session.clientId)}`;

  const server = await startStaticServer({
    rootDir: publicDir,
    browserModuleDir,
    host: config.staticServerHost,
    port: config.staticServerPort,
    getDaemonAgentConfig: () => session,
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
    onAgentEvent: (event) => {
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
          });
        }
        if (event.status === 'connected' && String(event?.state?.clientId || '').trim() === String(activeSession.clientId || '').trim()) {
          activeSession.connected = true;
          activeSession.connectedAt = Date.now();
          notifySessionReadyWaiters();
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
        let parsedType = '';
        let parsedRequestId = '';
        try {
          const parsed = JSON.parse(rawMessage);
          parsedType = String(parsed?.type || '').trim().toLowerCase();
          parsedRequestId = String(parsed?.requestId || '');
        } catch {
          // Keep raw message logging even for non-JSON payloads.
        }

        logger.debug('daemon-agent peer message received', {
          origin: String(event?.origin || ''),
          type: parsedType,
          requestId: parsedRequestId,
          message: rawMessage,
        });

        const messageOrigin = String(event?.origin || '').trim();
        const expectedClientId = String(session.clientId || '').trim();
        if (messageOrigin && expectedClientId && messageOrigin === expectedClientId) {
          armClientMessageTimeout('peer_message', currentClientMessageTimeoutMs);
          logger.debug('Client message timeout reset from peer message.', {
            origin: messageOrigin,
            timeoutMs: currentClientMessageTimeoutMs,
          });
        }

        if (parsedType === 'resolve') {
          if (messageOrigin && String(activeSession.clientId || '').trim() === messageOrigin) {
            activeSession.resolved = true;
            activeSession.lastResolveAt = Date.now();
            notifySessionReadyWaiters();
          }
          logger.info('RESOLVE_RECEIVED', {
            origin: String(event?.origin || ''),
            requestId: parsedRequestId,
            message: rawMessage,
          });
        } else if (parsedType === 'connect_only') {
          logger.info('TAKE_ACTION_CONNECT_ONLY_RECEIVED', {
            origin: String(event?.origin || ''),
            requestId: parsedRequestId,
            message: rawMessage,
          });
        }

        agentBridge.recordPeerMessage(event);
        return;
      }
      if (kind === 'peer_command_result') {
        logger.debug('daemon-agent peer command result', {
          requestId: String(event?.requestId || ''),
          type: String(event?.type || ''),
          ok: event?.ok !== false,
          message: String(event?.message || ''),
          error: String(event?.error || ''),
          bridge: String(event?.bridge || ''),
        });

        if (String(event?.type || '') === 'resolve') {
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
        } else if (String(event?.type || '') === 'connect_only') {
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
      const targetUrl = `http://${openHost}:${config.staticServerPort}/daemon-agent.html?uid=${encodeURIComponent(session.daemonId)}&remote=${encodeURIComponent(session.clientId)}&host=${encodeURIComponent(session.signalingServer)}`;
      await commands.handle({ type: 'open_url', payload: { url: targetUrl } });
    },
  });

  let shuttingDown = false;

  armClientMessageTimeout('runtime_start');

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearClientMessageTimeout();
    await browser.closeBrowser();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.info(`Using external OWT signaling server: ${session.signalingServer}`);
  logger.info(`Daemon static server running: http://${config.staticServerHost}:${config.staticServerPort}`);
  logger.info(`Open daemon peer page: ${daemonAgentUrl}`);
  logger.info(`Daemon log level: ${config.daemonLogLevel}`);
}

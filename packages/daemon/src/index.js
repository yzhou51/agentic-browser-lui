import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { buildCli } from './cli.js';
import { BrowserController } from './daemon/browserController.js';
import { DaemonPageBridge } from './daemon/daemonPageBridge.js';
import { CommandProcessor } from './daemon/commandProcessor.js';
import { createToolModeRuntime, PuppeteerMode, RemoteDevtoolsMode } from './daemon/toolMode.js';
import { SessionManager, SESSION_STAGES } from './daemon/sessionManager.js';
import {
  normalizeIceUrlList,
  parseChromeParamsValue,
  parseTimeoutSeconds,
  createSessionId,
  normalizeId,
  parseDaemonToolOptions,
  emitToolResult,
} from './daemon/sessionOptions.js';
import { createLogger } from './logger.js';
import { startStaticServer } from './server.js';
import { createPeerIds } from '../../client/src/sdk/config/peerIds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = createLogger('daemon-runtime');

const browserCtrl = new BrowserController({
  headless: config.browserHeadless,
  enableHeadlessCalibration: config.enableHeadlessCalibration,
  maxPageWidth: config.targetPageWidthMax,
  maxPageHeight: config.targetPageHeightMax,
});
const commands = new CommandProcessor(browserCtrl);
const daemonPageBridge = new DaemonPageBridge({
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

// Connection/signaling defaults for the daemon. Distinct from the live session
// state, which is owned by SessionManager (see sessionManager.activeSession).
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

const sessionManager = new SessionManager({
  browserController: browserCtrl,
  daemonPageBridge,
  logger,
  config,
  getFallbackClientId: () => session.clientId,
});
const { activeSession } = sessionManager;

async function waitForDaemonPageOnline(timeoutMs = 12000) {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (daemonPageBridge.isOnline(10000)) {
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
  // daemon.html is the sole daemon-side control page.
  const daemonPageName = 'daemon.html';
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

  sessionManager.beginSession({
    id: sessionId,
    daemonId,
    clientId,
    targetUrl,
    timeoutMs,
  });

  sessionManager.updateProgress(SESSION_STAGES.START, 'running', 'starting session flow');

  sessionManager.updateProgress(SESSION_STAGES.LAUNCH_CHROME, 'running', 'launching chrome');
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
  const daemonUrl = new URL(`http://${openHost}:${config.staticServerPort}/${daemonPageName}`);
  daemonUrl.searchParams.set('uid', daemonId);
  daemonUrl.searchParams.set('remote', clientId);
  daemonUrl.searchParams.set('host', signalingServer);
  if (stunUrls.length) {
    daemonUrl.searchParams.set('stunUrls', stunUrls.join(','));
  }
  if (turnUrls.length) {
    daemonUrl.searchParams.set('turnUrls', turnUrls.join(','));
  }
  if (turnUsername) {
    daemonUrl.searchParams.set('turnUsername', turnUsername);
  }
  if (turnCredential) {
    daemonUrl.searchParams.set('turnCredential', turnCredential);
  }

  sessionManager.updateProgress(SESSION_STAGES.OPEN_DAEMON_PAGE, 'running', 'opening daemon page');
  await commands.handle({
    type: 'open_url',
    payload: { url: daemonUrl.toString() },
  });
  sessionManager.updateProgress(SESSION_STAGES.OPEN_TARGET_PAGE, 'running', 'opening target page');
  const openTargetResult = await commands.handle({
    type: 'open_target_page',
    payload: {
      name: 'session-target',
      url: targetUrl,
    },
  });

  const online = await waitForDaemonPageOnline(12000);
  if (!online) {
    sessionManager.updateProgress(SESSION_STAGES.CONNECT_TO_SIGNAL_SERVER, 'error', 'daemon bridge did not come online in time');
    throw new Error('daemon bridge did not come online in time.');
  }

  sessionManager.updateProgress(SESSION_STAGES.CONNECT_TO_SIGNAL_SERVER, 'running', 'connecting to signaling server');
  const requestId = `${sessionId}-connect`;
  const connectCommand = daemonPageBridge.enqueue('connect_only', {
    daemonId,
    clientId,
    signalingServer,
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
    requestId,
  });

  sessionManager.armClientMessageTimeout('session_start', timeoutMs);

  sessionManager.updateProgress(SESSION_STAGES.WAIT_CLIENT_RESOLVE, 'running', 'waiting for client resolve');
  let waitResult = null;
  try {
    waitResult = await sessionManager.waitForSessionReady(timeoutMs + 500);
    sessionManager.updateProgress(SESSION_STAGES.USER_INTERACTION, 'running', 'user interaction phase');
  } catch (error) {
    if (!/Timed out waiting for client connection and resolve message/i.test(String(error?.message || ''))) {
      throw error;
    }
    logger.warn('Session resolve wait timed out; awaiting completion status.', {
      sessionId,
      timeoutSeconds,
    });
  }

  const completion = await sessionManager.waitForSessionCompletion(timeoutMs + 1500);

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
    daemonPage: daemonPageName,
    flow: {
      interaction: 'Client sends mouse/keyboard/text over data channel; daemon replays to Puppeteer target.',
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
    browserLaunched: Boolean(browserCtrl.browser),
    pageOpen: Boolean(browserCtrl.page),
  }),
  submitCommand: (command) => commands.handle(command),
});

const toolModePayload = parseDaemonToolOptions(process.argv.slice(2));

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
  const daemonUrl = `http://${openHost}:${config.staticServerPort}/daemon.html?uid=${encodeURIComponent(session.daemonId)}&remote=${encodeURIComponent(session.clientId)}&host=${encodeURIComponent(session.signalingServer)}`;

  const server = await startStaticServer({
    rootDir: publicDir,
    browserModuleDir,
    clientSdkDir,
    host: config.staticServerHost,
    port: config.staticServerPort,
    getDaemonConfig: () => ({
      ...session,
      headless: config.browserHeadless,
      runtimeMode: browserCtrl.getRuntimeMode(),
      browserConnectionMode: browserCtrl.browserConnectionMode,
      // Prefer the active session's timeout: it is assigned early in
      // startSessionWorkflow (before the daemon page is opened and fetches
      // this config), whereas currentClientMessageTimeoutMs is only armed later.
      // Reading currentClientMessageTimeoutMs here would return the default
      // (e.g. 120s) instead of the session's --timeout value (e.g. 300s).
      clientMessageTimeoutMs: activeSession.timeoutMs || sessionManager.currentClientMessageTimeoutMs,
    }),
    submitCommand: (command) => commands.handle(command),
    getDaemonPageCommands: (after) => daemonPageBridge.getCommandsAfter(after),
    onDaemonPageEvent: async (event) => {
      const kind = String(event?.kind || '').trim();
      if (kind === 'heartbeat') {
        daemonPageBridge.mergeState(event.state || {});
        return;
      }
      if (kind === 'status') {
        if (event.status === 'connected') {
          logger.info('daemon signaling connected', {
            daemonId: String(event?.state?.daemonId || ''),
            clientId: String(event?.state?.clientId || ''),
            signalingServer: String(event?.state?.signalingServer || ''),
            allowedRemoteIds: Array.isArray(event?.state?.allowedRemoteIds) ? event.state.allowedRemoteIds : [],
          });
        }
        if (event.status === 'sharing') {
          logger.info('daemon share diagnostics', {
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
            sessionManager.notifyReadyWaiters();
          }
        }
        daemonPageBridge.markSeen(event.status || null);
        return;
      }
      if (kind === 'command_result') {
        daemonPageBridge.recordCommandResult(event);
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

        logger.debug('daemon peer message received', {
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
          sessionManager.armClientMessageTimeout('peer_message', sessionManager.currentClientMessageTimeoutMs);
          logger.debug('Client message timeout reset from peer message.', {
            origin: messageOrigin,
            timeoutMs: sessionManager.currentClientMessageTimeoutMs,
          });
        }

        if (parsedType === 'resolve') {
          const expectedActiveClientId = normalizeId(activeSession.clientId);
          const originMatchesActiveClient = normalizeId(messageOrigin) && expectedActiveClientId && normalizeId(messageOrigin) === expectedActiveClientId;
          const payloadMatchesActiveClient = normalizeId(payloadClientId) && expectedActiveClientId && normalizeId(payloadClientId) === expectedActiveClientId;
          if (originMatchesActiveClient || payloadMatchesActiveClient) {
            // A resolve from the active client during a leave grace window means
            // the client reconnected -- i.e. the previous `leave` was a page
            // refresh, not a close. Cancel the deferred termination.
            sessionManager.clearPendingLeave('reconnect_resolve');
            if (!activeSession.connected) {
              activeSession.connected = true;
              activeSession.connectedAt = Date.now();
            }
            activeSession.resolved = true;
            activeSession.lastResolveAt = Date.now();
            activeSession.lastResolveFrom = messageOrigin || payloadClientId;
            sessionManager.notifyReadyWaiters();
            sessionManager.updateProgress(SESSION_STAGES.USER_INTERACTION, 'running', 'resolve received, user interaction phase');
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
          const acceptedFinish = await sessionManager.handleTerminationMessage({
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
          // Defer termination behind a grace window instead of ending the session
          // immediately: a refresh emits the same `leave` as a close. If the client
          // reconnects (resolve) within config.leaveGraceMs, the resolve handler
          // cancels this; otherwise the timer fires and terminates as a real close.
          const scheduledLeave = sessionManager.scheduleLeaveTermination({
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
            scheduledLeave,
            graceMs: config.leaveGraceMs,
            requestId: parsedRequestId,
            bytes: messageBytes,
          });
        } else if (parsedType === 'timeout') {
          const expectedActiveClientId = normalizeId(activeSession.clientId);
          const acceptedTimeout = await sessionManager.handleTerminationMessage({
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

        daemonPageBridge.recordPeerMessage(event);
        return;
      }
      if (kind === 'peer_command_result') {
        const resultType = String(event?.type || '').trim().toLowerCase();
        logger.debug('daemon peer command result', {
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

        daemonPageBridge.recordPeerCommandResult(event);
        return;
      }
      daemonPageBridge.markSeen();
    },
  });

  let shuttingDown = false;

  if (!toolModePayload) {
    sessionManager.armClientMessageTimeout('runtime_start');
  }

  const shutdown = async (exitCode = null, options = {}) => {
    if (shuttingDown) {
      return;
    }
    const toolModeRuntime = options.toolModeRuntime || null;
    const preserveBrowser = Object.prototype.hasOwnProperty.call(options, 'preserveBrowser')
      ? Boolean(options.preserveBrowser)
      : browserCtrl.shouldPreserveBrowserOnExit();
    const code = Number.isInteger(exitCode) ? exitCode : (Number.isInteger(process.exitCode) ? process.exitCode : 0);
    shuttingDown = true;

    // Absolute failsafe: whatever throws or blocks below, guarantee the process
    // terminates. unref() so this timer never itself keeps the event loop alive.
    // Without this, a stalled browserCtrl.disconnect()/server.close() (or a throw
    // before process.exit) leaves the HTTP server, Chrome CDP socket and timers
    // holding the loop open -- the daemon hangs and never exits.
    const forceExitTimer = setTimeout(() => {
      logger.warn(`Shutdown failsafe elapsed; forcing immediate exit (code ${code}).`);
      process.exit(code);
    }, 5000);
    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }

    try {
      sessionManager.clearClientMessageTimeout();
      sessionManager.clearPendingLeave('shutdown');

      // Browser teardown is best-effort: a failure here must not prevent exit.
      try {
        if (toolModeRuntime) {
          await toolModeRuntime.shutdownBrowser();
        } else if (preserveBrowser) {
          await new RemoteDevtoolsMode({
            browserController: browserCtrl,
            logger,
            requestedRemoteDebuggingPort: browserCtrl.remoteDebuggingPort,
          }).shutdownBrowser();
        } else {
          await new PuppeteerMode({ browserController: browserCtrl, logger, reason: 'default runtime shutdown' }).shutdownBrowser();
        }
      } catch (error) {
        logger.warn('Browser shutdown reported an error; continuing to exit.', {
          error: error.message,
        });
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
    } finally {
      // Guaranteed exit: runs even if the try body threw, so a rejected
      // shutdown() can never leave the daemon alive on the retry (the
      // shuttingDown guard would otherwise make the second call a no-op).
      clearTimeout(forceExitTimer);
      process.exit(code);
    }
  };
  process.once('SIGINT', () => shutdown(null));
  process.once('SIGTERM', () => shutdown(null));

  logger.info(`Using external OWT signaling server: ${session.signalingServer}`);
  logger.info(`Daemon static server running: http://${config.staticServerHost}:${config.staticServerPort}`);
  logger.info(`Open daemon page: ${daemonUrl}`);
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
      headless: browserCtrl.headless,
      mode: browserCtrl.mode,
      connectionMode: browserCtrl.browserConnectionMode,
    },
  });

  if (!toolModePayload) {
    try {
      await commands.handle({ type: 'launch_chrome' });
      await commands.handle({ type: 'open_url', payload: { url: daemonUrl } });
      logger.info('Opened daemon page on startup.');
    } catch (error) {
      logger.warn('Failed to auto-open daemon page on startup.', {
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
        daemonPage: 'daemon.html',
      });
      const toolModeRuntime = createToolModeRuntime({
        browserController: browserCtrl,
        logger,
        requestedRemoteDebuggingPort: toolModePayload.remoteDebuggingPort,
      });
      logger.info('Tool-mode runtime selected', {
        mode: toolModeRuntime.name,
        requestedRemoteDebuggingPort: toolModePayload.remoteDebuggingPort,
        browserConnectionMode: browserCtrl.browserConnectionMode,
      });

      const completion = await sessionManager.waitForSessionCompletion(Math.max(activeSession.timeoutMs + 60000, activeSession.timeoutMs));
      const ok = completion.outcome === 'success';
      const result = {
        ok,
        mode: toolModeRuntime.name,
        stage: activeSession.stage,
        status: activeSession.status,
        message: completion.statusMessage || (ok ? 'Session completed successfully.' : 'Session completed with timeout.'),
        snapshots: sessionManager.snapshots,
        start: startResult,
        completion,
      };

      emitToolResult(result, { compact: Boolean(toolModePayload.jsonCompact) });
      await shutdown(ok ? 0 : 124, { toolModeRuntime });
    } catch (error) {
      sessionManager.updateProgress(activeSession.stage || SESSION_STAGES.START, 'error', error.message);
      emitToolResult({
        ok: false,
        stage: activeSession.stage,
        status: activeSession.status,
        message: error.message,
      }, { compact: Boolean(toolModePayload.jsonCompact), isError: true });
      const toolModeRuntime = createToolModeRuntime({
        browserController: browserCtrl,
        logger,
        requestedRemoteDebuggingPort: toolModePayload.remoteDebuggingPort,
      });
      await shutdown(1, { toolModeRuntime });
    }
  }
}

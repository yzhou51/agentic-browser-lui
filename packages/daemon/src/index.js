import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { buildCli } from './cli.js';
import { BrowserController } from './daemon/browserController.js';
import { AgentControlBridge } from './daemon/agentControlBridge.js';
import { CommandProcessor } from './daemon/commandProcessor.js';
import { createLogger } from './logger.js';
import { startStaticServer } from './staticServer.js';

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
      agentBridge: agentBridge.snapshot(),
    }),
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
          parsedType = String(parsed?.type || '');
          parsedRequestId = String(parsed?.requestId || '');
        } catch {
          // Keep raw message logging even for non-JSON payloads.
        }

        logger.info('daemon-agent peer message received', {
          origin: String(event?.origin || ''),
          type: parsedType,
          requestId: parsedRequestId,
          message: rawMessage,
        });

        if (parsedType === 'resolve') {
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

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
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

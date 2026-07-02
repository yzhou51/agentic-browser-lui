import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { buildCli } from './cli.js';
import { BrowserController } from './daemon/browserController.js';
import { CommandProcessor } from './daemon/commandProcessor.js';
import { startStaticServer } from './staticServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const browser = new BrowserController({ headless: false });
const commands = new CommandProcessor(browser);

const session = {
  daemonId: config.daemonId,
  clientId: config.defaultClientId,
  signalingServer: config.signalingServer,
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
    daemonAgentConfig: session,
    submitCommand: (command) => commands.handle(command),
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

  console.log(`Using external OWT signaling server: ${session.signalingServer}`);
  console.log(`Daemon static server running: http://${config.staticServerHost}:${config.staticServerPort}`);
  console.log(`Open daemon peer page: ${daemonAgentUrl}`);
}

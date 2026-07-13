export class RemoteDevtoolsMode {
  constructor({ browser, logger, requestedRemoteDebuggingPort }) {
    this.browser = browser;
    this.logger = logger;
    this.requestedRemoteDebuggingPort = requestedRemoteDebuggingPort;
    this.name = 'remote-devtools';
  }

  async shutdownBrowser() {
    this.logger.info('Daemon shutdown in remote-devtools mode: preserving Chrome and target page; daemon process will exit only.', {
      requestedRemoteDebuggingPort: this.requestedRemoteDebuggingPort,
    });
    await this.browser.disconnectBrowser();
  }
}

export class PutterMode {
  constructor({ browser, logger, reason }) {
    this.browser = browser;
    this.logger = logger;
    this.reason = reason || 'default';
    this.name = 'putter';
  }

  async shutdownBrowser() {
    this.logger.info('Daemon shutdown in putter mode: closing target page and Chrome.', {
      reason: this.reason,
    });
    await this.browser.closeTargetPage();
    await this.browser.closeBrowser();
  }
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

export function createToolModeRuntime({ browser, logger, requestedRemoteDebuggingPort }) {
  const requestedPort = normalizePort(requestedRemoteDebuggingPort);
  const attachedToRemote = browser.getRuntimeMode() === 'remote-devtools';

  if (requestedPort && attachedToRemote) {
    return new RemoteDevtoolsMode({
      browser,
      logger,
      requestedRemoteDebuggingPort: requestedPort,
    });
  }

  const reason = requestedPort && !attachedToRemote
    ? 'remote-debugging-port requested but attach failed; fallback to putter mode'
    : 'remote-debugging-port not provided';

  return new PutterMode({ browser, logger, reason });
}

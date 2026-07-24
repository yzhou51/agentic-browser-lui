export class RemoteDevtoolsMode {
  constructor({ browserController, logger, requestedRemoteDebuggingPort }) {
    this.browserCtrl = browserController;
    this.logger = logger;
    this.requestedRemoteDebuggingPort = requestedRemoteDebuggingPort;
    this.name = 'CDP';
  }

  async shutdownBrowser() {
    this.logger.info('Daemon shutdown in CDP mode: preserving Chrome and target page; daemon process will exit only.', {
      requestedRemoteDebuggingPort: this.requestedRemoteDebuggingPort,
    });
    await this.browserCtrl.disconnectBrowser();
  }
}

export class PuppeteerMode {
  constructor({ browserController, logger, reason }) {
    this.browserCtrl = browserController;
    this.logger = logger;
    this.reason = reason || 'default';
    this.name = 'puppeteer';
  }

  async shutdownBrowser() {
    this.logger.info('Daemon shutdown in puppeteer mode: closing target page and Chrome.', {
      reason: this.reason,
    });
    await this.browserCtrl.closeTargetPage();
    await this.browserCtrl.closeBrowser();
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

export function createToolModeRuntime({ browserController, logger, requestedRemoteDebuggingPort }) {
  const requestedPort = normalizePort(requestedRemoteDebuggingPort);
  const attachedToRemote = browserController.getRuntimeMode() === 'CDP';

  if (requestedPort && attachedToRemote) {
    return new RemoteDevtoolsMode({
      browserController,
      logger,
      requestedRemoteDebuggingPort: requestedPort,
    });
  }

  const reason = requestedPort && !attachedToRemote
    ? 'remote-debugging-port requested but attach failed; fallback to puppeteer mode'
    : 'remote-debugging-port not provided';

  return new PuppeteerMode({ browserController, logger, reason });
}

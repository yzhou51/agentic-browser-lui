export class RemoteDevtoolsMode {
  constructor({ browser, logger, requestedRemoteDebuggingPort }) {
    this.browser = browser;
    this.logger = logger;
    this.requestedRemoteDebuggingPort = requestedRemoteDebuggingPort;
    this.name = 'CDP';
  }

  async shutdownBrowser() {
    this.logger.info('Daemon shutdown in CDP mode: preserving Chrome and target page; daemon process will exit only.', {
      requestedRemoteDebuggingPort: this.requestedRemoteDebuggingPort,
    });
    await this.browser.disconnectBrowser();
  }
}

export class PuppeteerMode {
  constructor({ browser, logger, reason }) {
    this.browser = browser;
    this.logger = logger;
    this.reason = reason || 'default';
    this.name = 'puppeteer';
  }

  async shutdownBrowser() {
    this.logger.info('Daemon shutdown in puppeteer mode: closing target page and Chrome.', {
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
  const attachedToRemote = browser.getRuntimeMode() === 'CDP';

  if (requestedPort && attachedToRemote) {
    return new RemoteDevtoolsMode({
      browser,
      logger,
      requestedRemoteDebuggingPort: requestedPort,
    });
  }

  const reason = requestedPort && !attachedToRemote
    ? 'remote-debugging-port requested but attach failed; fallback to puppeteer mode'
    : 'remote-debugging-port not provided';

  return new PuppeteerMode({ browser, logger, reason });
}

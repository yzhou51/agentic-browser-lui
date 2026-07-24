import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import {
  normalizeRemoteDebuggingPort,
  mergeChromeArgs,
  formatChromeArgs,
  resolveRemoteDebuggingPortFromArgs,
} from './chromeLaunchArgs.js';

const logger = createLogger('browser-launcher');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDefaultUserDataDir() {
  const configured = String(process.env.DAEMON_CHROME_USER_DATA_DIR || '').trim();
  if (configured) {
    return configured;
  }

  return path.resolve(__dirname, '../../.chrome-profile');
}

function resolveDefaultCacheDir() {
  const configured = String(process.env.DAEMON_CHROME_CACHE_DIR || '').trim();
  if (configured) {
    return configured;
  }

  return path.resolve(__dirname, '../../.chrome-cache');
}

// Owns how the daemon obtains its Chrome instance: builds/merges the launch args,
// either launches a fresh Chrome or attaches to an already-running one over the
// remote-debugging port, and tracks the resulting connection mode. It produces the
// puppeteer Browser; page management stays with BrowserController.
export class BrowserLauncher {
  constructor({ headless = false, sourceTitle, maxPageWidth, maxPageHeight, simulatedDisplayWidth, simulatedDisplayHeight }) {
    this.headless = headless;
    this.sourceTitle = sourceTitle || 'DUC Target';
    this.userDataDir = resolveDefaultUserDataDir();
    this.cacheDir = resolveDefaultCacheDir();
    this.remoteDebuggingPort = normalizeRemoteDebuggingPort(process.env.DAEMON_CHROME_REMOTE_DEBUGGING_PORT);
    // In headless mode, getDisplayMedia's tab/desktop capture surface size is fixed at
    // Chrome PROCESS LAUNCH time (defaults to Chrome's classic 800x600 if --window-size is
    // not passed) and CANNOT be changed afterward -- neither Emulation.setDeviceMetricsOverride
    // (per-page) nor Browser.setWindowBounds (post-launch) actually resize this off-screen
    // capture surface once the process has started. This only takes effect when this daemon
    // LAUNCHES its own Chrome; it has no effect when attaching to an already-running Chrome
    // via --remote-debugging-port (that external process must be started with its own
    // --window-size to get a correctly-sized capture).
    const launchWindowWidth = Math.max(1, Math.min(maxPageWidth, simulatedDisplayWidth));
    const launchWindowHeight = Math.max(1, Math.min(maxPageHeight, simulatedDisplayHeight));
    this.baseLaunchArgs = [
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--allow-http-screen-capture',
      `--auto-select-tab-capture-source-by-title=${this.sourceTitle}`,
      `--auto-select-desktop-capture-source=${this.sourceTitle}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      `--window-size=${launchWindowWidth},${launchWindowHeight}`,
    ];
    this.defaultLaunchArgs = this.buildDefaultLaunchArgs(this.remoteDebuggingPort);
    this.launchConfig = {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      channel: process.env.PUPPETEER_BROWSER_CHANNEL || 'chrome',
      args: [...this.defaultLaunchArgs],
    };
    this.browserConnectionMode = 'none';
    this.remoteAttachAttempted = false;
    this.remoteAttachConnected = false;
  }

  buildDefaultLaunchArgs(remoteDebuggingPort = null) {
    const args = [...this.baseLaunchArgs];
    if (remoteDebuggingPort) {
      args.push(`--remote-debugging-port=${remoteDebuggingPort}`);
    }
    return args;
  }

  configureLaunch(config = {}) {
    const executablePath = typeof config.chrome === 'string' && config.chrome.trim()
      ? config.chrome.trim()
      : this.launchConfig.executablePath;
    const hasRemotePortOverride = Object.prototype.hasOwnProperty.call(config, 'remoteDebuggingPort');
    const remotePort = hasRemotePortOverride
      ? normalizeRemoteDebuggingPort(config.remoteDebuggingPort)
      : this.remoteDebuggingPort;
    this.remoteDebuggingPort = remotePort;

    const defaultArgs = this.buildDefaultLaunchArgs(this.remoteDebuggingPort);
    const customArgs = formatChromeArgs(config.params);
    const args = mergeChromeArgs(defaultArgs, customArgs);
    this.defaultLaunchArgs = defaultArgs;
    this.remoteDebuggingPort = resolveRemoteDebuggingPortFromArgs(args);

    this.launchConfig = {
      executablePath,
      channel: this.launchConfig.channel,
      args,
    };
  }

  resetConnectionMode() {
    this.browserConnectionMode = 'none';
  }

  // Obtains a Chrome instance: attaches to an existing one when a remote-debugging
  // port is configured and reachable, otherwise launches a fresh Chrome (with an
  // attach fallback when the profile is already in use). Returns the puppeteer
  // Browser; the caller is responsible for hydrating its pages.
  async acquireBrowser() {
    const attached = this.remoteDebuggingPort ? await this.tryAttachToExistingBrowser() : null;
    if (attached) {
      this.browserConnectionMode = 'attached';
      return attached;
    }

    const executablePath = this.launchConfig.executablePath;
    const launchArgs = [...this.launchConfig.args];

    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    launchArgs.push(`--disk-cache-dir=${this.cacheDir}`);

    logger.info(`Launching browser (headless=${this.headless})${executablePath ? ` with executable path: ${executablePath}` : ''}`);
    logger.info(`Using Chrome user data dir: ${this.userDataDir}`);
    logger.info(`Using Chrome cache dir: ${this.cacheDir}`);
    logger.debug('Effective Chrome launch args', launchArgs);

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: this.headless,
        channel: this.launchConfig.channel,
        executablePath,
        defaultViewport: null,
        userDataDir: this.userDataDir,
        ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
        args: launchArgs,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
    } catch (error) {
      const message = String(error?.message || '');
      const profileInUse = /already running for|userDataDir/i.test(message);
      if (!profileInUse) {
        throw error;
      }

      logger.warn('Chrome profile appears in use; trying attach fallback instead of relaunch.', {
        userDataDir: this.userDataDir,
        error: message,
      });

      const attachedAfterLaunchFail = this.remoteDebuggingPort ? await this.tryAttachToExistingBrowser() : null;
      if (attachedAfterLaunchFail) {
        this.browserConnectionMode = 'attached';
        return attachedAfterLaunchFail;
      }
      throw error;
    }

    this.browserConnectionMode = 'launched';
    this.markBrowserProcessDetached(browser);
    return browser;
  }

  markBrowserProcessDetached(browser) {
    try {
      const proc = typeof browser?.process === 'function' ? browser.process() : null;
      if (proc && typeof proc.unref === 'function') {
        proc.unref();
      }
    } catch {
      // Best effort only.
    }
  }

  // Attempts to connect to an already-running Chrome via the remote-debugging port.
  // Returns the connected puppeteer Browser on success, or null otherwise.
  async tryAttachToExistingBrowser() {
    if (!this.remoteDebuggingPort) {
      return null;
    }

    this.remoteAttachAttempted = true;
    const endpoint = await this.resolveBrowserWsEndpoint();
    if (!endpoint) {
      this.remoteAttachConnected = false;
      logger.warn(`Attach to existing Chrome skipped: no DevTools WebSocket endpoint found on port ${this.remoteDebuggingPort} (checked http://127.0.0.1:${this.remoteDebuggingPort}/json/version and DevToolsActivePort file in ${this.userDataDir}). Falling back to launching a new Chrome without proxy/profile settings from the external process.`);
      return null;
    }

    try {
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
      this.remoteAttachConnected = true;
      logger.info(`Attached to existing Chrome via remote debugging port ${this.remoteDebuggingPort}.`);
      return browser;
    } catch (error) {
      logger.warn(`Attach to existing Chrome failed: ${error.message}`);
      this.remoteAttachConnected = false;
      return null;
    }
  }

  async resolveBrowserWsEndpoint() {
    const fromRemotePort = await this.readWsEndpointFromChrome();
    if (fromRemotePort) {
      return fromRemotePort;
    }

    const fromDevToolsFile = this.readWsEndpointFromDevToolsActivePort();
    if (fromDevToolsFile) {
      return fromDevToolsFile;
    }

    return '';
  }

  async readWsEndpointFromChrome() {
    if (!this.remoteDebuggingPort) {
      return '';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`http://127.0.0.1:${this.remoteDebuggingPort}/json/version`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(`DevTools endpoint http://127.0.0.1:${this.remoteDebuggingPort}/json/version responded with HTTP ${response.status}.`);
        return '';
      }
      const data = await response.json();
      return String(data?.webSocketDebuggerUrl || '').trim();
    } catch (error) {
      logger.warn(`Could not reach DevTools endpoint http://127.0.0.1:${this.remoteDebuggingPort}/json/version: ${error?.message || error}. Verify Chrome was started with --remote-debugging-port=${this.remoteDebuggingPort} and is reachable on 127.0.0.1 from this daemon process.`);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  readWsEndpointFromDevToolsActivePort() {
    const devToolsFile = path.join(this.userDataDir, 'DevToolsActivePort');
    if (!fs.existsSync(devToolsFile)) {
      return '';
    }

    try {
      const text = fs.readFileSync(devToolsFile, 'utf8');
      const [portLine] = String(text || '').split(/\r?\n/);
      const port = Number(String(portLine || '').trim());
      if (!Number.isFinite(port) || port <= 0) {
        return '';
      }
      return `ws://127.0.0.1:${port}/devtools/browser`;
    } catch {
      return '';
    }
  }
}

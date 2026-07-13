import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const logger = createLogger('browser-controller');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTO_SHARE_SOURCE_TITLE = String(process.env.DAEMON_AUTO_SHARE_SOURCE_TITLE || 'Agentic Browser Target').trim();

function normalizeRemoteDebuggingPort(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

function getArgValue(arg = '') {
  const value = String(arg || '').trim();
  if (!value.startsWith('--')) {
    return '';
  }
  const eqIndex = value.indexOf('=');
  return eqIndex === -1 ? '' : value.slice(eqIndex + 1);
}

function resolveRemoteDebuggingPortFromArgs(args = []) {
  if (!Array.isArray(args)) {
    return null;
  }

  const entry = args.find((arg) => BrowserController.getArgName(arg) === '--remote-debugging-port');
  if (!entry) {
    return null;
  }

  return normalizeRemoteDebuggingPort(getArgValue(entry));
}

function resolveDefaultTimeoutSnapshotDir() {
  const configured = String(process.env.DAEMON_TIMEOUT_SNAPSHOT_DIR || '').trim();
  if (configured) {
    return configured;
  }

  return path.resolve(__dirname, '../../log/snapshots');
}

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

function isDaemonAgentUrl(url = '') {
  return /\/daemon-agent\.html(?:[?#]|$)/i.test(String(url || ''));
}

function mapRemoteCoordinatesLegacy(payload = {}, { targetWidth = 1, targetHeight = 1 } = {}) {
  const sourceWidth = Math.max(1, Number(payload.sourceWidth || targetWidth || 1));
  const sourceHeight = Math.max(1, Number(payload.sourceHeight || targetHeight || 1));
  const resolvedTargetWidth = Math.max(1, Number(targetWidth || 1));
  const resolvedTargetHeight = Math.max(1, Number(targetHeight || 1));
  const x = Number(payload.x || 0);
  const y = Number(payload.y || 0);

  return {
    x: Math.max(0, Math.min(resolvedTargetWidth - 1, Math.round((x / sourceWidth) * resolvedTargetWidth))),
    y: Math.max(0, Math.min(resolvedTargetHeight - 1, Math.round((y / sourceHeight) * resolvedTargetHeight))),
  };
}

function mapRemoteCoordinates(payload = {}, { targetWidth = 1, targetHeight = 1 } = {}) {
  const resolvedTargetWidth = Math.max(1, Number(targetWidth || 1));
  const resolvedTargetHeight = Math.max(1, Number(targetHeight || 1));

  return mapRemoteCoordinatesLegacy(payload, {
    targetWidth: resolvedTargetWidth,
    targetHeight: resolvedTargetHeight,
  });
}

export class BrowserController {
  constructor({ headless = false } = {}) {
    this.headless = headless;
    this.browser = null;
    this.page = null;
    this.targetPage = null;
    this.userDataDir = resolveDefaultUserDataDir();
    this.cacheDir = resolveDefaultCacheDir();
    this.remoteDebuggingPort = normalizeRemoteDebuggingPort(process.env.DAEMON_CHROME_REMOTE_DEBUGGING_PORT);
    this.baseLaunchArgs = [
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--allow-http-screen-capture',
      `--auto-select-tab-capture-source-by-title=${AUTO_SHARE_SOURCE_TITLE}`,
      `--auto-select-desktop-capture-source=${AUTO_SHARE_SOURCE_TITLE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
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

  static getArgName(arg = '') {
    const value = String(arg || '').trim();
    if (!value.startsWith('--')) {
      return value;
    }
    const eqIndex = value.indexOf('=');
    return eqIndex === -1 ? value : value.slice(0, eqIndex);
  }

  static mergeChromeArgs(defaultArgs = [], customArgs = []) {
    const merged = new Map();

    for (const arg of defaultArgs) {
      const argName = BrowserController.getArgName(arg);
      if (!argName) {
        continue;
      }
      merged.set(argName, arg);
    }

    for (const arg of customArgs) {
      const argName = BrowserController.getArgName(arg);
      if (!argName) {
        continue;
      }
      merged.set(argName, arg);
    }

    return Array.from(merged.values());
  }

  static formatChromeArgs(params = []) {
    if (!Array.isArray(params)) {
      return [];
    }

    const args = [];
    for (const item of params) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const name = String(item.name || '').trim();
      if (!name.startsWith('--')) {
        continue;
      }

      const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
      const value = hasValue ? String(item.value ?? '') : '';
      args.push(hasValue && value !== '' ? `${name}=${value}` : name);
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
    const customArgs = BrowserController.formatChromeArgs(config.params);
    const args = BrowserController.mergeChromeArgs(defaultArgs, customArgs);
    this.defaultLaunchArgs = defaultArgs;
    this.remoteDebuggingPort = resolveRemoteDebuggingPortFromArgs(args);

    this.launchConfig = {
      executablePath,
      channel: this.launchConfig.channel,
      args,
    };
  }

  getRuntimeMode() {
    return this.browserConnectionMode === 'attached' ? 'remote-devtools' : 'putter';
  }

  shouldPreserveBrowserOnExit() {
    return this.getRuntimeMode() === 'remote-devtools';
  }

  async launchIfNeeded() {
    if (this.browser) {
      return;
    }

    const attached = this.remoteDebuggingPort ? await this.tryAttachToExistingBrowser() : false;
    if (attached) {
      this.browserConnectionMode = 'attached';
      return;
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
    try {
      this.browser = await puppeteer.launch({
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

      const attachedAfterLaunchFail = this.remoteDebuggingPort ? await this.tryAttachToExistingBrowser() : false;
      if (attachedAfterLaunchFail) {
        this.browserConnectionMode = 'attached';
        return;
      }
      throw error;
    }

    this.browserConnectionMode = 'launched';
    this.markBrowserProcessDetached();
    await this.hydrateKnownPages();
  }

  getSharePreflightSnapshot() {
    const requiredFlags = [
      '--allow-http-screen-capture',
      '--auto-select-tab-capture-source-by-title',
      '--auto-select-desktop-capture-source',
    ];
    if (this.remoteDebuggingPort) {
      requiredFlags.push('--remote-debugging-port');
    }

    const effectiveArgs = Array.isArray(this.launchConfig?.args) ? this.launchConfig.args : [];
    const normalizedArgs = effectiveArgs.map((arg) => String(arg || '').trim());
    const flagChecks = requiredFlags.map((flag) => ({
      flag,
      present: normalizedArgs.some((entry) => entry === flag || entry.startsWith(`${flag}=`)),
    }));

    const warnings = [];
    if (this.browserConnectionMode === 'attached') {
      warnings.push('Attached to existing Chrome; capture flags cannot be fully verified from daemon process. Auto-share may still require manual picker confirmation.');
    }
    if (!this.browser) {
      warnings.push('No active browser connection. Launch/attach must succeed before sharing.');
    }

    return {
      browserConnected: Boolean(this.browser),
      browserConnectionMode: this.browserConnectionMode,
      runtimeMode: this.getRuntimeMode(),
      remoteDebuggingPort: this.remoteDebuggingPort,
      remoteAttachAttempted: this.remoteAttachAttempted,
      remoteAttachConnected: this.remoteAttachConnected,
      userDataDir: this.userDataDir,
      requiredFlags: flagChecks,
      allRequiredFlagsConfigured: flagChecks.every((entry) => entry.present),
      warnings,
    };
  }

  markBrowserProcessDetached() {
    try {
      const proc = typeof this.browser?.process === 'function' ? this.browser.process() : null;
      if (proc && typeof proc.unref === 'function') {
        proc.unref();
      }
    } catch {
      // Best effort only.
    }
  }

  async tryAttachToExistingBrowser() {
    if (!this.remoteDebuggingPort) {
      return false;
    }

    this.remoteAttachAttempted = true;
    const endpoint = await this.resolveBrowserWsEndpoint();
    if (!endpoint) {
      this.remoteAttachConnected = false;
      return false;
    }

    try {
      this.browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
      await this.hydrateKnownPages();
      this.remoteAttachConnected = true;
      logger.info(`Attached to existing Chrome via remote debugging port ${this.remoteDebuggingPort}.`);
      return true;
    } catch (error) {
      logger.warn(`Attach to existing Chrome failed: ${error.message}`);
      this.browser = null;
      this.remoteAttachConnected = false;
      return false;
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
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(`http://127.0.0.1:${this.remoteDebuggingPort}/json/version`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return '';
      }
      const data = await response.json();
      return String(data?.webSocketDebuggerUrl || '').trim();
    } catch {
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

  async hydrateKnownPages() {
    if (!this.browser) {
      return;
    }

    const pages = await this.browser.pages();
    const daemonPage = pages.find((entry) => isDaemonAgentUrl(entry.url()));
    const targetCandidate = pages.find((entry) => {
      const url = String(entry.url() || '').trim();
      if (!url || url === 'about:blank') {
        return false;
      }
      return !isDaemonAgentUrl(url);
    });

    if (daemonPage) {
      this.page = daemonPage;
    }
    if (targetCandidate) {
      this.targetPage = targetCandidate;
    }
  }

  hasTargetPage() {
    return Boolean(this.targetPage && !(typeof this.targetPage.isClosed === 'function' && this.targetPage.isClosed()));
  }

  describeTargetPage() {
    if (!this.hasTargetPage()) {
      return null;
    }

    return {
      url: this.targetPage.url(),
    };
  }

  async ensureDaemonPage() {
    await this.launchIfNeeded();
    if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
      this.page = await this.browser.newPage();
      await this.page.setUserAgent('agentic-browser-daemon');
    }
    return this.page;
  }

  async ensureTargetPage() {
    await this.launchIfNeeded();
    if (!this.targetPage || (typeof this.targetPage.isClosed === 'function' && this.targetPage.isClosed())) {
      this.targetPage = await this.browser.newPage();
      await this.targetPage.setUserAgent('agentic-browser-target');
    }
    return this.targetPage;
  }

  getActiveControlPage() {
    if (this.hasTargetPage()) {
      return this.targetPage;
    }
    return this.page;
  }

  async focusTargetPageIfAvailable() {
    if (!this.hasTargetPage()) {
      return false;
    }

    try {
      await this.targetPage.bringToFront();
      return true;
    } catch (error) {
      logger.warn(`bringToFront target page after daemon page open failed: ${error.message}`);
      return false;
    }
  }

  async open(url) {
    const resolvedUrl = String(url || '').trim();
    if (isDaemonAgentUrl(resolvedUrl)) {
      const daemonPage = await this.ensureDaemonPage();
      await daemonPage.goto(resolvedUrl, { waitUntil: 'domcontentloaded' });
      logger.info('daemon-agent opened in background; restoring focus to target page when available.');
      await this.focusTargetPageIfAvailable();
      return;
    }

    await this.openTarget(resolvedUrl);
  }

  async openTarget(url) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) {
      throw new Error('Target URL is required.');
    }

    const page = await this.ensureTargetPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate((title) => {
      if (typeof title === 'string' && title.trim()) {
        document.title = title;
      }
    }, AUTO_SHARE_SOURCE_TITLE);
    try {
      await page.bringToFront();
    } catch (error) {
      logger.warn(`bringToFront after openTarget failed: ${error.message}`);
    }

    return this.describeTargetPage();
  }

  async prepareShareTarget() {
    if (!this.hasTargetPage()) {
      return null;
    }

    try {
      await this.targetPage.evaluate((title) => {
        if (typeof title === 'string' && title.trim()) {
          document.title = title;
        }
      }, AUTO_SHARE_SOURCE_TITLE);
    } catch (error) {
      logger.warn(`retitle target page before share failed: ${error.message}`);
    }

    try {
      await this.targetPage.bringToFront();
    } catch (error) {
      logger.warn(`bringToFront target page before share failed: ${error.message}`);
    }

    return this.describeTargetPage();
  }

  async resolveTargetCoordinates(payload = {}) {
    const page = this.targetPage;
    if (!page) {
      return { x: Number(payload.x || 0), y: Number(payload.y || 0) };
    }

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 1,
      height: window.innerHeight || document.documentElement.clientHeight || 1,
    }));

    const viewportContext = {
      targetWidth: viewport.width,
      targetHeight: viewport.height,
    };
    const mapped = mapRemoteCoordinates(payload, viewportContext);
    const hasViewportMapping =
      Number.isFinite(Number(payload.viewWidth)) && Number(payload.viewWidth) > 0 &&
      Number.isFinite(Number(payload.viewHeight)) && Number(payload.viewHeight) > 0;

    if (hasViewportMapping) {
      const legacyMapped = mapRemoteCoordinatesLegacy(payload, viewportContext);
      logger.debug('resolveTargetCoordinates mapping comparison', {
        source: {
          x: Number(payload.x || 0),
          y: Number(payload.y || 0),
        },
        viewport: {
          viewScrollLeft: Number(payload.viewScrollLeft || 0),
          viewScrollTop: Number(payload.viewScrollTop || 0),
          viewWidth: Number(payload.viewWidth || 0),
          viewHeight: Number(payload.viewHeight || 0),
        },
        mappedViewportAware: mapped,
        mappedLegacy: legacyMapped,
        delta: {
          dx: mapped.x - legacyMapped.x,
          dy: mapped.y - legacyMapped.y,
        },
      });
    }

    return mapped;
  }

  async prepareTargetPage() {
    const page = await this.ensureTargetPage();
    try {
      await page.bringToFront();
    } catch (error) {
      logger.warn(`bringToFront before target command failed: ${error.message}`);
    }
    return page;
  }

  async dispatchTargetCommand(command = {}) {
    const type = String(command?.type || '').trim();
    const payload = command?.payload && typeof command.payload === 'object' ? command.payload : {};

    if (!type) {
      throw new Error('Target command type is required.');
    }

    if (type === 'extension_ping') {
      return {
        ok: this.hasTargetPage(),
        message: this.hasTargetPage() ? 'Puppeteer target bridge is active.' : 'No Puppeteer target page is open.',
        bridge: 'puppeteer',
        targetPage: this.describeTargetPage(),
      };
    }

    if (type === 'open_url') {
      const descriptor = await this.openTarget(payload.url || '');
      return { ok: true, message: `Navigated target page to ${payload.url}`, bridge: 'puppeteer', targetPage: descriptor };
    }

    if (!this.hasTargetPage()) {
      return { ok: false, error: 'No Puppeteer target page is open.', bridge: 'puppeteer' };
    }

    const page = await this.prepareTargetPage();

    switch (type) {
      case 'close_page':
        await this.closeTargetPage();
        return { ok: true, message: 'Target page closed.', bridge: 'puppeteer' };
      case 'mouse_move': {
        const { x, y } = await this.resolveTargetCoordinates(payload);
        await page.mouse.move(x, y);
        return { ok: true, message: `mouse_move replayed at (${x}, ${y}).`, bridge: 'puppeteer' };
      }
      case 'mouse_down': {
        const { x, y } = await this.resolveTargetCoordinates(payload);
        await page.mouse.move(x, y);
        await page.mouse.down({ button: payload.button || 'left' });
        return { ok: true, message: `mouse_down replayed at (${x}, ${y}).`, bridge: 'puppeteer' };
      }
      case 'mouse_up': {
        const { x, y } = await this.resolveTargetCoordinates(payload);
        await page.mouse.move(x, y);
        await page.mouse.up({ button: payload.button || 'left' });
        return { ok: true, message: `mouse_up replayed at (${x}, ${y}).`, bridge: 'puppeteer' };
      }
      case 'mouse_click': {
        const { x, y } = await this.resolveTargetCoordinates(payload);
        await page.mouse.click(x, y, { button: payload.button || 'left' });
        return { ok: true, message: `mouse_click replayed at (${x}, ${y}).`, bridge: 'puppeteer' };
      }
      case 'text_input':
        await page.keyboard.type(String(payload.text || ''));
        return { ok: true, message: `text_input replayed (${String(payload.text || '').length} chars).`, bridge: 'puppeteer' };
      case 'key_press':
        if (payload.key === 'Backspace') {
          await page.keyboard.press('Backspace');
          return { ok: true, message: 'Backspace replayed.', bridge: 'puppeteer' };
        }
        await page.keyboard.press(String(payload.key || ''));
        return { ok: true, message: `key_press replayed (${String(payload.key || '') || 'unknown'}).`, bridge: 'puppeteer' };
      default:
        return { ok: false, error: `Unsupported target command type: ${type}`, bridge: 'puppeteer' };
    }
  }

  async moveMouse(x, y) {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.move(Number(x), Number(y));
  }

  async mouseDown(x, y, button = 'left') {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.down({ button });
  }

  async mouseUp(x, y, button = 'left') {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.up({ button });
  }

  async clickMouse(x, y, button = 'left') {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.click(Number(x), Number(y), { button });
  }

  async inputText(text) {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.keyboard.type(String(text));
  }

  async pressKey(key) {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.keyboard.press(String(key));
  }

  async deleteBackward() {
    const page = this.getActiveControlPage();
    if (!page) return;

    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error('No open page is available for Backspace.');
    }

    logger.debug('Deleting backward in active page.');

    try {
      await page.bringToFront();
    } catch (error) {
      logger.warn(`bringToFront before Backspace failed: ${error.message}`);
    }

    try {
      await page.keyboard.press('Backspace');
    } catch (error) {
      logger.error(`Backspace press failed: ${error.message}`);
      throw error;
    }
  }

  async closePage() {
    if (!this.page) return;
    await this.page.close();
    this.page = null;
  }

  async closeTargetPage() {
    if (!this.targetPage) {
      return;
    }
    await this.targetPage.close();
    this.targetPage = null;
  }

  async closeBrowser() {
    if (!this.browser) return;
    await this.browser.close();
    this.browser = null;
    this.page = null;
    this.targetPage = null;
    this.browserConnectionMode = 'none';
  }

  async disconnectBrowser() {
    if (!this.browser) {
      return;
    }

    try {
      this.browser.disconnect();
    } catch {
      // Best effort only.
    }

    this.browser = null;
    this.page = null;
    this.targetPage = null;
    this.browserConnectionMode = 'none';
  }

  async captureTargetSnapshot(options = {}) {
    if (!this.hasTargetPage()) {
      throw new Error('No Puppeteer target page is open.');
    }

    const page = await this.prepareTargetPage();
    const fullPage = Boolean(options.fullPage);
    const clip = options.clip && typeof options.clip === 'object' ? options.clip : null;
    const screenshotOptions = {
      type: 'png',
      fullPage,
      captureBeyondViewport: fullPage,
    };

    if (
      clip &&
      Number.isFinite(Number(clip.x)) &&
      Number.isFinite(Number(clip.y)) &&
      Number(clip.width) > 0 &&
      Number(clip.height) > 0
    ) {
      screenshotOptions.clip = {
        x: Number(clip.x),
        y: Number(clip.y),
        width: Number(clip.width),
        height: Number(clip.height),
      };
    }

    const image = await page.screenshot(screenshotOptions);
    const imageBuffer = Buffer.isBuffer(image) ? image : Buffer.from(image);
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
    }));

    return {
      mimeType: 'image/png',
      imageBase64: imageBuffer.toString('base64'),
      fullPage,
      clip: screenshotOptions.clip || null,
      viewport,
      targetPage: this.describeTargetPage(),
    };
  }

  async saveTargetSnapshotToFile(options = {}) {
    if (!this.hasTargetPage()) {
      throw new Error('No Puppeteer target page is open.');
    }

    const page = await this.prepareTargetPage();
    const fullPage = options.fullPage !== false;
    const outputDir = String(options.outputDir || resolveDefaultTimeoutSnapshotDir()).trim();
    const fileNamePrefix = String(options.fileNamePrefix || 'target-snapshot').trim() || 'target-snapshot';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.resolve(outputDir, `${fileNamePrefix}-${timestamp}.png`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await page.screenshot({
      type: 'png',
      path: outputPath,
      fullPage,
      captureBeyondViewport: fullPage,
    });

    return {
      ok: true,
      mimeType: 'image/png',
      fullPage,
      outputPath,
      targetPage: this.describeTargetPage(),
    };
  }
}

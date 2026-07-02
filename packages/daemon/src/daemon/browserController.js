import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const logger = createLogger('browser-controller');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTO_SHARE_SOURCE_TITLE = String(process.env.DAEMON_AUTO_SHARE_SOURCE_TITLE || 'Agentic Browser Target').trim();

function resolveDefaultExtensionDir() {
  const configured = String(process.env.DAEMON_EXTENSION_DIR || '').trim();
  if (configured) {
    return configured;
  }

  return path.resolve(__dirname, '../../extension');
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

function mapRemoteCoordinates(payload = {}, { targetWidth = 1, targetHeight = 1 } = {}) {
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

export class BrowserController {
  constructor({ headless = false } = {}) {
    this.headless = headless;
    this.browser = null;
    this.page = null;
    this.targetPage = null;
    this.extensionDir = resolveDefaultExtensionDir();
    this.userDataDir = resolveDefaultUserDataDir();
    this.cacheDir = resolveDefaultCacheDir();
    this.defaultLaunchArgs = [
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--allow-http-screen-capture',
      `--auto-select-desktop-capture-source=${AUTO_SHARE_SOURCE_TITLE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
    ];
    this.launchConfig = {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      channel: process.env.PUPPETEER_BROWSER_CHANNEL || 'chrome',
      args: [...this.defaultLaunchArgs],
    };
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
    const customArgs = BrowserController.formatChromeArgs(config.params);
    const args = BrowserController.mergeChromeArgs(this.defaultLaunchArgs, customArgs);

    this.launchConfig = {
      executablePath,
      channel: this.launchConfig.channel,
      args,
    };
  }

  async launchIfNeeded() {
    if (this.browser) {
      return;
    }
    const executablePath = this.launchConfig.executablePath;
    const launchArgs = [...this.launchConfig.args];

    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    launchArgs.push(`--disk-cache-dir=${this.cacheDir}`);

    if (fs.existsSync(this.extensionDir)) {
      launchArgs.push(`--disable-extensions-except=${this.extensionDir}`);
      launchArgs.push(`--load-extension=${this.extensionDir}`);
      logger.info(`Loading daemon extension from ${this.extensionDir}`);
    } else {
      logger.warn(`Daemon extension directory not found: ${this.extensionDir}`);
    }

    logger.info(`Launching browser (headless=${this.headless})${executablePath ? ` with executable path: ${executablePath}` : ''}`);
    logger.info(`Using Chrome user data dir: ${this.userDataDir}`);
    logger.info(`Using Chrome cache dir: ${this.cacheDir}`);
    logger.debug('Effective Chrome launch args', launchArgs);
    this.browser = await puppeteer.launch({
      headless: this.headless,
      channel: this.launchConfig.channel,
      executablePath,
      defaultViewport: null,
      userDataDir: this.userDataDir,
      ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
      args: launchArgs,
    });
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

    return mapRemoteCoordinates(payload, {
      targetWidth: viewport.width,
      targetHeight: viewport.height,
    });
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
  }
}

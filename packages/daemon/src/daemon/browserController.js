import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import { log } from 'node:console';

const logger = createLogger('browser-controller');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTO_SHARE_SOURCE_TITLE = String(process.env.DAEMON_AUTO_SHARE_SOURCE_TITLE || 'Agentic Browser Target').trim();
// Simulated display size used as the base/ceiling for the shared viewport. window.screen.width/
// height/availWidth/availHeight cannot be trusted in headless Chrome (see optimizeViewportForPageSize),
// so instead of reading a "screen size" from the page, we explicitly emulate one via CDP.
const SIMULATED_DISPLAY_WIDTH = 1920;
const SIMULATED_DISPLAY_HEIGHT = 1080;

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

// The daemon control page (daemon.html) is opened in the background; every
// other non-blank page is treated as the shareable target page.
function isDaemonControlUrl(url = '') {
  return /\/daemon\.html(?:[?#]|$)/i.test(String(url || ''));
}

function mapRemoteCoordinatesLegacy(payload = {}, { targetWidth = 1, targetHeight = 1 } = {}) {
  // Support both compact (sx/sy) and legacy (sourceWidth/sourceHeight) formats
  const sourceWidth = Math.max(1, Number(payload.sx ?? payload.sourceWidth ?? targetWidth ?? 1));
  const sourceHeight = Math.max(1, Number(payload.sy ?? payload.sourceHeight ?? targetHeight ?? 1));
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

// Fits a 1D linear model (domValue = scale * videoValue + offset) via ordinary least squares
// across an arbitrary number of correspondence points. Used by setCalibration() so calibration
// can use however many marker correspondences actually survived detection (>=2), instead of
// only ever trusting a single fixed pair of points.
function fitLinearAxis(points = [], videoKey, domKey) {
  const n = points.length;
  if (n < 2) {
    return null;
  }

  let sumV = 0;
  let sumD = 0;
  let sumVV = 0;
  let sumVD = 0;
  for (const point of points) {
    const v = Number(point[videoKey]);
    const d = Number(point[domKey]);
    sumV += v;
    sumD += d;
    sumVV += v * v;
    sumVD += v * d;
  }

  const denominator = n * sumVV - sumV * sumV;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) {
    // No spread on this axis (all points share ~the same video coordinate) -- can't fit a slope.
    return null;
  }

  const scale = (n * sumVD - sumV * sumD) / denominator;
  const offset = (sumD - scale * sumV) / n;
  return { scale, offset };
}

// Robustly fits a 1D linear model (domValue = scale * videoValue + offset), rejecting outlier
// correspondences before the final fit. A marker correspondence can be wildly wrong (hundreds of
// pixels off) if its assigned color happens to collide with real page content elsewhere in the
// frame (e.g. a page that uses a similar blue/white as one of our marker colors) -- an ordinary
// least-squares fit is NOT robust to even one or two such outliers among a handful of points, so
// this uses a RANSAC-style approach: every pair of points defines a candidate 2-point model,
// score each candidate by how many of the OTHER points it also explains within a small pixel
// tolerance ("inliers"), keep the best-scoring candidate's inlier set, then do a final ordinary
// least-squares refit using only those inliers for a more accurate result than the raw 2-point
// seed model.
function robustFitAxis(points = [], videoKey, domKey, inlierThresholdPx = 15) {
  const n = points.length;
  if (n < 2) {
    return null;
  }

  let bestInlierIndices = null;

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const vi = Number(points[i][videoKey]);
      const vj = Number(points[j][videoKey]);
      const di = Number(points[i][domKey]);
      const dj = Number(points[j][domKey]);
      const videoDelta = vj - vi;

      if (!Number.isFinite(videoDelta) || Math.abs(videoDelta) < 1) {
        continue; // Degenerate pair for this axis (near-identical video coordinate).
      }

      const scale = (dj - di) / videoDelta;
      const offset = di - scale * vi;
      if (!Number.isFinite(scale) || !Number.isFinite(offset)) {
        continue;
      }

      const inlierIndices = [];
      points.forEach((point, index) => {
        const predicted = scale * Number(point[videoKey]) + offset;
        if (Math.abs(Number(point[domKey]) - predicted) <= inlierThresholdPx) {
          inlierIndices.push(index);
        }
      });

      if (!bestInlierIndices || inlierIndices.length > bestInlierIndices.length) {
        bestInlierIndices = inlierIndices;
      }
    }
  }

  if (!bestInlierIndices || bestInlierIndices.length < 2) {
    return null;
  }

  const inlierPoints = bestInlierIndices.map((index) => points[index]);
  const refined = fitLinearAxis(inlierPoints, videoKey, domKey);
  if (!refined) {
    return null;
  }

  return {
    ...refined,
    inlierCount: inlierPoints.length,
    outlierCount: n - inlierPoints.length,
    inlierIds: inlierPoints.map((point) => point.id),
  };
}

// Resolves the calibration to actually use for a given click's reported source resolution
// (payload.sx/sy), accounting for the fact that WebRTC can change the encoded video resolution
// mid-session (bandwidth/CPU-driven quality adaptation) after calibration was originally
// computed for one specific resolution. Two cases are handled:
//
//  1. Exact match (within 5%): the resolution hasn't meaningfully changed -- use the stored
//     scale/offset as-is.
//  2. Uniform rescale: the new resolution is a UNIFORMLY scaled version of the calibrated one
//     (same ratio on both width and height, e.g. the whole frame got scaled down 30% for
//     bandwidth reasons). Because that kind of resize happens AFTER the fixed capture-to-page
//     crop (it just changes pixel density, not which region of the page is visible), the
//     calibrated offset is still valid unchanged, and only the scale needs dividing by the
//     resize factor: domX = scaleX*videoX_atCalibRes + offsetX, and
//     videoX_atCalibRes = videoX_now / resizeFactorX, so domX = (scaleX/resizeFactorX)*videoX_now
//     + offsetX.
//
// If the new resolution changed non-uniformly (a genuinely different crop, not just a resize --
// e.g. the aspect ratio itself shifted), this returns null so the caller falls back to plain
// proportional mapping rather than applying a stale/wrong correction.
function resolveCalibrationForSource(calibration, sx, sy) {
  if (!calibration || !(sx > 0) || !(sy > 0) || !(calibration.sourceWidth > 0) || !(calibration.sourceHeight > 0)) {
    return null;
  }

  const widthDelta = Math.abs(sx - calibration.sourceWidth) / calibration.sourceWidth;
  const heightDelta = Math.abs(sy - calibration.sourceHeight) / calibration.sourceHeight;

  if (widthDelta < 0.05 && heightDelta < 0.05) {
    return {
      scaleX: calibration.scaleX,
      scaleY: calibration.scaleY,
      offsetX: calibration.offsetX,
      offsetY: calibration.offsetY,
      rescaled: false,
    };
  }

  const resizeFactorX = sx / calibration.sourceWidth;
  const resizeFactorY = sy / calibration.sourceHeight;
  if (!Number.isFinite(resizeFactorX) || !Number.isFinite(resizeFactorY) || resizeFactorX <= 0 || resizeFactorY <= 0) {
    return null;
  }

  // Require the two axes to have scaled by (nearly) the same factor -- that's what
  // distinguishes "WebRTC uniformly resized the same captured region" from "a genuinely
  // different crop/aspect ratio is now in play" (which we can't safely correct for without a
  // fresh calibration).
  const factorRatio = resizeFactorX / resizeFactorY;
  if (factorRatio < 0.97 || factorRatio > 1.03) {
    return null;
  }

  const scaleX = calibration.scaleX / resizeFactorX;
  const scaleY = calibration.scaleY / resizeFactorY;
  if (![scaleX, scaleY].every(Number.isFinite)) {
    return null;
  }

  return {
    scaleX,
    scaleY,
    offsetX: calibration.offsetX,
    offsetY: calibration.offsetY,
    rescaled: true,
    resizeFactorX,
    resizeFactorY,
  };
}

async function readCaptureSurfaceDimensions(page) {
  if (!page || typeof page.createCDPSession !== 'function') {
    return null;
  }

  try {
    const session = await page.createCDPSession();
    const { windowId } = await session.send('Browser.getWindowForTarget');
    const { bounds = {} } = await session.send('Browser.getWindowBounds', { windowId });
    await session.detach();

    const width = Number(bounds.width || 0);
    const height = Number(bounds.height || 0);
    if (!(width > 0) || !(height > 0)) {
      return null;
    }

    return {
      width,
      height,
      state: String(bounds.windowState || 'normal'),
    };
  } catch {
    return null;
  }
}

export class BrowserController {
  constructor({ headless = false, enableHeadlessCalibration = true, maxPageWidth = 3840, maxPageHeight = 2160 } = {}) {
    this.headless = headless;
    // Explicit human-readable mode, derived from `headless`. Kept as the single source
    // of truth for gating headless-only behavior (e.g. dynamic click calibration) so
    // the proven headful mapping path is never touched.
    this.mode = headless ? 'headless' : 'headful';
    // Default on; disable via DAEMON_ENABLE_HEADLESS_CALIBRATION=false when needed.
    this.enableHeadlessCalibration = Boolean(enableHeadlessCalibration);
    this.maxPageWidth = Math.max(640, maxPageWidth);
    this.maxPageHeight = Math.max(480, maxPageHeight);
    this.browser = null;
    this.page = null;
    this.targetPage = null;
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
    const launchWindowWidth = Math.max(1, Math.min(this.maxPageWidth, SIMULATED_DISPLAY_WIDTH));
    const launchWindowHeight = Math.max(1, Math.min(this.maxPageHeight, SIMULATED_DISPLAY_HEIGHT));
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
    // Dynamic capture-to-content calibration (headless mode only). null until a
    // successful calibration handshake with the client has been applied.
    this.activeCalibration = null;
    // Cache for source dimensions with validation
    this.lastSourceDimensions = { width: 0, height: 0, timestamp: 0, sequence: 0 };
    // Cache for target page viewport (avoids CDP round-trip per mouse_move)
    this.lastViewportDimensions = { width: 0, height: 0, pageUrl: '', timestamp: 0 };
    // Cache for the actual browser window / capture surface.
    this.lastCaptureSurfaceDimensions = { width: 0, height: 0, state: '', pageUrl: '', timestamp: 0 };
    this.lastGeometrySnapshotSignature = '';
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
    return this.browserConnectionMode === 'attached' ? 'CDP' : 'putter';
  }

  shouldPreserveBrowserOnExit() {
    return this.getRuntimeMode() === 'CDP';
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
      logger.warn(`Attach to existing Chrome skipped: no DevTools WebSocket endpoint found on port ${this.remoteDebuggingPort} (checked http://127.0.0.1:${this.remoteDebuggingPort}/json/version and DevToolsActivePort file in ${this.userDataDir}). Falling back to launching a new Chrome without proxy/profile settings from the external process.`);
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

  async hydrateKnownPages() {
    if (!this.browser) {
      return;
    }

    const pages = await this.browser.pages();
    const daemonPage = pages.find((entry) => isDaemonControlUrl(entry.url()));
    const targetCandidate = pages.find((entry) => {
      const url = String(entry.url() || '').trim();
      if (!url || url === 'about:blank') {
        return false;
      }
      return !isDaemonControlUrl(url);
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
      // No viewport set here: the daemon control page is never shared or measured,
      // so its viewport size is irrelevant. Only the target page's viewport matters
      // (see optimizeViewportForPageSize()).
    }
    return this.page;
  }

  async ensureTargetPage() {
    await this.launchIfNeeded();
    if (!this.targetPage || (typeof this.targetPage.isClosed === 'function' && this.targetPage.isClosed())) {
      this.targetPage = await this.browser.newPage();
      await this.targetPage.setUserAgent('agentic-browser-target');
      // No initial viewport set here: every caller that creates a brand-new target page
      // goes through openTarget(), which immediately calls optimizeViewportForPageSize()
      // afterward and unconditionally applies the correct baseline/optimal viewport via
      // CDP + setViewport. Setting a viewport here would just be overwritten right away.
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
    if (isDaemonControlUrl(resolvedUrl)) {
      const daemonPage = await this.ensureDaemonPage();
      await daemonPage.goto(resolvedUrl, { waitUntil: 'domcontentloaded' });
      logger.info('daemon opened in background; restoring focus to target page when available.');
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
    
    // Optimize viewport based on actual page size before screen sharing
    await this.optimizeViewportForPageSize(page);
    
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

    // Update source dimension cache if provided in payload
    const providedSx = Number(payload.sx ?? 0);
    const providedSy = Number(payload.sy ?? 0);
    const hasNewDimensions = (providedSx > 0 && providedSy > 0);
    
    if (hasNewDimensions) {
      // Check if dimensions changed (possible resolution change or new stream)
      const dimensionChanged = 
        providedSx !== this.lastSourceDimensions.width || 
        providedSy !== this.lastSourceDimensions.height;
      
      if (dimensionChanged) {
        logger.debug('Source dimension cache updated', {
          old: this.lastSourceDimensions,
          new: { width: providedSx, height: providedSy },
        });
      }
      
      // Update cache with new dimensions and sequence number for freshness tracking
      this.lastSourceDimensions = {
        width: providedSx,
        height: providedSy,
        timestamp: Date.now(),
        sequence: (this.lastSourceDimensions.sequence || 0) + 1,
      };
    }
    
    // Use cached dimensions if not provided in payload (common for mouse_move)
    // BUT: Only use cache if it has valid dimensions AND is not too stale (>30sec)
    const cacheAge = Date.now() - this.lastSourceDimensions.timestamp;
    const cacheIsStale = cacheAge > 30000;  // 30 second staleness threshold
    
    let effectivePayload = { ...payload };
    
    if (!effectivePayload.sx && this.lastSourceDimensions.width > 0 && !cacheIsStale) {
      effectivePayload.sx = this.lastSourceDimensions.width;
    }
    if (!effectivePayload.sy && this.lastSourceDimensions.height > 0 && !cacheIsStale) {
      effectivePayload.sy = this.lastSourceDimensions.height;
    }
    
    // If cache is stale or empty, warn but don't fail silently
    if (!effectivePayload.sx || !effectivePayload.sy) {
      if (cacheIsStale && this.lastSourceDimensions.width > 0) {
        logger.warn('Using stale dimension cache (>30s old)', {
          age: cacheAge,
          cached: this.lastSourceDimensions,
        });
      }
      if (!this.lastSourceDimensions.width) {
        logger.warn('No valid cached dimensions available', {
          sequence: this.lastSourceDimensions.sequence,
          coordinate: { x: effectivePayload.x, y: effectivePayload.y },
        });
      }
    }

    const VIEWPORT_CACHE_TTL_MS = 5000;
    const currentPageUrl = page.url ? page.url() : '';
    const viewportCacheAge = Date.now() - this.lastViewportDimensions.timestamp;
    const viewportCacheValid =
      this.lastViewportDimensions.width > 0 &&
      this.lastViewportDimensions.pageUrl === currentPageUrl &&
      viewportCacheAge < VIEWPORT_CACHE_TTL_MS;

    let viewport;
    if (viewportCacheValid) {
      viewport = { width: this.lastViewportDimensions.width, height: this.lastViewportDimensions.height };
    } else {
      viewport = await page.evaluate(() => ({
        width: window.innerWidth || document.documentElement.clientWidth || 1,
        height: window.innerHeight || document.documentElement.clientHeight || 1,
      }));
      this.lastViewportDimensions = {
        width: viewport.width,
        height: viewport.height,
        pageUrl: currentPageUrl,
        timestamp: Date.now(),
      };
    }

    const viewportContext = {
      targetWidth: viewport.width,
      targetHeight: viewport.height,
    };

    const calibration = this.activeCalibration;
    const currentSx = Number(effectivePayload.sx || 0);
    const currentSy = Number(effectivePayload.sy || 0);

    const captureSurfaceCacheAge = Date.now() - this.lastCaptureSurfaceDimensions.timestamp;
    const captureSurfaceCacheValid =
      this.lastCaptureSurfaceDimensions.width > 0 &&
      this.lastCaptureSurfaceDimensions.pageUrl === currentPageUrl &&
      captureSurfaceCacheAge < VIEWPORT_CACHE_TTL_MS;

    let captureSurface = null;
    if (captureSurfaceCacheValid) {
      captureSurface = {
        width: this.lastCaptureSurfaceDimensions.width,
        height: this.lastCaptureSurfaceDimensions.height,
        state: this.lastCaptureSurfaceDimensions.state,
      };
    } else {
      captureSurface = await readCaptureSurfaceDimensions(page);
      this.lastCaptureSurfaceDimensions = {
        width: Number(captureSurface?.width || 0),
        height: Number(captureSurface?.height || 0),
        state: String(captureSurface?.state || ''),
        pageUrl: currentPageUrl,
        timestamp: Date.now(),
      };
    }

    const geometrySnapshotSignature = [
      this.headless ? 'headless' : 'headful',
      `${viewportContext.targetWidth}x${viewportContext.targetHeight}`,
      `${Number(captureSurface?.width || 0)}x${Number(captureSurface?.height || 0)}`,
      `${currentSx}x${currentSy}`,
    ].join('|');

    if (geometrySnapshotSignature !== this.lastGeometrySnapshotSignature) {
      logger.info('[GEOMETRY] Coordinate geometry snapshot', {
        mode: this.mode,
        headless: this.headless,
        pageViewport: {
          width: viewportContext.targetWidth,
          height: viewportContext.targetHeight,
        },
        actualCaptureSurface: captureSurface ? {
          width: captureSurface.width,
          height: captureSurface.height,
          state: captureSurface.state,
        } : null,
        encodedWebRtcFrame: {
          width: currentSx,
          height: currentSy,
        },
      });
      this.lastGeometrySnapshotSignature = geometrySnapshotSignature;
    }

    // Dynamic capture-to-content calibration (headless mode only). The naive proportional
    // mapping in mapRemoteCoordinates() assumes the captured video's pixels map 1:1
    // (proportionally) onto the page's rendered content, which holds true in headful mode
    // but can drift in headless mode due to differences in Chromium's off-screen capture
    // pipeline. When a calibration has been computed (see setCalibration()), we try to reuse
    // it even if WebRTC has since changed the encoded resolution (e.g. bandwidth/CPU-driven
    // downscaling) -- see resolveCalibrationForSource() below. Any mismatch/absence safely
    // falls back to the existing proportional mapping used by headful mode.
    const resolvedCalibration = resolveCalibrationForSource(calibration, currentSx, currentSy);
    const useCalibration = this.headless && this.enableHeadlessCalibration && Boolean(resolvedCalibration);

    if (this.headless && calibration && !resolvedCalibration) {
      // Calibration exists but was skipped for this event; this would otherwise silently
      // fall back to the pre-calibration proportional mapping (same "y too small" bias).
      logger.warn('Calibration present but skipped for this coordinate (source size mismatch, not even a uniform rescale).', {
        payloadSx: currentSx,
        payloadSy: currentSy,
        calibrationSourceWidth: calibration.sourceWidth,
        calibrationSourceHeight: calibration.sourceHeight,
      });
    } else if (this.headless && resolvedCalibration && resolvedCalibration.rescaled) {
      // WebRTC changed the encoded resolution (bandwidth/CPU adaptation) since calibration was
      // computed, but the change was a uniform resize (same factor on both axes) of the
      // calibrated capture, so the original calibration's offset still applies and only the
      // scale needed adjusting. This keeps calibration valid across live resolution changes
      // instead of only working for the exact resolution captured at calibration time.
      logger.debug('Calibration adjusted for a uniformly rescaled source resolution.', {
        payloadSx: currentSx,
        payloadSy: currentSy,
        calibrationSourceWidth: calibration.sourceWidth,
        calibrationSourceHeight: calibration.sourceHeight,
        resizeFactorX: resolvedCalibration.resizeFactorX,
        resizeFactorY: resolvedCalibration.resizeFactorY,
      });
    }

    let mapped;
    let headfulCropGuardApplied = false;
    let headfulCropGuardDetails = null;
    if (useCalibration) {
      const rawX = Number(effectivePayload.x || 0);
      const rawY = Number(effectivePayload.y || 0);
      mapped = {
        x: Math.max(0, Math.min(viewportContext.targetWidth - 1, Math.round(rawX * resolvedCalibration.scaleX + resolvedCalibration.offsetX))),
        y: Math.max(0, Math.min(viewportContext.targetHeight - 1, Math.round(rawY * resolvedCalibration.scaleY + resolvedCalibration.offsetY))),
      };
    } else {
      mapped = mapRemoteCoordinates(effectivePayload, viewportContext);

      // Fallback crop guard: if encoded frame and page viewport aspect ratios diverge,
      // but only one axis is being scaled up, treat that axis as likely cropped (not downscaled)
      // and avoid amplifying coordinates there. This now applies in headless mode too, but only
      // on the non-calibrated path (we are in the `else` branch where useCalibration is false).
      if (currentSx > 0 && currentSy > 0) {
        const targetWidth = Math.max(1, Number(viewportContext.targetWidth || 1));
        const targetHeight = Math.max(1, Number(viewportContext.targetHeight || 1));
        const sourceWidth = Math.max(1, Number(currentSx || 1));
        const sourceHeight = Math.max(1, Number(currentSy || 1));

        const scaleX = targetWidth / sourceWidth;
        const scaleY = targetHeight / sourceHeight;
        const sourceAspect = sourceWidth / sourceHeight;
        const targetAspect = targetWidth / targetHeight;
        const aspectDrift = Math.abs(sourceAspect - targetAspect) / Math.max(1e-6, targetAspect);

        const inflationX = Math.max(0, scaleX - 1);
        const inflationY = Math.max(0, scaleY - 1);
        const oneAxisDominates = inflationX > inflationY * 1.5 || inflationY > inflationX * 1.5;
        const shouldApplyCropGuard = aspectDrift > 0.04 && oneAxisDominates && Math.max(inflationX, inflationY) > 0.03;

        if (shouldApplyCropGuard) {
          const guardedScaleX = inflationX > inflationY * 1.5 ? 1 : scaleX;
          const guardedScaleY = inflationY > inflationX * 1.5 ? 1 : scaleY;
          const rawX = Number(effectivePayload.x || 0);
          const rawY = Number(effectivePayload.y || 0);

          mapped = {
            x: Math.max(0, Math.min(targetWidth - 1, Math.round(rawX * guardedScaleX))),
            y: Math.max(0, Math.min(targetHeight - 1, Math.round(rawY * guardedScaleY))),
          };

          headfulCropGuardApplied = true;
          headfulCropGuardDetails = {
            sourceWidth,
            sourceHeight,
            targetWidth,
            targetHeight,
            scaleX,
            scaleY,
            guardedScaleX,
            guardedScaleY,
            sourceAspect,
            targetAspect,
            aspectDrift,
          };
        }
      }
    }

    logger.debug('resolveTargetCoordinates mapping decision', {
      headless: this.headless,
      calibrationActive: Boolean(calibration),
      usedCalibration: useCalibration,
      calibrationRescaled: Boolean(resolvedCalibration?.rescaled),
      headfulCropGuardApplied,
      headfulCropGuardDetails,
      raw: { x: Number(effectivePayload.x || 0), y: Number(effectivePayload.y || 0) },
      sourceDims: { sx: Number(effectivePayload.sx || 0), sy: Number(effectivePayload.sy || 0) },
      targetDims: viewportContext,
      mapped,
    });

    const hasViewportMapping =
      Number.isFinite(Number(effectivePayload.viewWidth)) && Number(effectivePayload.viewWidth) > 0 &&
      Number.isFinite(Number(effectivePayload.viewHeight)) && Number(effectivePayload.viewHeight) > 0;

    if (hasViewportMapping) {
      const legacyMapped = mapRemoteCoordinatesLegacy(effectivePayload, viewportContext);
      logger.debug('resolveTargetCoordinates mapping comparison', {
        source: {
          x: Number(effectivePayload.x || 0),
          y: Number(effectivePayload.y || 0),
        },
        viewport: {
          viewScrollLeft: Number(effectivePayload.viewScrollLeft || 0),
          viewScrollTop: Number(effectivePayload.viewScrollTop || 0),
          viewWidth: Number(effectivePayload.viewWidth || 0),
          viewHeight: Number(effectivePayload.viewHeight || 0),
        },
        cache: {
          width: this.lastSourceDimensions.width,
          height: this.lastSourceDimensions.height,
          age: cacheAge,
          sequence: this.lastSourceDimensions.sequence,
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

  async injectCalibrationMarkers() {
    if (!this.hasTargetPage()) {
      throw new Error('No Puppeteer target page is open to calibrate.');
    }

    const page = this.targetPage;
    const currentViewport = page.viewport() || {};
    const targetWidth = Math.max(1, Number(currentViewport.width || 0));
    const targetHeight = Math.max(1, Number(currentViewport.height || 0));
    const markerSize = 40;

    // A single fixed pair of corner markers turned out to be fragile: the captured/transmitted
    // video frame has been observed to be CROPPED (not just scaled) relative to the real page,
    // by an amount that varies between runs/pages -- sometimes clipping the bottom-right corner,
    // other times clipping enough of the top-left that even an 8%-inset marker misses. There is
    // no single "safe" pair of positions that reliably survives every crop.
    //
    // Inject a top-heavy multi-row marker layout. Headless capture crops on mobile are often
    // biased toward bottom clipping, so concentrating more anchors in the upper half increases
    // the chance that >=2 markers survive even when lower rows are cut off.
    const xFractions = [0.1, 0.33, 0.5, 0.67, 0.9];
    const yFractions = [0.08, 0.18, 0.32, 0.52, 0.76];
    // Avoid colors that commonly collide with real page content: pure white/black (page
    // backgrounds/text), and "sky blue" ~(0,128,255) which sits within tolerance of the
    // extremely common Bootstrap/web link blue #007bff (0,123,255) -- both were observed in
    // practice to produce false-positive matches against real page pixels, corrupting the
    // computed marker centroid entirely (residual of hundreds of pixels). Even so, some page
    // may still coincidentally use one of these colors, which is why setCalibration() also runs
    // outlier rejection on top of this palette rather than trusting every correspondence blindly.
    const palette = [
      [255, 0, 255], // magenta
      [0, 255, 255], // cyan
      [255, 255, 0], // yellow
      [255, 0, 0], // red
      [0, 255, 0], // green
      [255, 0, 128], // rose
      [255, 128, 0], // orange
      [128, 0, 255], // purple
      [128, 255, 0], // lime
      [255, 64, 64], // coral
      [64, 255, 64], // mint
      [255, 192, 0], // amber
      [192, 64, 255], // violet
      [64, 255, 192], // aqua-mint
      [255, 64, 192], // pink
      [64, 192, 255], // azure
      [192, 255, 64], // chartreuse
      [255, 160, 64], // apricot
      [160, 64, 255], // indigo
      [64, 160, 255], // steel-cyan
      [255, 96, 0], // vivid orange
      [96, 255, 0], // vivid lime
      [255, 0, 96], // vivid rose
      [0, 255, 96], // vivid spring
      [96, 0, 255], // vivid violet
    ];

    const markerCount = xFractions.length * yFractions.length;
    if (palette.length < markerCount) {
      throw new Error(`Calibration marker palette too small: have ${palette.length}, need ${markerCount}.`);
    }

    const markers = [];
    let colorIndex = 0;
    for (const yFraction of yFractions) {
      for (const xFraction of xFractions) {
        markers.push({
          id: `g${colorIndex}`,
          color: palette[colorIndex],
          domX: Math.max(markerSize / 2, Math.round(targetWidth * xFraction)),
          domY: Math.max(markerSize / 2, Math.round(targetHeight * yFraction)),
        });
        colorIndex += 1;
      }
    }

    await page.evaluate((markersToInject, size) => {
      const existing = document.getElementById('__agentic_calibration_layer__');
      if (existing) {
        existing.remove();
      }

      const layer = document.createElement('div');
      layer.id = '__agentic_calibration_layer__';
      layer.style.position = 'fixed';
      layer.style.top = '0';
      layer.style.left = '0';
      layer.style.width = '100%';
      layer.style.height = '100%';
      layer.style.zIndex = '2147483647';
      layer.style.pointerEvents = 'none';
      // Force our own top-level stacking context so page content with its own
      // transform/opacity/filter-based stacking contexts can't paint above these markers.
      layer.style.isolation = 'isolate';

      markersToInject.forEach((marker) => {
        const dot = document.createElement('div');
        dot.style.position = 'absolute';
        dot.style.left = `${marker.domX - size / 2}px`;
        dot.style.top = `${marker.domY - size / 2}px`;
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
        dot.style.background = `rgb(${marker.color[0]}, ${marker.color[1]}, ${marker.color[2]})`;
        layer.appendChild(dot);
      });

      document.documentElement.appendChild(layer);
    }, markers, markerSize);

    logger.debug('Injected calibration markers.', { markers, targetWidth, targetHeight });

    return { markers, targetWidth, targetHeight };
  }

  async removeCalibrationMarkers() {
    if (!this.hasTargetPage()) {
      return;
    }

    try {
      await this.targetPage.evaluate(() => {
        const existing = document.getElementById('__agentic_calibration_layer__');
        if (existing) {
          existing.remove();
        }
      });
    } catch (error) {
      logger.warn(`Failed to remove calibration markers: ${error.message}`);
    }
  }

  setCalibration(correspondences = [], { sourceWidth = 0, sourceHeight = 0 } = {}) {
    if (!Array.isArray(correspondences) || correspondences.length < 2) {
      logger.warn('Rejected calibration: fewer than 2 marker correspondences.', {
        count: Array.isArray(correspondences) ? correspondences.length : 0,
      });
      return false;
    }

    const validPoints = correspondences.filter((point) =>
      Number.isFinite(Number(point?.domX)) &&
      Number.isFinite(Number(point?.domY)) &&
      Number.isFinite(Number(point?.videoX)) &&
      Number.isFinite(Number(point?.videoY))
    );

    if (validPoints.length < 2) {
      logger.warn('Rejected calibration: fewer than 2 valid (finite) marker correspondences.', {
        count: validPoints.length,
      });
      return false;
    }

    // Robust fit across all detected correspondences (not just the first 2, and not blindly
    // trusting every one either). With the 3x3 marker grid, however many points survive whatever
    // cropping/occlusion occurred on this particular page/run are candidates, but a marker's
    // color can coincidentally collide with real page content (e.g. common web link blues,
    // white backgrounds) producing a wildly wrong centroid for that one point. robustFitAxis()
    // uses a RANSAC-style pairwise search to find and discard such outliers per axis before the
    // final least-squares fit, so a minority of corrupted correspondences can't skew the result.
    const fitX = robustFitAxis(validPoints, 'videoX', 'domX');
    const fitY = robustFitAxis(validPoints, 'videoY', 'domY');

    if (!fitX || !fitY) {
      logger.warn('Rejected calibration: marker points are degenerate (no spread on one axis, or too few inliers).', {
        count: validPoints.length,
      });
      return false;
    }

    const { scale: scaleX, offset: offsetX } = fitX;
    const { scale: scaleY, offset: offsetY } = fitY;

    // Guard against pathological fits that can happen when marker matches are sparse/noisy.
    // Applying such a calibration is worse than no calibration at all (it can collapse all
    // clicks onto an edge or near-constant Y). Prefer safe fallback proportional mapping.
    const minRequiredInliersPerAxis = validPoints.length >= 4 ? 3 : 2;
    if (fitX.inlierCount < minRequiredInliersPerAxis || fitY.inlierCount < minRequiredInliersPerAxis) {
      logger.warn('Rejected calibration: insufficient inliers after outlier rejection.', {
        totalPoints: validPoints.length,
        minRequiredInliersPerAxis,
        xInlierCount: fitX.inlierCount,
        yInlierCount: fitY.inlierCount,
      });
      return false;
    }

    if (![scaleX, scaleY, offsetX, offsetY].every(Number.isFinite)) {
      logger.warn('Rejected calibration: computed scale/offset is not finite.', { scaleX, scaleY, offsetX, offsetY });
      return false;
    }

    if (scaleX <= 0 || scaleY <= 0) {
      logger.warn('Rejected calibration: non-positive scale indicates invalid axis orientation.', {
        scaleX,
        scaleY,
      });
      return false;
    }

    // Keep calibration within a broad-but-finite practical range. Values outside this range
    // indicate mismatched correspondences rather than real capture-to-page geometry.
    if (scaleX < 0.2 || scaleX > 5 || scaleY < 0.2 || scaleY > 5) {
      logger.warn('Rejected calibration: scale out of sane range.', {
        scaleX,
        scaleY,
        allowedRange: { min: 0.2, max: 5 },
      });
      return false;
    }

    // Additional geometric sanity check against the current target viewport. Even if an axis
    // scale is technically finite/positive, a bad correspondence subset can still produce a fit
    // that maps the full source axis into only a tiny fraction of the page (or far beyond it),
    // which causes severe click collapse (e.g. all Y values bunched near the top).
    const viewport = this.targetPage?.viewport?.() || null;
    const targetWidth = Math.max(1, Number(viewport?.width || 0));
    const targetHeight = Math.max(1, Number(viewport?.height || 0));
    const resolvedSourceWidth = Math.max(1, Number(sourceWidth) || 1);
    const resolvedSourceHeight = Math.max(1, Number(sourceHeight) || 1);
    if (targetWidth > 0 && targetHeight > 0) {
      const projectedSpanX = Math.abs(scaleX) * resolvedSourceWidth;
      const projectedSpanY = Math.abs(scaleY) * resolvedSourceHeight;
      const spanRatioX = projectedSpanX / targetWidth;
      const spanRatioY = projectedSpanY / targetHeight;

      const minSpanRatio = 0.55;
      const maxSpanRatio = 2.2;
      if (
        spanRatioX < minSpanRatio || spanRatioX > maxSpanRatio ||
        spanRatioY < minSpanRatio || spanRatioY > maxSpanRatio
      ) {
        logger.warn('Rejected calibration: transformed source span is implausible for current viewport.', {
          scaleX,
          scaleY,
          sourceWidth: resolvedSourceWidth,
          sourceHeight: resolvedSourceHeight,
          targetWidth,
          targetHeight,
          projectedSpanX,
          projectedSpanY,
          spanRatioX,
          spanRatioY,
          allowedSpanRatio: { min: minSpanRatio, max: maxSpanRatio },
        });
        return false;
      }
    }

    if (fitX.outlierCount > 0 || fitY.outlierCount > 0) {
      logger.warn('Calibration discarded outlier marker correspondence(s) before fitting.', {
        totalPoints: validPoints.length,
        xInliers: fitX.inlierIds,
        xOutlierCount: fitX.outlierCount,
        yInliers: fitY.inlierIds,
        yOutlierCount: fitY.outlierCount,
      });
    }

    this.activeCalibration = {
      scaleX,
      scaleY,
      offsetX,
      offsetY,
      sourceWidth: Math.max(1, Number(sourceWidth) || 0),
      sourceHeight: Math.max(1, Number(sourceHeight) || 0),
      computedAt: Date.now(),
      pointCount: validPoints.length,
      xInlierCount: fitX.inlierCount,
      yInlierCount: fitY.inlierCount,
    };

    logger.info('Applied dynamic capture-to-content calibration.', this.activeCalibration);
    return true;
  }

  clearCalibration() {
    this.activeCalibration = null;
  }

  async resizeBrowserWindow(width, height) {
    if (!this.hasTargetPage()) {
      return false;
    }

    try {
      const session = await this.targetPage.createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: Math.round(width), height: Math.round(height) },
      });
      await session.detach();
      logger.info('Resized actual browser window (real capture surface, not just the page viewport emulation).', {
        width: Math.round(width),
        height: Math.round(height),
      });
      return true;
    } catch (error) {
      // This can fail for attached/remote-debugging sessions in some environments
      // (e.g. sandboxed containers without a real window manager). Emulation.setDeviceMetricsOverride
      // still applies to page rendering even if this fails; only the capture-surface size stays
      // whatever the real window already was.
      logger.warn(`Failed to resize actual browser window via CDP Browser.setWindowBounds: ${error.message}`);
      return false;
    }
  }

  async optimizeViewportForPageSize(page) {
    try {
      // window.screen.availWidth/availHeight cannot be trusted here: it reflects Chromium's
      // emulated "screen" descriptor, which is independent of the real rendering
      // viewport/window and is NOT updated by launch flags like --window-size=1920,1080.
      // In headless mode it commonly stays stuck at a bogus 800x600.
      //
      // Instead of reading a screen size from the page, explicitly SIMULATE one via CDP's
      // Emulation.setDeviceMetricsOverride (screenWidth/screenHeight), which Puppeteer's
      // high-level page.setViewport() does not set on its own. This also fixes the separate
      // issue where a reused/attached page (picked up via hydrateKnownPages()) never gets
      // ensureTargetPage()'s baseline viewport, since we apply it here unconditionally.
      //
      // IMPORTANT: Emulation.setDeviceMetricsOverride only changes what the PAGE thinks its
      // own viewport is. It does NOT resize the actual OS-level browser window/screen. When
      // attached to an already-running Chrome (remote-debugging-port), getDisplayMedia's
      // tab/desktop capture reflects the REAL window size, independent of this page-level
      // override -- this was observed to cause a large capture-vs-page mismatch (e.g. video
      // captured at 800x390 while the page viewport was emulated at 1905x1080, different
      // aspect ratios entirely). So we also explicitly resize the real browser window via
      // Browser.setWindowBounds to keep the actual capture surface in sync.
      const baselineWidth = Math.max(1, Math.min(this.maxPageWidth, SIMULATED_DISPLAY_WIDTH));
      const baselineHeight = Math.max(1, Math.min(this.maxPageHeight, SIMULATED_DISPLAY_HEIGHT));

      await this.resizeBrowserWindow(baselineWidth, baselineHeight);

      try {
        const cdpSession = await page.createCDPSession();
        await cdpSession.send('Emulation.setDeviceMetricsOverride', {
          width: baselineWidth,
          height: baselineHeight,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: baselineWidth,
          screenHeight: baselineHeight,
        });
        await cdpSession.detach();
      } catch (cdpError) {
        logger.warn(`Failed to simulate display size via CDP: ${cdpError.message}`);
      }

      // Keep Puppeteer's own viewport tracking (page.viewport()) in sync with the CDP override.
      await page.setViewport({ width: baselineWidth, height: baselineHeight });

      // Measure actual page content dimensions
      const pageDimensions = await page.evaluate(() => ({
        scrollWidth: document.scrollingElement?.scrollWidth || document.body.scrollWidth || 0,
        scrollHeight: document.scrollingElement?.scrollHeight || document.body.scrollHeight || 0,
      }));

      const actualWidth = Math.max(1, pageDimensions.scrollWidth || 0);
      const actualHeight = Math.max(1, pageDimensions.scrollHeight || 0);

      // The simulated display size (baselineWidth/baselineHeight) is the base/ceiling for the
      // viewport: shrink to fit smaller content, but never exceed the simulated display or the
      // configured max limits.
      const optimalWidth = Math.min(actualWidth, this.maxPageWidth, baselineWidth);
      const optimalHeight = Math.min(actualHeight, this.maxPageHeight, baselineHeight);

      logger.info(`Optimizing viewport for page size`, {
        simulatedDisplay: { width: baselineWidth, height: baselineHeight },
        actualSize: { width: actualWidth, height: actualHeight },
        maxLimit: { width: this.maxPageWidth, height: this.maxPageHeight },
        optimalSize: { width: optimalWidth, height: optimalHeight },
      });

      // Set viewport to optimal size
      await page.setViewport({ width: optimalWidth, height: optimalHeight });
      await this.resizeBrowserWindow(optimalWidth, optimalHeight);
      
      // Wait for layout/reflow after viewport change
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 2000 }).catch(() => {
        // Ignore timeout, proceed anyway
      });
    } catch (error) {
      logger.warn(`Failed to optimize viewport for page size: ${error.message}`);
      // Continue anyway, use current viewport
    }
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

    // Mouse input commands are high-frequency and must not call bringToFront on every event.
    // Use getActiveControlPage() (sync, no IPC) for all pointer/keyboard operations.
    // prepareTargetPage() (which calls bringToFront) is only needed for structural commands.
    const isFastMouseCommand = type === 'mouse_move' || type === 'mouse_down' || type === 'mouse_up' || type === 'mouse_click';
    const page = isFastMouseCommand
      ? this.getActiveControlPage()
      : await this.prepareTargetPage();

    if (!page) {
      return { ok: false, error: 'No active page available for command.', bridge: 'puppeteer' };
    }

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

  // Close ONLY the daemon.html control page. Used during session termination
  // cleanup (client finish/leave or timeout) so the control tab is dismissed while
  // the target page and the browser itself are left untouched.
  async closeDaemonPage() {
    if (!this.browser) {
      return;
    }

    let pages = [];
    try {
      pages = await this.browser.pages();
    } catch (error) {
      logger.warn(`closeDaemonPage: failed to list pages: ${error.message}`);
      return;
    }

    for (const entry of pages) {
      let url = '';
      try {
        url = String(entry.url() || '');
        logger.debug(`closeDaemonPage: checking page URL: ${url}`);
      } catch {
        continue;
      }
      if (!/\/daemon\.html(?:[?#]|$)/i.test(url)) {
        continue;
      }
      if (typeof entry.isClosed === 'function' && entry.isClosed()) {
        if (entry === this.page) {
          this.page = null;
        }
        continue;
      }
      try {
        await entry.close();
      } catch (error) {
        logger.warn(`closeDaemonPage: failed to close page: ${error.message}`);
      }
      if (entry === this.page) {
        this.page = null;
      }
    }
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

    // Puppeteer's disconnect() returns a Promise; await it inside try/catch so a
    // rejection can't escape as an unhandled rejection. The caller's shutdown
    // failsafe covers the case where the CDP socket never closes cleanly.
    try {
      await this.browser.disconnect();
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

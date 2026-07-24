import { createLogger } from '../logger.js';
import {
  mapRemoteCoordinates,
  mapCalibratedCoordinates,
  applyCropGuard,
  resolveCalibrationForSource,
} from './coordinateMath.js';
import { InputController } from './inputController.js';
import { BrowserLauncher } from './browserLauncher.js';
import { CalibrationController } from './calibrationController.js';
import { ViewportManager } from './viewportManager.js';
import { SnapshotService } from './snapshotService.js';

const logger = createLogger('browser-controller');
const AUTO_SHARE_SOURCE_TITLE = String(process.env.DAEMON_AUTO_SHARE_SOURCE_TITLE || 'DUC Target').trim();
// Simulated display size used as the base/ceiling for the shared viewport. window.screen.width/
// height/availWidth/availHeight cannot be trusted in headless Chrome (see ViewportManager), so
// instead of reading a "screen size" from the page, we explicitly emulate one via CDP.
const SIMULATED_DISPLAY_WIDTH = 1920;
const SIMULATED_DISPLAY_HEIGHT = 1080;

// The daemon control page (daemon.html) is opened in the background; every
// other non-blank page is treated as the shareable target page.
function isDaemonControlUrl(url = '') {
  return /\/daemon\.html(?:[?#]|$)/i.test(String(url || ''));
}

// Controls the two Chrome pages the daemon drives -- the background daemon.html
// control page (WebRTC/signaling) and the shared target page it replays client
// input onto -- and maps captured-video coordinates to target-page coordinates.
// Cross-cutting concerns are delegated to focused collaborators: BrowserLauncher
// (launch/attach), CalibrationController (headless click calibration), ViewportManager
// (viewport/capture geometry), SnapshotService (screenshots), and InputController
// (pointer/keyboard replay).
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

    // Cache for source (encoded video) dimensions, kept here because the coordinate
    // mapping that consumes it lives on this class.
    this.lastSourceDimensions = { width: 0, height: 0, timestamp: 0, sequence: 0 };
    this.lastGeometrySnapshotSignature = '';

    // Collaborators. Each is given only the narrow page accessors it needs, so it
    // never has to know how pages are launched or hydrated.
    this.launcher = new BrowserLauncher({
      headless: this.headless,
      maxPageWidth: this.maxPageWidth,
      maxPageHeight: this.maxPageHeight,
      simulatedDisplayWidth: SIMULATED_DISPLAY_WIDTH,
      simulatedDisplayHeight: SIMULATED_DISPLAY_HEIGHT,
    });
    this.calibration = new CalibrationController({
      hasTargetPage: () => this.hasTargetPage(),
      getTargetPage: () => this.targetPage,
    });
    this.viewport = new ViewportManager({
      hasTargetPage: () => this.hasTargetPage(),
      getTargetPage: () => this.targetPage,
      maxPageWidth: this.maxPageWidth,
      maxPageHeight: this.maxPageHeight,
      simulatedDisplayWidth: SIMULATED_DISPLAY_WIDTH,
      simulatedDisplayHeight: SIMULATED_DISPLAY_HEIGHT,
    });
    this.snapshotService = new SnapshotService({
      hasTargetPage: () => this.hasTargetPage(),
      prepareTargetPage: () => this.prepareTargetPage(),
      describeTargetPage: () => this.describeTargetPage(),
    });
    // Input replay is delegated to a collaborator that only needs the active page.
    this.input = new InputController({ getActiveControlPage: () => this.getActiveControlPage() });
  }

  // Connection state is owned by the launcher; expose it read-only for callers and logs.
  get browserConnectionMode() {
    return this.launcher.browserConnectionMode;
  }

  get remoteDebuggingPort() {
    return this.launcher.remoteDebuggingPort;
  }

  configureLaunch(config = {}) {
    this.launcher.configureLaunch(config);
  }

  getRuntimeMode() {
    return this.browserConnectionMode === 'attached' ? 'CDP' : 'puppeteer';
  }

  shouldPreserveBrowserOnExit() {
    return this.getRuntimeMode() === 'CDP';
  }

  async launchIfNeeded() {
    if (this.browser) {
      return;
    }

    this.browser = await this.launcher.acquireBrowser();
    await this.hydrateKnownPages();
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
      // (see ViewportManager.optimizeViewportForPageSize()).
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
    await this.viewport.optimizeViewportForPageSize(page);

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

  // Resolves a remote (captured-video) coordinate to a target-page coordinate.
  // Orchestrates the source/viewport/capture caches, the headless calibration
  // decision, and the fallback proportional mapping; the heavy lifting lives in
  // the focused helpers below, in ViewportManager, and in coordinateMath.js.
  async resolveTargetCoordinates(payload = {}) {
    const page = this.targetPage;
    if (!page) {
      return { x: Number(payload.x || 0), y: Number(payload.y || 0) };
    }

    const { effectivePayload, cacheAge } = this.resolveSourceDimensions(payload);

    const currentPageUrl = page.url ? page.url() : '';
    const viewport = await this.viewport.readTargetViewport(page, currentPageUrl);
    const viewportContext = {
      targetWidth: viewport.width,
      targetHeight: viewport.height,
    };

    const calibration = this.calibration.getActiveCalibration();
    const currentSx = Number(effectivePayload.sx || 0);
    const currentSy = Number(effectivePayload.sy || 0);

    const captureSurface = await this.viewport.readCaptureSurface(page, currentPageUrl);
    this.logGeometrySnapshot({ viewportContext, captureSurface, currentSx, currentSy });

    // Dynamic capture-to-content calibration (headless mode only). The naive proportional
    // mapping in mapRemoteCoordinates() assumes the captured video's pixels map 1:1
    // (proportionally) onto the page's rendered content, which holds true in headful mode
    // but can drift in headless mode due to differences in Chromium's off-screen capture
    // pipeline. When a calibration has been computed (see CalibrationController.setCalibration()),
    // we try to reuse it even if WebRTC has since changed the encoded resolution (e.g.
    // bandwidth/CPU-driven downscaling) -- see resolveCalibrationForSource() below. Any
    // mismatch/absence safely falls back to the existing proportional mapping used by headful mode.
    const resolvedCalibration = resolveCalibrationForSource(calibration, currentSx, currentSy);
    const useCalibration = this.headless && this.enableHeadlessCalibration && Boolean(resolvedCalibration);
    this.logCalibrationDecision(calibration, resolvedCalibration, currentSx, currentSy);

    let mapped;
    let headfulCropGuardApplied = false;
    let headfulCropGuardDetails = null;
    if (useCalibration) {
      mapped = mapCalibratedCoordinates(effectivePayload, resolvedCalibration, viewportContext);
    } else {
      mapped = mapRemoteCoordinates(effectivePayload, viewportContext);

      // Fallback crop guard on the non-calibrated path (this `else` branch means
      // useCalibration is false); applies in headless mode too.
      const guard = applyCropGuard(effectivePayload, viewportContext, currentSx, currentSy);
      if (guard) {
        mapped = guard.mapped;
        headfulCropGuardApplied = true;
        headfulCropGuardDetails = guard.details;
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

    this.logViewportComparison(effectivePayload, viewportContext, mapped, cacheAge);

    return mapped;
  }

  // Refreshes the source-dimension cache from the payload's reported capture size
  // (sx/sy) and backfills those fields from cache for events that omit them (e.g.
  // high-frequency mouse_move). Returns the payload to map plus the cache age.
  resolveSourceDimensions(payload = {}) {
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

    const effectivePayload = { ...payload };

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

    return { effectivePayload, cacheAge };
  }

  // Logs the page/capture/encoded geometry once per distinct configuration, so
  // repeated identical events don't spam the log.
  logGeometrySnapshot({ viewportContext, captureSurface, currentSx, currentSy }) {
    const geometrySnapshotSignature = [
      this.headless ? 'headless' : 'headful',
      `${viewportContext.targetWidth}x${viewportContext.targetHeight}`,
      `${Number(captureSurface?.width || 0)}x${Number(captureSurface?.height || 0)}`,
      `${currentSx}x${currentSy}`,
    ].join('|');

    if (geometrySnapshotSignature === this.lastGeometrySnapshotSignature) {
      return;
    }

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

  // Diagnostic logging for whether the stored calibration was applied, skipped, or
  // adjusted for a uniformly rescaled source resolution (headless mode only).
  logCalibrationDecision(calibration, resolvedCalibration, currentSx, currentSy) {
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
  }

  // When the client reports viewport metadata, logs the viewport-aware vs. legacy
  // proportional mapping side by side to aid tuning. No effect on the returned value.
  logViewportComparison(effectivePayload, viewportContext, mapped, cacheAge) {
    const hasViewportMapping =
      Number.isFinite(Number(effectivePayload.viewWidth)) && Number(effectivePayload.viewWidth) > 0 &&
      Number.isFinite(Number(effectivePayload.viewHeight)) && Number(effectivePayload.viewHeight) > 0;

    if (!hasViewportMapping) {
      return;
    }

    const legacyMapped = mapRemoteCoordinates(effectivePayload, viewportContext);
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

  // --- Calibration -- delegated to CalibrationController (see constructor). ---
  async injectCalibrationMarkers() {
    return this.calibration.injectCalibrationMarkers();
  }

  async removeCalibrationMarkers() {
    return this.calibration.removeCalibrationMarkers();
  }

  setCalibration(correspondences = [], options = {}) {
    return this.calibration.setCalibration(correspondences, options);
  }

  clearCalibration() {
    this.calibration.clearCalibration();
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

  // Input replay -- delegated to InputController (see constructor).
  async moveMouse(x, y) {
    return this.input.moveMouse(x, y);
  }

  async mouseDown(x, y, button = 'left') {
    return this.input.mouseDown(x, y, button);
  }

  async mouseUp(x, y, button = 'left') {
    return this.input.mouseUp(x, y, button);
  }

  async clickMouse(x, y, button = 'left') {
    return this.input.clickMouse(x, y, button);
  }

  async inputText(text) {
    return this.input.inputText(text);
  }

  async pressKey(key) {
    return this.input.pressKey(key);
  }

  async deleteBackward() {
    return this.input.deleteBackward();
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
      } catch {
        continue;
      }
      if (!isDaemonControlUrl(url)) {
        continue;
      }
      if (typeof entry.isClosed === 'function' && entry.isClosed()) {
        if (entry === this.page) {
          this.page = null;
        }
        continue;
      }
      try {
        logger.info(`closeDaemonPage: close daemon page URL: ${url}`);
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
    this.launcher.resetConnectionMode();
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
    this.launcher.resetConnectionMode();
  }

  // --- Snapshots -- delegated to SnapshotService (see constructor). ---
  async captureTargetSnapshot(options = {}) {
    return this.snapshotService.captureTargetSnapshot(options);
  }

  async saveTargetSnapshotToFile(options = {}) {
    return this.snapshotService.saveTargetSnapshotToFile(options);
  }
}

import { createLogger } from '../logger.js';

const logger = createLogger('viewport-manager');

// Freshness window for the per-page viewport and capture-surface caches, which
// avoid a CDP round-trip on every high-frequency mouse event.
const VIEWPORT_CACHE_TTL_MS = 5000;

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

// Owns the target page's viewport geometry: it emulates a fixed "display" size,
// shrinks the viewport to fit the actual page content before sharing
// (optimizeViewportForPageSize), resizes the real capture surface, and serves the
// short-lived viewport / capture-surface caches read by the coordinate mapper.
export class ViewportManager {
  constructor({
    hasTargetPage,
    getTargetPage,
    maxPageWidth,
    maxPageHeight,
    simulatedDisplayWidth,
    simulatedDisplayHeight,
  }) {
    this.hasTargetPage = hasTargetPage;
    this.getTargetPage = getTargetPage;
    this.maxPageWidth = maxPageWidth;
    this.maxPageHeight = maxPageHeight;
    this.simulatedDisplayWidth = simulatedDisplayWidth;
    this.simulatedDisplayHeight = simulatedDisplayHeight;

    // Cache for target page viewport (avoids CDP round-trip per mouse_move)
    this.lastViewportDimensions = { width: 0, height: 0, pageUrl: '', timestamp: 0 };
    // Cache for the actual browser window / capture surface.
    this.lastCaptureSurfaceDimensions = { width: 0, height: 0, state: '', pageUrl: '', timestamp: 0 };
  }

  async resizeBrowserWindow(width, height) {
    if (!this.hasTargetPage()) {
      return false;
    }

    try {
      const session = await this.getTargetPage().createCDPSession();
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
      const baselineWidth = Math.max(1, Math.min(this.maxPageWidth, this.simulatedDisplayWidth));
      const baselineHeight = Math.max(1, Math.min(this.maxPageHeight, this.simulatedDisplayHeight));

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

  // Reads the target page's inner viewport (CSS pixels), served from a short-lived
  // per-page cache to avoid a page.evaluate round-trip on every event.
  async readTargetViewport(page, currentPageUrl) {
    const viewportCacheAge = Date.now() - this.lastViewportDimensions.timestamp;
    const viewportCacheValid =
      this.lastViewportDimensions.width > 0 &&
      this.lastViewportDimensions.pageUrl === currentPageUrl &&
      viewportCacheAge < VIEWPORT_CACHE_TTL_MS;

    if (viewportCacheValid) {
      return { width: this.lastViewportDimensions.width, height: this.lastViewportDimensions.height };
    }

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 1,
      height: window.innerHeight || document.documentElement.clientHeight || 1,
    }));
    this.lastViewportDimensions = {
      width: viewport.width,
      height: viewport.height,
      pageUrl: currentPageUrl,
      timestamp: Date.now(),
    };
    return { width: viewport.width, height: viewport.height };
  }

  // Reads the actual browser window / capture-surface bounds, served from a
  // short-lived per-page cache. May return null when bounds are unavailable.
  async readCaptureSurface(page, currentPageUrl) {
    const captureSurfaceCacheAge = Date.now() - this.lastCaptureSurfaceDimensions.timestamp;
    const captureSurfaceCacheValid =
      this.lastCaptureSurfaceDimensions.width > 0 &&
      this.lastCaptureSurfaceDimensions.pageUrl === currentPageUrl &&
      captureSurfaceCacheAge < VIEWPORT_CACHE_TTL_MS;

    if (captureSurfaceCacheValid) {
      return {
        width: this.lastCaptureSurfaceDimensions.width,
        height: this.lastCaptureSurfaceDimensions.height,
        state: this.lastCaptureSurfaceDimensions.state,
      };
    }

    const captureSurface = await readCaptureSurfaceDimensions(page);
    this.lastCaptureSurfaceDimensions = {
      width: Number(captureSurface?.width || 0),
      height: Number(captureSurface?.height || 0),
      state: String(captureSurface?.state || ''),
      pageUrl: currentPageUrl,
      timestamp: Date.now(),
    };
    return captureSurface;
  }
}

import { createLogger } from '../logger.js';
import { robustFitAxis } from './coordinateMath.js';

const logger = createLogger('calibration-controller');

// Owns the dynamic capture-to-content calibration used in headless mode: injects
// colored marker dots onto the target page, accepts the client-detected marker
// centroids, and fits a robust per-axis linear transform (setCalibration). The
// resulting calibration is read by the coordinate mapper via getActiveCalibration().
// Constructed with page accessors so it never manages pages itself.
export class CalibrationController {
  constructor({ hasTargetPage, getTargetPage }) {
    this.hasTargetPage = hasTargetPage;
    this.getTargetPage = getTargetPage;
    // null until a successful calibration handshake with the client has been applied.
    this.activeCalibration = null;
  }

  getActiveCalibration() {
    return this.activeCalibration;
  }

  async injectCalibrationMarkers() {
    if (!this.hasTargetPage()) {
      throw new Error('No Puppeteer target page is open to calibrate.');
    }

    const page = this.getTargetPage();
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
      await this.getTargetPage().evaluate(() => {
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
    const viewport = this.getTargetPage()?.viewport?.() || null;
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
}

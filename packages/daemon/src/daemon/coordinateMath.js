// Pure coordinate-mapping + calibration math. No I/O, no Puppeteer, no instance
// state -- everything is a function of its arguments.

// Proportional mapping from the reported source (video) resolution onto the
// target page's pixel space. Supports both the compact (sx/sy) and legacy
// (sourceWidth/sourceHeight) payload shapes.
export function mapRemoteCoordinates(payload = {}, { targetWidth = 1, targetHeight = 1 } = {}) {
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

// Applies a resolved calibration (per-axis scale + offset) to the reported source
// coordinate, clamped to the target viewport. Used by the headless calibration path.
export function mapCalibratedCoordinates(payload = {}, calibration, { targetWidth = 1, targetHeight = 1 } = {}) {
  const rawX = Number(payload.x || 0);
  const rawY = Number(payload.y || 0);
  return {
    x: Math.max(0, Math.min(targetWidth - 1, Math.round(rawX * calibration.scaleX + calibration.offsetX))),
    y: Math.max(0, Math.min(targetHeight - 1, Math.round(rawY * calibration.scaleY + calibration.offsetY))),
  };
}

// Fallback crop guard for the non-calibrated path: when the encoded frame and page
// viewport aspect ratios diverge but only one axis is being scaled up, treat that
// axis as likely cropped (not downscaled) and avoid amplifying coordinates there.
// Returns null when the guard does not apply, otherwise { mapped, details }.
export function applyCropGuard(payload = {}, { targetWidth: rawTargetWidth = 1, targetHeight: rawTargetHeight = 1 } = {}, currentSx, currentSy) {
  if (!(currentSx > 0) || !(currentSy > 0)) {
    return null;
  }

  const targetWidth = Math.max(1, Number(rawTargetWidth || 1));
  const targetHeight = Math.max(1, Number(rawTargetHeight || 1));
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

  if (!shouldApplyCropGuard) {
    return null;
  }

  const guardedScaleX = inflationX > inflationY * 1.5 ? 1 : scaleX;
  const guardedScaleY = inflationY > inflationX * 1.5 ? 1 : scaleY;
  const rawX = Number(payload.x || 0);
  const rawY = Number(payload.y || 0);

  return {
    mapped: {
      x: Math.max(0, Math.min(targetWidth - 1, Math.round(rawX * guardedScaleX))),
      y: Math.max(0, Math.min(targetHeight - 1, Math.round(rawY * guardedScaleY))),
    },
    details: {
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
    },
  };
}

// Fits a 1D linear model (domValue = scale * videoValue + offset) via ordinary least squares
// across an arbitrary number of correspondence points. Used by setCalibration() so calibration
// can use however many marker correspondences actually survived detection (>=2), instead of
// only ever trusting a single fixed pair of points.
export function fitLinearAxis(points = [], videoKey, domKey) {
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
export function robustFitAxis(points = [], videoKey, domKey, inlierThresholdPx = 15) {
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
export function resolveCalibrationForSource(calibration, sx, sy) {
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

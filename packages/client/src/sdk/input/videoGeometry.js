// Geometry helpers that map a DOM pointer position onto the coordinate space of
// the source video stream, accounting for object-fit letterboxing/pillarboxing.

export function getRenderedVideoContentRect(videoElement) {
  if (!videoElement) {
    throw new Error('A video element is required.');
  }

  const rect = videoElement.getBoundingClientRect();
  const sourceWidth = videoElement.videoWidth || rect.width;
  const sourceHeight = videoElement.videoHeight || rect.height;

  const containerAspect = rect.width / rect.height;
  const sourceAspect = sourceWidth / sourceHeight;

  let contentWidth = rect.width;
  let contentHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (Number.isFinite(containerAspect) && Number.isFinite(sourceAspect) && sourceWidth > 0 && sourceHeight > 0) {
    if (sourceAspect > containerAspect) {
      contentHeight = rect.width / sourceAspect;
      offsetY = (rect.height - contentHeight) / 2;
    } else {
      contentWidth = rect.height * sourceAspect;
      offsetX = (rect.width - contentWidth) / 2;
    }
  }

  return {
    rect,
    sourceWidth,
    sourceHeight,
    contentWidth,
    contentHeight,
    offsetX,
    offsetY,
    containerAspect,
    sourceAspect,
  };
}

export function mapPointerToVideoSpace(videoElement, pointerEvent) {
  if (!pointerEvent) {
    throw new Error('A pointer or mouse event is required.');
  }

  const videoBox = getRenderedVideoContentRect(videoElement);
  const localX = pointerEvent.clientX - videoBox.rect.left - videoBox.offsetX;
  const localY = pointerEvent.clientY - videoBox.rect.top - videoBox.offsetY;

  const clampedX = Math.max(0, Math.min(videoBox.contentWidth - 1, localX));
  const clampedY = Math.max(0, Math.min(videoBox.contentHeight - 1, localY));

  const x = Math.max(0, Math.min(videoBox.sourceWidth - 1, Math.round((clampedX / videoBox.contentWidth) * videoBox.sourceWidth)));
  const y = Math.max(0, Math.min(videoBox.sourceHeight - 1, Math.round((clampedY / videoBox.contentHeight) * videoBox.sourceHeight)));

  return {
    x,
    y,
    sourceWidth: videoBox.sourceWidth,
    sourceHeight: videoBox.sourceHeight,
    videoRect: {
      width: Math.round(videoBox.rect.width),
      height: Math.round(videoBox.rect.height),
    },
    contentRect: {
      width: Math.round(videoBox.contentWidth),
      height: Math.round(videoBox.contentHeight),
      offsetX: Math.round(videoBox.offsetX),
      offsetY: Math.round(videoBox.offsetY),
    },
    pointer: {
      clientX: Math.round(pointerEvent.clientX),
      clientY: Math.round(pointerEvent.clientY),
    },
  };
}

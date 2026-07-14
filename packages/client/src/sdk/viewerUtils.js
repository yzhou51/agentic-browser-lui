// Import shared binary encoding/decoding from local module
import {
  encodeMouseCommandBinary,
  decodeMouseCommandBinary,
} from './mouseCommandBinary.js';

// Re-export for backward compatibility
export { encodeMouseCommandBinary, decodeMouseCommandBinary };

// Button type constants for compact transmission
export const BUTTON_LEFT = 0;
export const BUTTON_MIDDLE = 1;
export const BUTTON_RIGHT = 2;

export function buttonNameToCode(buttonName) {
  switch (String(buttonName || '').toLowerCase()) {
    case 'middle':
      return BUTTON_MIDDLE;
    case 'right':
      return BUTTON_RIGHT;
    default:
      return BUTTON_LEFT;
  }
}

export function buttonCodeToName(buttonCode) {
  switch (Number(buttonCode || 0)) {
    case BUTTON_MIDDLE:
      return 'middle';
    case BUTTON_RIGHT:
      return 'right';
    default:
      return 'left';
  }
}

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

export function getPointerButtonName(pointerEvent, fallback = BUTTON_LEFT) {
  if (!pointerEvent) {
    return fallback;
  }

  if (pointerEvent.button === 2) {
    return BUTTON_RIGHT;
  }
  if (pointerEvent.button === 1) {
    return BUTTON_MIDDLE;
  }
  return BUTTON_LEFT;
}

export function buildViewerMousePayload(videoElement, pointerEvent, options = {}, commandType = 'mouse_move') {
  const mapped = mapPointerToVideoSpace(videoElement, pointerEvent);
  const buttonCode = options.button !== undefined ? options.button : getPointerButtonName(pointerEvent);
  
  // Command-specific optimization: omit unnecessary fields per command type
  const payload = {
    x: mapped.x,
    y: mapped.y,
  };

  // Add button code for commands that need it
  if (commandType !== 'mouse_move') {
    payload.b = buttonCode;
  }

  // Add source dimensions:
  // - Always for non-move commands (click/down/up)
  // - For mouse_move: ONLY if isDragging is true (to initialize/refresh cache)
  // - For mouse_move: omit if NOT dragging (pure movement, rely on cached dims)
  const isDragging = options.extraPayload?.isDragging ?? false;
  
  if (commandType !== 'mouse_move' || isDragging) {
    payload.sx = mapped.sourceWidth;
    payload.sy = mapped.sourceHeight;
  }

  // Merge ONLY transmittable viewport/coordinate data into payload
  // Exclude client-side control flags (isDragging, etc.) which shouldn't be transmitted
  if (options.extraPayload) {
    // Copy only viewport/context fields, skip control flags
    const transmittableFields = {
      viewScrollLeft: options.extraPayload.viewScrollLeft,
      viewScrollTop: options.extraPayload.viewScrollTop,
      viewWidth: options.extraPayload.viewWidth,
      viewHeight: options.extraPayload.viewHeight,
      viewSourceWidth: options.extraPayload.viewSourceWidth,
      viewSourceHeight: options.extraPayload.viewSourceHeight,
    };
    
    // Only add fields that have values (avoid null/undefined)
    Object.entries(transmittableFields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        payload[key] = value;
      }
    });
  }

  return {
    mapped,
    payload,
  };
}

export function createViewerMouseCommandSender({
  sendCommand,
  videoElement,
  getIsDragging = () => false,
  onPointerMapped,
  onBeforeSend,
  onAfterSend,
}) {
  if (typeof sendCommand !== 'function') {
    throw new Error('sendCommand must be a function.');
  }

  return async function sendViewerMouseCommand(type, pointerEvent, extraPayload = {}) {
    const { mapped, payload } = buildViewerMousePayload(videoElement, pointerEvent, {
      button: extraPayload.button,
      extraPayload,
    }, type);  // Pass command type for optimized payload

    if (onPointerMapped) {
      onPointerMapped(mapped, { type, pointerEvent, extraPayload, payload });
    }

    if (onBeforeSend) {
      onBeforeSend({ type, payload, mapped, pointerEvent, extraPayload });
    }

    // Always encode mouse_move events to binary format for ultra-compact transmission
    // Works for all clients (desktop and phone) to maximize bandwidth reduction
    let transmitPayload = payload;
    let usedBinaryEncoding = false;
    
    if (type === 'mouse_move') {
      transmitPayload = encodeMouseCommandBinary(
        type,
        payload.x,
        payload.y,
        payload.b ?? BUTTON_LEFT,
        payload.sx ?? 0,
        payload.sy ?? 0
      );
      usedBinaryEncoding = true;
    }

    const requestId = await sendCommand(type, transmitPayload);

    if (onAfterSend) {
      onAfterSend({ 
        type, 
        payload, 
        mapped, 
        requestId, 
        pointerEvent, 
        extraPayload,
        format: usedBinaryEncoding ? 'binary' : 'json',
      });
    }

    return { requestId, payload, mapped };
  };
}

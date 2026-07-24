import { mapPointerToVideoSpace } from './videoGeometry.js';
import { getPointerButtonCode, BUTTON_LEFT } from './mouseButtons.js';
import { encodeMouseCommand } from './mouseCommandCodec.js';

export function buildViewerMousePayload(videoElement, pointerEvent, options = {}, commandType = 'mouse_move') {
  const mapped = mapPointerToVideoSpace(videoElement, pointerEvent);
  const buttonCode = options.button !== undefined ? options.button : getPointerButtonCode(pointerEvent);

  // Command-specific optimization: omit unnecessary fields per command type.
  const payload = {
    x: mapped.x,
    y: mapped.y,
  };

  // Add button code for commands that need it.
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

  // Merge ONLY transmittable viewport/coordinate data into payload.
  // Exclude client-side control flags (isDragging, etc.) which shouldn't be transmitted.
  if (options.extraPayload) {
    const transmittableFields = {
      viewScrollLeft: options.extraPayload.viewScrollLeft,
      viewScrollTop: options.extraPayload.viewScrollTop,
      viewWidth: options.extraPayload.viewWidth,
      viewHeight: options.extraPayload.viewHeight,
      viewSourceWidth: options.extraPayload.viewSourceWidth,
      viewSourceHeight: options.extraPayload.viewSourceHeight,
    };

    // Only add fields that have values (avoid null/undefined).
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

    // Always encode mouse_move events to binary format for ultra-compact
    // transmission. Works for all clients (desktop and phone) to maximize
    // bandwidth reduction.
    let transmitPayload = payload;
    let usedBinaryEncoding = false;

    if (type === 'mouse_move') {
      transmitPayload = encodeMouseCommand(
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

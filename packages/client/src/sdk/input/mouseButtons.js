// Mouse button codes used for compact transmission (matches daemon-side values).
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

// Map a DOM pointer/mouse event's `button` to a compact button code.
export function getPointerButtonCode(pointerEvent, fallback = BUTTON_LEFT) {
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

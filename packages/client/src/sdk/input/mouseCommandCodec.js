/**
 * Shared binary encoding/decoding for mouse commands.
 * Used by both client and daemon for payload optimization.
 *
 * Binary format (11 bytes):
 * Byte 0: version (4 bits high) + command code (4 bits low)
 * Bytes 1-2: x coordinate (uint16, little-endian)
 * Bytes 3-4: y coordinate (uint16, little-endian)
 * Byte 5: button code (uint8)
 * Bytes 6-7: source width (uint16, little-endian, 0 = not included)
 * Bytes 8-9: source height (uint16, little-endian, 0 = not included)
 */

// Binary format constants
export const BINARY_FORMAT_VERSION = 1;
export const BINARY_COMMAND_MOUSE_MOVE = 0;
export const BINARY_COMMAND_MOUSE_CLICK = 1;
export const BINARY_COMMAND_MOUSE_DOWN = 2;
export const BINARY_COMMAND_MOUSE_UP = 3;

// Command type to code mapping
const COMMAND_TYPE_TO_CODE = {
  'mouse_move': BINARY_COMMAND_MOUSE_MOVE,
  'mouse_click': BINARY_COMMAND_MOUSE_CLICK,
  'mouse_down': BINARY_COMMAND_MOUSE_DOWN,
  'mouse_up': BINARY_COMMAND_MOUSE_UP,
};

// Code to command type mapping
const CODE_TO_COMMAND_TYPE = {
  [BINARY_COMMAND_MOUSE_MOVE]: 'mouse_move',
  [BINARY_COMMAND_MOUSE_CLICK]: 'mouse_click',
  [BINARY_COMMAND_MOUSE_DOWN]: 'mouse_down',
  [BINARY_COMMAND_MOUSE_UP]: 'mouse_up',
};

/**
 * Encode a mouse command to binary format.
 * @param {string} commandType - 'mouse_move', 'mouse_click', 'mouse_down', or 'mouse_up'
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} button - Button code (0=left, 1=middle, 2=right)
 * @param {number} sx - Source width (0 if not included)
 * @param {number} sy - Source height (0 if not included)
 * @returns {ArrayBuffer} 11-byte binary payload
 */
export function encodeMouseCommand(commandType, x, y, button = 0, sx = 0, sy = 0) {
  const buffer = new ArrayBuffer(11);
  const view = new DataView(buffer);

  const commandCode = COMMAND_TYPE_TO_CODE[commandType] ?? BINARY_COMMAND_MOUSE_MOVE;

  // Byte 0: version (4 bits high) + command (4 bits low)
  view.setUint8(0, (BINARY_FORMAT_VERSION << 4) | (commandCode & 0x0F));

  // Bytes 1-2: x coordinate (uint16, little-endian)
  view.setUint16(1, Math.max(0, Math.min(65535, x)), true);

  // Bytes 3-4: y coordinate (uint16, little-endian)
  view.setUint16(3, Math.max(0, Math.min(65535, y)), true);

  // Byte 5: button code
  view.setUint8(5, button & 0x03);

  // Bytes 6-7: source width (uint16, little-endian)
  view.setUint16(6, Math.max(0, Math.min(65535, sx)), true);

  // Bytes 8-9: source height (uint16, little-endian)
  view.setUint16(8, Math.max(0, Math.min(65535, sy)), true);

  return buffer;
}

/**
 * Decode a binary mouse command payload.
 * @param {ArrayBuffer} buffer - Binary payload (must be 11 bytes)
 * @returns {Object|null} Decoded command or null if invalid
 */
export function decodeMouseCommand(buffer) {
  if (!buffer || !(buffer instanceof ArrayBuffer)) {
    return null;
  }

  const view = new DataView(buffer);
  if (view.byteLength < 11) {
    return null;
  }

  // Byte 0: version + command
  const header = view.getUint8(0);
  const version = (header >> 4) & 0x0F;
  const commandCode = header & 0x0F;

  if (version !== BINARY_FORMAT_VERSION) {
    return null; // Unsupported version
  }

  const commandType = CODE_TO_COMMAND_TYPE[commandCode] || 'mouse_move';

  // Decode coordinates and parameters
  const x = view.getUint16(1, true);
  const y = view.getUint16(3, true);
  const button = view.getUint8(5);
  const sx = view.getUint16(6, true);
  const sy = view.getUint16(8, true);

  return {
    commandType,
    x,
    y,
    b: button,  // Use 'b' for compact field name
    sx: sx || undefined,
    sy: sy || undefined,
  };
}

/**
 * Normalize a mouse command payload - decode binary if needed, pass JSON through.
 * @param {ArrayBuffer|Object} payload - Binary or JSON payload
 * @returns {Object} Normalized payload
 */
export function normalizeMouseCommandPayload(payload) {
  // If payload is binary (ArrayBuffer), decode it
  if (payload instanceof ArrayBuffer) {
    const decoded = decodeMouseCommand(payload);
    if (decoded) {
      return decoded;
    }
  }

  // Otherwise, return JSON payload as-is
  return payload || {};
}

// Control messages that travel over the OWT *signaling* channel rather than the
// P2P *data* channel. These coordinate the session lifecycle (resolve handshake,
// daemon-online announcement, and finish/leave termination); everything else
// (mouse/keyboard/text input) goes over the data channel.
export const SIGNALING_MESSAGE_TYPES = Object.freeze([
  'resolve',
  'resolve_ack',
  'resolve-act',
  'resolve_result',
  'resolve-result',
  'daemon_online',
  'daemon-online',
  'finish',
  'leave',
]);

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function parsePotentialJson(value) {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Normalize the varied shapes an incoming peer/data-channel message event can
// take (OWT vs custom emitters) into a flat { origin, message } pair.
export function normalizeIncomingMessageEvent(event) {
  return {
    ...event,
    origin: asTrimmedString(
      event?.origin ?? event?.from ?? event?.peerId ?? event?.detail?.origin ?? event?.detail?.from
    ),
    message: event?.message ?? event?.data ?? event?.detail?.message ?? event?.detail?.data,
  };
}

// Extract a normalized (lowercased) message `type` from an object or JSON string.
export function resolveMessageType(message) {
  if (typeof message === 'object' && message !== null) {
    return asTrimmedString(message.type).toLowerCase();
  }
  if (typeof message === 'string') {
    const parsed = parsePotentialJson(message);
    return asTrimmedString(parsed?.type).toLowerCase();
  }
  return '';
}

export { asTrimmedString, parsePotentialJson };

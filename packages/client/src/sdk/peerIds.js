const DEFAULT_PEER_ID_SALT = 'agentic-browser-lui-peer-id-v1';

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toBase36Padded(value, minLength = 7) {
  return value.toString(36).padStart(minLength, '0');
}

export function createPeerIds(sessionId, salt = DEFAULT_PEER_ID_SALT) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    throw new Error('sessionId is required to generate peer ids.');
  }

  const normalizedSalt = String(salt || DEFAULT_PEER_ID_SALT).trim() || DEFAULT_PEER_ID_SALT;
  const hashInput = `${normalizedSalt}::${normalizedSessionId}`;
  const peerId = toBase36Padded(fnv1a32(hashInput));

  return {
    daemonId: `d-${peerId}`,
    clientId: `c-${peerId}`,
    peerId,
  };
}

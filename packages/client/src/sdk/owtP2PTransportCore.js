export const DIRECT_SIGNALING_TYPES = Object.freeze([
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

export function normalizeIncomingMessageEvent(event) {
  return {
    ...event,
    origin: asTrimmedString(
      event?.origin ?? event?.from ?? event?.peerId ?? event?.detail?.origin ?? event?.detail?.from
    ),
    message: event?.message ?? event?.data ?? event?.detail?.message ?? event?.detail?.data,
  };
}

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

export function createOwtP2PTransport({
  windowObject = window,
  getDesiredSession,
  onMessage,
  onConnected,
  onServerDisconnected,
  onReconnectNeeded,
  onRetrySend,
  onSignalingConnected,
  onP2PClientCreated,
  normalizeDirectSignalingMessage,
  directSignalingTypes = DIRECT_SIGNALING_TYPES,
} = {}) {
  let p2p = null;
  let signaling = null;
  let connected = false;
  let connectedSession = null;
  let signalingOnMessageProxy = null;
  let signalingOnMessageInternal = null;

  const directTypeSet = new Set(directSignalingTypes.map((type) => asTrimmedString(type).toLowerCase()).filter(Boolean));

  function isDirectSignalingType(type) {
    return directTypeSet.has(asTrimmedString(type).toLowerCase());
  }

  function getAllowedRemoteIds() {
    return Array.isArray(p2p?.allowedRemoteIds) ? [...p2p.allowedRemoteIds] : [];
  }

  function setAllowedRemoteIds(nextIds = []) {
    if (!p2p) {
      return;
    }
    p2p.allowedRemoteIds = Array.isArray(nextIds) ? nextIds.map((value) => asTrimmedString(value)).filter(Boolean) : [];
  }

  function setupSignalingMessageTap(nextSignaling) {
    if (!nextSignaling) {
      return;
    }

    const originalSignalingConnect = nextSignaling?.connect?.bind(nextSignaling);
    if (originalSignalingConnect) {
      nextSignaling.connect = async (loginInfo) => {
        const authenticatedUid = await originalSignalingConnect(loginInfo);
        if (typeof onSignalingConnected === 'function') {
          onSignalingConnected({
            uid: authenticatedUid,
            host: asTrimmedString(loginInfo?.host),
            token: asTrimmedString(loginInfo?.token),
          });
        }
        return authenticatedUid;
      };
    }

    signalingOnMessageProxy = async (origin, message) => {
      const parsed = typeof message === 'object' && message !== null ? message : parsePotentialJson(message);
      const parsedType = asTrimmedString(parsed?.type).toLowerCase();

      if (isDirectSignalingType(parsedType)) {
        const normalizedMessage = typeof normalizeDirectSignalingMessage === 'function'
          ? normalizeDirectSignalingMessage({ parsedType, parsed, rawMessage: message })
          : message;
        if (typeof onMessage === 'function') {
          await onMessage({ origin: asTrimmedString(origin), message: normalizedMessage });
        }
        return;
      }

      if (typeof signalingOnMessageInternal === 'function') {
        signalingOnMessageInternal(origin, message);
      }
    };

    Object.defineProperty(nextSignaling, 'onMessage', {
      configurable: true,
      enumerable: true,
      get: () => signalingOnMessageProxy,
      set: (handler) => {
        signalingOnMessageInternal = handler;
      },
    });
  }

  function createSessionKey(session = {}) {
    return JSON.stringify(session?.rtcConfiguration?.iceServers || []);
  }

  function sessionMatches(connectedSnapshot, desiredSession, allowedRemoteIds) {
    if (!connectedSnapshot) {
      return false;
    }
    if (connectedSnapshot.localId !== desiredSession.localId) {
      return false;
    }
    if (connectedSnapshot.remoteId !== desiredSession.remoteId) {
      return false;
    }
    if (connectedSnapshot.signalingServer !== desiredSession.signalingServer) {
      return false;
    }
    if (connectedSnapshot.sessionKey !== desiredSession.sessionKey) {
      return false;
    }
    return asTrimmedString(allowedRemoteIds[0]) === desiredSession.remoteId;
  }

  function readDesiredSession() {
    const desired = typeof getDesiredSession === 'function' ? getDesiredSession() : {};
    return {
      localId: asTrimmedString(desired.localId),
      remoteId: asTrimmedString(desired.remoteId),
      signalingServer: asTrimmedString(desired.signalingServer),
      rtcConfiguration: desired.rtcConfiguration || {},
      sessionKey: asTrimmedString(desired.sessionKey) || createSessionKey(desired),
      raw: desired,
    };
  }

  async function connect() {
    const desired = readDesiredSession();
    const { localId, remoteId, signalingServer, rtcConfiguration, sessionKey } = desired;

    if (!localId) {
      throw new Error('Local peer ID is required.');
    }
    if (!remoteId) {
      throw new Error('Remote peer ID is required.');
    }
    if (!signalingServer) {
      throw new Error('Signaling host is required.');
    }

    if (p2p) {
      try {
        p2p.disconnect();
      } catch {
        // Ignore stale disconnect errors.
      }
      p2p = null;
    }
    connected = false;

    signaling = new windowObject.SignalingChannel();
    setupSignalingMessageTap(signaling);

    p2p = new Owt.P2P.P2PClient({ rtcConfiguration }, signaling);
    p2p.allowedRemoteIds = [remoteId];

    if (typeof onP2PClientCreated === 'function') {
      onP2PClientCreated({ p2p, signaling, desiredSession: desired });
    }

    p2p.addEventListener('serverdisconnected', () => {
      connected = false;
      connectedSession = null;
      if (typeof onServerDisconnected === 'function') {
        onServerDisconnected({ localId, remoteId, signalingServer });
      }
    });

    p2p.addEventListener('messagereceived', async (event) => {
      if (typeof onMessage !== 'function') {
        return;
      }
      const normalized = normalizeIncomingMessageEvent(event);
      await onMessage({ origin: normalized.origin, message: normalized.message });
    });

    await p2p.connect({ host: signalingServer, token: localId });
    connected = true;
    connectedSession = {
      localId,
      remoteId,
      signalingServer,
      sessionKey,
    };

    if (typeof onConnected === 'function') {
      await onConnected({
        localId,
        remoteId,
        signalingServer,
        rtcConfiguration,
        allowedRemoteIds: getAllowedRemoteIds(),
      });
    }

    return p2p;
  }

  async function ensureConnected() {
    if (p2p && connected && sessionMatches(connectedSession, readDesiredSession(), getAllowedRemoteIds())) {
      return p2p;
    }

    if (p2p && connected && typeof onReconnectNeeded === 'function') {
      onReconnectNeeded({
        connectedSession,
        desired: readDesiredSession(),
        allowedRemoteIds: getAllowedRemoteIds(),
      });
    }

    return connect();
  }

  async function sendMessage(targetPeerId, message, { label = 'peer message', retry = false } = {}) {
    const targetId = asTrimmedString(targetPeerId);
    if (!targetId) {
      throw new Error(`Cannot send ${label}: missing target peer id.`);
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    const messageType = resolveMessageType(message);

    await ensureConnected();

    if (isDirectSignalingType(messageType)) {
      if (!signaling || typeof signaling.send !== 'function') {
        throw new Error('Cannot send signaling message: signaling channel is unavailable.');
      }
      await signaling.send(targetId, payload);
      return;
    }

    try {
      await p2p.send(targetId, payload);
    } catch (error) {
      const errorMessage = String(error?.message || error || 'Unknown send error');
      console.log('[channel-verify] SEND via DATA channel (p2p) -> FAILED', {
        target: targetId,
        type: messageType || 'unknown',
        error: errorMessage,
        willRetry: retry && /not connected to signaling channel|invalid state/i.test(errorMessage),
      });
      const canRetry = retry && /not connected to signaling channel|invalid state/i.test(errorMessage);
      if (!canRetry) {
        throw error;
      }

      connected = false;
      if (typeof onRetrySend === 'function') {
        onRetrySend({ label, errorMessage });
      }
      await ensureConnected();
      await p2p.send(targetId, payload);
    }
  }

  async function disconnect() {
    if (p2p) {
      p2p.disconnect();
      p2p = null;
    }
    signaling = null;
    signalingOnMessageProxy = null;
    signalingOnMessageInternal = null;
    connected = false;
    connectedSession = null;
  }

  return {
    connect,
    ensureConnected,
    sendMessage,
    disconnect,
    getClient: () => p2p,
    getSignaling: () => signaling,
    getAllowedRemoteIds,
    setAllowedRemoteIds,
    isDirectSignalingType,
    isConnected: () => connected,
    getConnectedSession: () => connectedSession,
  };
}

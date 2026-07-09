export function createDaemonP2PClient({
  windowObject = window,
  getSessionConfig,
  onMessage,
  onConnected,
  onServerDisconnected,
  onReconnectNeeded,
  onRetrySend,
} = {}) {
  let p2p = null;
  let p2pConnected = false;
  let connectedSession = null;

  function asTrimmedString(value) {
    return String(value ?? '').trim();
  }

  function normalizeIceUrlList(value) {
    if (Array.isArray(value)) {
      return value
        .flatMap((entry) => normalizeIceUrlList(entry))
        .filter(Boolean);
    }

    const text = asTrimmedString(value);
    if (!text) {
      return [];
    }

    return text
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function normalizeIceServerEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const urls = normalizeIceUrlList(entry.urls);
    if (!urls.length) {
      return null;
    }

    const normalized = {
      urls: urls.length === 1 ? urls[0] : urls,
    };

    const username = asTrimmedString(entry.username);
    const credential = asTrimmedString(entry.credential);

    if (username) {
      normalized.username = username;
    }
    if (credential) {
      normalized.credential = credential;
    }

    return normalized;
  }

  function buildRtcConfiguration(session) {
    const directIceServers = Array.isArray(session?.rtcIceServers)
      ? session.rtcIceServers
      : Array.isArray(session?.rtcConfiguration?.iceServers)
        ? session.rtcConfiguration.iceServers
        : null;

    const explicitStun = normalizeIceUrlList(session?.stunUrls ?? session?.stuneUrls ?? session?.stunServer ?? session?.stunServers);
    const explicitTurn = normalizeIceUrlList(session?.turnUrls ?? session?.turnServer ?? session?.turnServers);
    const turnUsername = asTrimmedString(session?.turnUsername ?? session?.turnUser);
    const turnCredential = asTrimmedString(session?.turnCredential ?? session?.turnPassword);

    let iceServers = [];

    if (explicitStun.length || explicitTurn.length) {
      if (explicitStun.length) {
        iceServers.push({
          urls: explicitStun.length === 1 ? explicitStun[0] : explicitStun,
        });
      }
      if (explicitTurn.length) {
        const turnServer = {
          urls: explicitTurn.length === 1 ? explicitTurn[0] : explicitTurn,
        };
        if (turnUsername) {
          turnServer.username = turnUsername;
        }
        if (turnCredential) {
          turnServer.credential = turnCredential;
        }
        iceServers.push(turnServer);
      }
    } else if (directIceServers?.length) {
      iceServers = directIceServers;
    }

    const normalizedIceServers = iceServers
      .map((entry) => normalizeIceServerEntry(entry))
      .filter(Boolean);

    return normalizedIceServers.length ? { iceServers: normalizedIceServers } : {};
  }

  function summarizeIceConfigForLog(rtcConfiguration) {
    const iceServers = Array.isArray(rtcConfiguration?.iceServers) ? rtcConfiguration.iceServers : [];
    const stunUrls = iceServers
      .flatMap((entry) => normalizeIceUrlList(entry?.urls))
      .filter((url) => /^stuns?:/i.test(url));
    const turnUrls = iceServers
      .flatMap((entry) => normalizeIceUrlList(entry?.urls))
      .filter((url) => /^turns?:/i.test(url));
    const turnServer = iceServers.find((entry) =>
      normalizeIceUrlList(entry?.urls).some((url) => /^turns?:/i.test(url))
    );

    return {
      stunUrls,
      turnUrls,
      turnUsername: asTrimmedString(turnServer?.username),
      hasTurnCredential: Boolean(asTrimmedString(turnServer?.credential)),
      iceServerCount: iceServers.length,
    };
  }

  function getDesiredSession() {
    const session = typeof getSessionConfig === 'function' ? getSessionConfig() : {};
    const rtcConfiguration = buildRtcConfiguration(session);
    const iceFingerprint = JSON.stringify(rtcConfiguration.iceServers || []);
    return {
      daemonId: String(session.daemonId || '').trim(),
      clientId: String(session.clientId || '').trim(),
      signalingServer: String(session.signalingServer || '').trim(),
      rtcConfiguration,
      iceFingerprint,
    };
  }

  function getAllowedRemoteIds() {
    return Array.isArray(p2p?.allowedRemoteIds) ? [...p2p.allowedRemoteIds] : [];
  }

  function isConnectedSessionCurrent() {
    if (!p2p || !p2pConnected || !connectedSession) {
      return false;
    }

    const desired = getDesiredSession();
    if (
      connectedSession.daemonId !== desired.daemonId ||
      connectedSession.clientId !== desired.clientId ||
      connectedSession.signalingServer !== desired.signalingServer ||
      connectedSession.iceFingerprint !== desired.iceFingerprint
    ) {
      return false;
    }

    const allowedRemote = String(getAllowedRemoteIds()[0] || '').trim();
    return allowedRemote === desired.clientId;
  }

  async function connect() {
    const desired = getDesiredSession();
    const { daemonId, clientId, signalingServer, rtcConfiguration, iceFingerprint } = desired;

    if (!daemonId) {
      throw new Error('Daemon ID is required.');
    }
    if (!clientId) {
      throw new Error('Client ID is required.');
    }
    if (!signalingServer) {
      throw new Error('Signaling host is required.');
    }

    if (p2p) {
      p2p.disconnect();
      p2p = null;
    }
    p2pConnected = false;

    const signaling = new windowObject.SignalingChannel();
    console.log('[daemon-agent] create p2p client config', {
      signalingServer,
      daemonId,
      clientId,
      ...summarizeIceConfigForLog(rtcConfiguration),
    });
    p2p = new Owt.P2P.P2PClient({ rtcConfiguration }, signaling);
    p2p.allowedRemoteIds = [clientId];

    p2p.addEventListener('serverdisconnected', () => {
      p2pConnected = false;
      connectedSession = null;
      if (typeof onServerDisconnected === 'function') {
        onServerDisconnected({ daemonId, clientId, signalingServer });
      }
    });

    p2p.addEventListener('messagereceived', async (event) => {
      if (typeof onMessage === 'function') {
        await onMessage(event);
      }
    });

    await p2p.connect({ host: signalingServer, token: daemonId });
    p2pConnected = true;
    connectedSession = {
      daemonId,
      clientId,
      signalingServer,
      iceFingerprint,
    };

    if (typeof onConnected === 'function') {
      await onConnected({
        daemonId,
        clientId,
        signalingServer,
        rtcConfiguration,
        allowedRemoteIds: getAllowedRemoteIds(),
      });
    }

    return p2p;
  }

  async function ensureConnected() {
    if (isConnectedSessionCurrent()) {
      return p2p;
    }

    if (p2p && p2pConnected && typeof onReconnectNeeded === 'function') {
      onReconnectNeeded({
        connectedSession,
        desired: getDesiredSession(),
        allowedRemoteIds: getAllowedRemoteIds(),
      });
    }

    return connect();
  }

  async function sendPeerMessage(targetPeerId, message, { label = 'peer message', retry = true } = {}) {
    const targetId = String(targetPeerId || '').trim();
    if (!targetId) {
      throw new Error(`Cannot send ${label}: missing target peer id.`);
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);

    try {
      await ensureConnected();
      await p2p.send(targetId, payload);
    } catch (error) {
      const errorMessage = String(error?.message || error || 'Unknown send error');
      const canRetry = retry && /not connected to signaling channel|invalid state/i.test(errorMessage);
      if (!canRetry) {
        throw error;
      }

      p2pConnected = false;
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
    p2pConnected = false;
    connectedSession = null;
  }

  return {
    connect,
    ensureConnected,
    sendPeerMessage,
    disconnect,
    getClient: () => p2p,
    getAllowedRemoteIds,
    isConnected: () => p2pConnected,
    getConnectedSession: () => connectedSession,
  };
}

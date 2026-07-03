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

  function getDesiredSession() {
    const session = typeof getSessionConfig === 'function' ? getSessionConfig() : {};
    return {
      daemonId: String(session.daemonId || '').trim(),
      clientId: String(session.clientId || '').trim(),
      signalingServer: String(session.signalingServer || '').trim(),
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
      connectedSession.signalingServer !== desired.signalingServer
    ) {
      return false;
    }

    const allowedRemote = String(getAllowedRemoteIds()[0] || '').trim();
    return allowedRemote === desired.clientId;
  }

  async function connect() {
    const desired = getDesiredSession();
    const { daemonId, clientId, signalingServer } = desired;

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
    p2p = new Owt.P2P.P2PClient({ rtcConfiguration: {} }, signaling);
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
    };

    if (typeof onConnected === 'function') {
      await onConnected({
        daemonId,
        clientId,
        signalingServer,
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

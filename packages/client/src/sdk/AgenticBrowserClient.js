import { normalizeRtcIceOptions } from './rtcConfig.js';
import {
  createOwtP2PTransport,
  DIRECT_SIGNALING_TYPES,
  resolveMessageType,
} from './owtP2PTransportCore.js';

export class AgenticBrowserClient {
  constructor() {
    this.clientId = null;
    this.daemonId = null;
    this.onRemoteStream = null;
    this.onMessage = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onDisconnect = null;
    this.onSignalingConnected = null;
    this.onReconnectAttempt = null;
    this.onRetrySend = null;
    this._requestSeq = 0;
    this._connectOptions = null;
    this._connectPromise = null;
    this._peerConnected = false;
    this._rtcConfiguration = {};

    this.transport = createOwtP2PTransport({
      windowObject: window,
      directSignalingTypes: DIRECT_SIGNALING_TYPES,
      getDesiredSession: () => ({
        localId: String(this.clientId || '').trim(),
        remoteId: String(this.daemonId || '').trim(),
        signalingServer: String(this._connectOptions?.signalingHost || '').trim(),
        rtcConfiguration: this._rtcConfiguration,
        sessionKey: JSON.stringify(this._rtcConfiguration?.iceServers || []),
      }),
      onMessage: async ({ origin, message }) => {
        this._emitPeerConnected({
          reason: 'message-received',
          remoteId: String(origin || '').trim(),
        });
        if (this.onMessage) {
          this.onMessage({ origin: String(origin || '').trim(), message });
        }
      },
      onConnected: async () => {},
      onServerDisconnected: () => {
        this._emitPeerDisconnected({ reason: 'server-disconnected' });
        this._connectPromise = null;
        if (this.onDisconnect) {
          this.onDisconnect();
        }
      },
      onReconnectNeeded: ({ connectedSession, desired, allowedRemoteIds }) => {
        if (this.onReconnectAttempt) {
          this.onReconnectAttempt({
            daemonId: desired?.remoteId || this.daemonId,
            connectedSession,
            desired,
            allowedRemoteIds,
            error: 'stale signaling session detected',
          });
        }
      },
      onRetrySend: ({ label, errorMessage }) => {
        if (this.onRetrySend) {
          this.onRetrySend({ label, errorMessage });
        }
      },
      onSignalingConnected: (details) => {
        if (this.onSignalingConnected) {
          this.onSignalingConnected(details);
        }
      },
      onP2PClientCreated: ({ p2p }) => {
        p2p.addEventListener('streamadded', async (event) => {
          const originalStream = event.stream;
          let remoteStream = originalStream;

          console.debug('[client-sdk] streamadded received', {
            daemonId: this.daemonId,
            hasStream: Boolean(originalStream),
            streamId: originalStream?.id || originalStream?.mediaStream?.id || null,
            hasMediaStream: Boolean(originalStream?.mediaStream),
          });

          try {
            if (typeof p2p.subscribe === 'function') {
              const subscription = await p2p.subscribe(event.stream);
              if (subscription?.stream?.mediaStream) {
                remoteStream = subscription.stream;
              }
            }
          } catch (error) {
            console.error('[client-sdk] Failed to subscribe remote stream:', error);
            remoteStream = originalStream;
          }

          this._emitPeerConnected({
            reason: 'stream-added',
            streamId: remoteStream?.id || remoteStream?.mediaStream?.id || null,
          });

          if (this.onRemoteStream) {
            this.onRemoteStream(remoteStream);
          }
        });
      },
    });
  }

  get p2p() {
    return this.transport.getClient();
  }

  get signaling() {
    return this.transport.getSignaling();
  }

  _emitPeerConnected(details = {}) {
    if (this._peerConnected) {
      return;
    }
    this._peerConnected = true;
    if (this.onPeerConnected) {
      this.onPeerConnected({
        daemonId: this.daemonId,
        ...details,
      });
    }
  }

  _emitPeerDisconnected(details = {}) {
    if (!this._peerConnected) {
      return;
    }
    this._peerConnected = false;
    if (this.onPeerDisconnected) {
      this.onPeerDisconnected({
        daemonId: this.daemonId,
        ...details,
      });
    }
  }

  async connect({ signalingHost, clientId, daemonId, forceReconnect = false, ...rtcInput }) {
    const rtcOptions = normalizeRtcIceOptions(rtcInput);
    const nextOptions = {
      signalingHost: String(signalingHost || '').trim(),
      clientId: String(clientId || '').trim(),
      daemonId: String(daemonId || '').trim(),
      forceReconnect: Boolean(forceReconnect),
      ...rtcOptions,
    };

    this._connectOptions = nextOptions;
    this.clientId = nextOptions.clientId;
    this.daemonId = nextOptions.daemonId;
    this._rtcConfiguration = nextOptions.rtcConfiguration || {};

    if (this._connectPromise) {
      return this._connectPromise;
    }

    if (nextOptions.forceReconnect) {
      await this.disconnect();
    }

    this._connectPromise = (async () => {
      const p2p = await this.transport.connect();
      p2p.allowedRemoteIds = this.daemonId ? [this.daemonId] : [];

      console.debug('[client-sdk] connecting', {
        clientId: this.clientId,
        daemonId: this.daemonId,
        signalingHost: nextOptions.signalingHost,
        rtcConfiguration: nextOptions.rtcConfiguration,
        allowedRemoteIds: p2p.allowedRemoteIds,
      });

      return this.clientId;
    })();

    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  setDaemonId(daemonId) {
    const nextDaemonId = String(daemonId || '').trim();
    this.daemonId = nextDaemonId;
    this.transport.setAllowedRemoteIds(nextDaemonId ? [nextDaemonId] : []);
  }

  async disconnect() {
    this._emitPeerDisconnected({ reason: 'manual-disconnect' });
    await this.transport.disconnect();
    this._connectPromise = null;
  }

  async ensureConnected() {
    if (this.transport.isConnected()) {
      return this.clientId;
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    if (!this._connectOptions) {
      throw new Error('Not connected.');
    }

    return this.connect(this._connectOptions);
  }

  async reconnect() {
    if (!this._connectOptions) {
      throw new Error('Not connected.');
    }

    return this.connect({
      ...this._connectOptions,
      forceReconnect: true,
    });
  }

  async sendCommand(type, payload = {}) {
    const requestId = `cmd-${Date.now()}-${++this._requestSeq}`;
    const command = { type, payload, requestId };
    await this.sendMessage(command);
    return requestId;
  }

  async sendMessage(message, targetId) {
    const resolvedTarget = String(targetId || this.daemonId || '').trim();
    if (!resolvedTarget) {
      throw new Error('Target daemon id is required before sending messages.');
    }

    let serializedMessage = message;
    if (
      typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message) &&
      message.payload instanceof ArrayBuffer
    ) {
      const binaryData = new Uint8Array(message.payload);
      const base64Data = btoa(String.fromCharCode(...binaryData));
      serializedMessage = {
        ...message,
        payload: base64Data,
        __isBinary: true,
      };
    }

    const parsedType = resolveMessageType(serializedMessage);
    try {
      await this.transport.sendMessage(resolvedTarget, serializedMessage, {
        label: `client message:${parsedType || 'unknown'}`,
        retry: false,
      });
    } catch (error) {
      const messageText = String(error?.message || '');
      if (messageText.includes('not connected to signaling channel')) {
        this._connectPromise = null;
      }
      throw error;
    }
  }

  async sendPeerMessage(targetPeerId, message, { label = 'peer message', retry = true } = {}) {
    return this.transport.sendMessage(targetPeerId, message, { label, retry });
  }

  getClient() {
    return this.transport.getClient();
  }

  getAllowedRemoteIds() {
    return this.transport.getAllowedRemoteIds();
  }

  isConnected() {
    return this.transport.isConnected();
  }

  getConnectedSession() {
    const session = this.transport.getConnectedSession();
    if (!session) {
      return null;
    }
    return {
      daemonId: session.localId,
      clientId: session.remoteId,
      signalingServer: session.signalingServer,
      sessionKey: session.sessionKey,
    };
  }
}

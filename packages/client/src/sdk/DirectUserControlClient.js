import { normalizeRtcIceOptions } from './config/rtcConfig.js';
import { createOwtP2PTransport } from './transport/owtP2PTransport.js';
import { SIGNALING_MESSAGE_TYPES, resolveMessageType } from './transport/signalingMessages.js';
import { encodeMouseCommandString } from './input/mouseCommandCodec.js';

export class DirectUserControlClient {
  // Session identity + caller-supplied event callbacks (the public event API).
  localId = null;
  remoteId = null;
  onRemoteStream = null;
  onMessage = null;
  onPeerConnected = null;
  onPeerDisconnected = null;
  onDisconnect = null;
  onSignalingConnected = null;
  onReconnectAttempt = null;
  onRetrySend = null;

  // Internal connection state.
  #requestSeq = 0;
  #connectOptions = null;
  #connectPromise = null;
  #peerConnected = false;
  #rtcConfiguration = {};

  constructor() {
    this.transport = createOwtP2PTransport(this.#buildTransportOptions());
  }

  // Assemble the callbacks/config wiring passed to the OWT transport. Kept in one
  // place so the constructor stays a thin declaration.
  #buildTransportOptions() {
    return {
      windowObject: window,
      directSignalingTypes: SIGNALING_MESSAGE_TYPES,
      getDesiredSession: () => ({
        localId: String(this.localId || '').trim(),
        remoteId: String(this.remoteId || '').trim(),
        signalingServer: String(this.#connectOptions?.signalingHost || '').trim(),
        rtcConfiguration: this.#rtcConfiguration,
        sessionKey: JSON.stringify(this.#rtcConfiguration?.iceServers || []),
      }),
      onMessage: async ({ origin, message }) => {
        this.#emitPeerConnected({
          reason: 'message-received',
          remoteId: String(origin || '').trim(),
        });
        if (this.onMessage) {
          this.onMessage({ origin: String(origin || '').trim(), message });
        }
      },
      onConnected: async () => {},
      onServerDisconnected: () => {
        this.#emitPeerDisconnected({ reason: 'server-disconnected' });
        this.#connectPromise = null;
        if (this.onDisconnect) {
          this.onDisconnect();
        }
      },
      onReconnectNeeded: ({ connectedSession, desired, allowedRemoteIds }) => {
        if (this.onReconnectAttempt) {
          this.onReconnectAttempt({
            remoteId: desired?.remoteId || this.remoteId,
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
        p2p.addEventListener('streamadded', (event) => this.#handleStreamAdded(p2p, event));
      },
    };
  }

  // Subscribe to a newly-added remote stream and forward it to onRemoteStream.
  async #handleStreamAdded(p2p, event) {
    const originalStream = event.stream;
    let remoteStream = originalStream;

    console.debug('[client-sdk] streamadded received', {
      remoteId: this.remoteId,
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

    this.#emitPeerConnected({
      reason: 'stream-added',
      streamId: remoteStream?.id || remoteStream?.mediaStream?.id || null,
    });

    if (this.onRemoteStream) {
      this.onRemoteStream(remoteStream);
    }
  }

  get p2p() {
    return this.transport.getClient();
  }

  get signaling() {
    return this.transport.getSignaling();
  }

  #emitPeerConnected(details = {}) {
    if (this.#peerConnected) {
      return;
    }
    this.#peerConnected = true;
    if (this.onPeerConnected) {
      this.onPeerConnected({
        remoteId: this.remoteId,
        ...details,
      });
    }
  }

  #emitPeerDisconnected(details = {}) {
    if (!this.#peerConnected) {
      return;
    }
    this.#peerConnected = false;
    if (this.onPeerDisconnected) {
      this.onPeerDisconnected({
        remoteId: this.remoteId,
        ...details,
      });
    }
  }

  async connect({ signalingHost, localId, remoteId, forceReconnect = false, ...rtcInput }) {
    const rtcOptions = normalizeRtcIceOptions(rtcInput);
    const nextOptions = {
      signalingHost: String(signalingHost || '').trim(),
      localId: String(localId || '').trim(),
      remoteId: String(remoteId || '').trim(),
      forceReconnect: Boolean(forceReconnect),
      ...rtcOptions,
    };

    this.#connectOptions = nextOptions;
    this.localId = nextOptions.localId;
    this.remoteId = nextOptions.remoteId;
    this.#rtcConfiguration = nextOptions.rtcConfiguration || {};

    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    if (nextOptions.forceReconnect) {
      await this.disconnect();
    }

    this.#connectPromise = (async () => {
      const p2p = await this.transport.connect();
      p2p.allowedRemoteIds = this.remoteId ? [this.remoteId] : [];

      return this.localId;
    })();

    try {
      return await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  setDaemonId(remoteId) {
    const nextDaemonId = String(remoteId || '').trim();
    this.remoteId = nextDaemonId;
    this.transport.setAllowedRemoteIds(nextDaemonId ? [nextDaemonId] : []);
  }

  async disconnect() {
    this.#emitPeerDisconnected({ reason: 'manual-disconnect' });
    await this.transport.disconnect();
    this.#connectPromise = null;
  }

  async ensureConnected() {
    if (this.transport.isConnected()) {
      return this.localId;
    }

    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    if (!this.#connectOptions) {
      throw new Error('Not connected.');
    }

    return this.connect(this.#connectOptions);
  }

  async reconnect() {
    if (!this.#connectOptions) {
      throw new Error('Not connected.');
    }

    return this.connect({
      ...this.#connectOptions,
      forceReconnect: true,
    });
  }

  async sendCommand(type, payload = {}) {
    const reqId = `cmd-${++this.#requestSeq}`;
    const command = { type, payload, reqId };
    await this.sendMessage(command);
    return reqId;
  }

  // Wrap an outgoing message for transport. ArrayBuffer payloads (binary mouse
  // commands) are sent as a compact bare string -- PREFIX + base64 -- instead of
  // a JSON envelope: the command type is already encoded in byte 0 and these
  // commands are fire-and-forget, so type/payload/reqId keys are pure
  // overhead. This drops our ~70-byte wrapper and avoids OWT double-escaping the
  // nested JSON quotes when it wraps the message in its own {id,data} envelope.
  #serializeOutgoingMessage(message) {
    const isBinaryPayload =
      typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message) &&
      message.payload instanceof ArrayBuffer;

    if (!isBinaryPayload) {
      return message;
    }

    return encodeMouseCommandString(message.payload);
  }

  async sendMessage(message, targetId) {
    const resolvedTarget = String(targetId || this.remoteId || '').trim();
    if (!resolvedTarget) {
      throw new Error('Target daemon id is required before sending messages.');
    }

    const serializedMessage = this.#serializeOutgoingMessage(message);
    const parsedType = resolveMessageType(serializedMessage);
    try {
      await this.transport.sendMessage(resolvedTarget, serializedMessage, {
        label: `client message:${parsedType || 'unknown'}`,
        retry: false,
      });
    } catch (error) {
      const messageText = String(error?.message || '');
      if (messageText.includes('not connected to signaling channel')) {
        this.#connectPromise = null;
      }
      throw error;
    }
  }

  async sendPeerMessage(targetPeerId, message, { label = 'peer message', retry = true } = {}) {
    return this.transport.sendMessage(targetPeerId, message, { label, retry });
  }

  async publishStream(targetId, stream) {
    const p2p = this.transport.getClient();
    const publishTargetId = String(targetId || this.remoteId || '').trim();
    if (!publishTargetId) {
      throw new Error('Target daemon id is required before publishing stream.');
    }
    await p2p.publish(publishTargetId, stream);
  }

  stop(targetId) {
    const p2p = this.transport.getClient();
    if (p2p && typeof p2p.stop === 'function' && targetId) {
      try {
        p2p.stop(targetId);
        return `reset stale P2P connection to ${targetId}.`;
      } catch (error) {
        return `failed to reset P2P connection: ${error?.message || error}`;
      }
    }
    return `no P2P connection to reset for ${targetId}.`;
  }

  hasClient() {
    return !!this.transport.getClient();
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
      remoteId: session.localId,
      localId: session.remoteId,
      signalingServer: session.signalingServer,
      sessionKey: session.sessionKey,
    };
  }
}

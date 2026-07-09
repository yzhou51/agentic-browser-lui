import { normalizeRtcIceOptions } from './rtcConfig.js';

export class AgenticBrowserClient {
  constructor() {
    this.signaling = new window.SignalingChannel();
    this.p2p = null;
    this.clientId = null;
    this.daemonId = null;
    this.onRemoteStream = null;
    this.onMessage = null;
    this.onDataChannelOpen = null;
    this.onDisconnect = null;
    this._requestSeq = 0;
    this._connectOptions = null;
    this._connectPromise = null;
    this._isConnected = false;
    this.onReconnectAttempt = null;
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

    if (this._connectPromise) {
      return this._connectPromise;
    }

    if (nextOptions.forceReconnect) {
      await this.disconnect();
    }

    if (this.p2p && this._isConnected) {
      return this.clientId;
    }

    const host = nextOptions.signalingHost;

    if (this.p2p) {
      try {
        this.p2p.disconnect();
      } catch {
        // Ignore cleanup errors and recreate the client instance.
      }
      this.p2p = null;
    }

    this.p2p = new Owt.P2P.P2PClient({ rtcConfiguration: nextOptions.rtcConfiguration }, this.signaling);
    if (this.daemonId) {
      this.p2p.allowedRemoteIds = [this.daemonId];
    }

    const originalDataChannelOpen = this.p2p._onDataChannelOpen?.bind(this.p2p);
    if (originalDataChannelOpen) {
      this.p2p._onDataChannelOpen = (event) => {
        originalDataChannelOpen(event);
        if (this.onDataChannelOpen) {
          this.onDataChannelOpen({
            label: event?.target?.label || null,
            readyState: event?.target?.readyState || null,
            event,
          });
        }
      };
    }

    console.debug('[client-sdk] connecting', {
      clientId: this.clientId,
      daemonId: this.daemonId,
      signalingHost: host,
      rtcConfiguration: nextOptions.rtcConfiguration,
      allowedRemoteIds: this.p2p.allowedRemoteIds,
    });

    this.p2p.addEventListener('streamadded', async (event) => {
      const originalStream = event.stream;
      let remoteStream = originalStream;

      console.debug('[client-sdk] streamadded received', {
        daemonId: this.daemonId,
        hasStream: Boolean(originalStream),
        streamId: originalStream?.id || originalStream?.mediaStream?.id || null,
        hasMediaStream: Boolean(originalStream?.mediaStream),
      });

      try {
        if (typeof this.p2p.subscribe === 'function') {
          const subscription = await this.p2p.subscribe(event.stream);
          if (subscription?.stream) {
            remoteStream = subscription.stream;
          }
        }
      } catch (error) {
        console.error('[client-sdk] Failed to subscribe remote stream:', error);
        remoteStream = originalStream;
      }

      if (this.onRemoteStream) {
        this.onRemoteStream(remoteStream);
      }
    });

    this.p2p.addEventListener('messagereceived', (event) => {
      if (this.onMessage) {
        this.onMessage({ origin: event.origin, message: event.message });
      }
    });

    this.p2p.addEventListener('serverdisconnected', () => {
      this._isConnected = false;
      this.p2p = null;
      this._connectPromise = null;
      if (this.onDisconnect) {
        this.onDisconnect();
      }
    });

    this._connectPromise = (async () => {
      await this.p2p.connect({ host, token: this.clientId });
      this._isConnected = true;
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
    if (this.p2p && nextDaemonId) {
      this.p2p.allowedRemoteIds = [nextDaemonId];
    }
  }

  async disconnect() {
    if (this.p2p) {
      this.p2p.disconnect();
      this.p2p = null;
    }
    this._isConnected = false;
    this._connectPromise = null;
  }

  async ensureConnected() {
    if (this.p2p && this._isConnected) {
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

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    console.debug('[client-sdk] sending command', {
      target: resolvedTarget,
      message,
    });
    console.info('[client-sdk] sending owt message', {
      target: resolvedTarget,
      payload,
    });
    try {
      await this.p2p.send(resolvedTarget, payload);
    } catch (error) {
      const messageText = String(error?.message || '');
      if (messageText.includes('not connected to signaling channel')) {
        this._isConnected = false;
        if (this.onReconnectAttempt) {
          this.onReconnectAttempt({
            daemonId: resolvedTarget,
            error: messageText,
          });
        }
        await this.ensureConnected();
        await this.p2p.send(resolvedTarget, payload);
        return;
      }
      throw error;
    }
  }
}

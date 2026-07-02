export class AgenticBrowserClient {
  constructor() {
    this.signaling = new window.SignalingChannel();
    this.p2p = null;
    this.clientId = null;
    this.daemonId = null;
    this.onRemoteStream = null;
    this.onMessage = null;
    this.onDisconnect = null;
    this._requestSeq = 0;
    this._connectOptions = null;
    this._connectPromise = null;
    this._isConnected = false;
    this.onReconnectAttempt = null;
  }

  async connect({ signalingHost, clientId, daemonId, forceReconnect = false }) {
    const nextOptions = {
      signalingHost: String(signalingHost || '').trim(),
      clientId: String(clientId || '').trim(),
      daemonId: String(daemonId || '').trim(),
      forceReconnect: Boolean(forceReconnect),
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

    this.p2p = new Owt.P2P.P2PClient({ rtcConfiguration: {} }, this.signaling);
    if (this.daemonId) {
      this.p2p.allowedRemoteIds = [this.daemonId];
    }

    console.debug('[client-sdk] connecting', {
      clientId: this.clientId,
      daemonId: this.daemonId,
      signalingHost: host,
      allowedRemoteIds: this.p2p.allowedRemoteIds,
    });

    this.p2p.addEventListener('streamadded', async (event) => {
      try {
        let remoteStream = event.stream;

        if (typeof this.p2p.subscribe === 'function') {
          const subscription = await this.p2p.subscribe(event.stream);
          if (subscription?.stream) {
            remoteStream = subscription.stream;
          }
        }

        if (this.onRemoteStream) {
          this.onRemoteStream(remoteStream);
        }
      } catch (error) {
        console.error('[client-sdk] Failed to subscribe remote stream:', error);
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
    await this.ensureConnected();

    const resolvedTarget = String(targetId || this.daemonId || '').trim();
    if (!resolvedTarget) {
      throw new Error('Target daemon id is required before sending messages.');
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    console.debug('[client-sdk] sending command', {
      target: resolvedTarget,
      message,
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

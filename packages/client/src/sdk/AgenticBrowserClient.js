export class AgenticBrowserClient {
  constructor() {
    this.signaling = new window.SignalingChannel();
    this.p2p = null;
    this.clientId = null;
    this.daemonId = null;
    this.onRemoteStream = null;
    this.onMessage = null;
    this._requestSeq = 0;
  }

  async connect({ signalingHost, clientId, daemonId }) {
    this.clientId = String(clientId || '').trim();
    this.daemonId = String(daemonId || '').trim();
    const host = String(signalingHost || '').trim();

    this.p2p = new Owt.P2P.P2PClient({ rtcConfiguration: {} }, this.signaling);
    this.p2p.allowedRemoteIds = [this.daemonId];

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

    await this.p2p.connect({ host, token: this.clientId });
  }

  async disconnect() {
    if (this.p2p) {
      this.p2p.disconnect();
      this.p2p = null;
    }
  }

  async sendCommand(type, payload = {}) {
    if (!this.p2p) {
      throw new Error('Not connected.');
    }
    const requestId = `cmd-${Date.now()}-${++this._requestSeq}`;
    const command = JSON.stringify({ type, payload, requestId });
    console.debug('[client-sdk] sending command', {
      target: this.daemonId,
      type,
      requestId,
      payload,
    });
    await this.p2p.send(this.daemonId, command);
    return requestId;
  }
}
